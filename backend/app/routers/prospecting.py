"""CRM de prospeccao ativa.

Fluxo: escolhe um ponto e um raio -> o Apify varre o Google Maps -> os lugares
entram como prospects com telefone normalizado -> voce dispara a abordagem no
WhatsApp -> quem responde vira Contact e cai no fluxo de conversao que ja existia.

A sincronizacao do run do Apify e preguicosa: as rotas de listagem e de detalhe
conferem no Apify qualquer busca que ainda esteja rodando e importam sozinhas
quando termina. Sem worker separado, sem estado orfao se o processo reiniciar.
"""

import asyncio
import csv
import io
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import phones, settings_store
from app.db import SessionLocal, get_session
from app.models import STAGES, Outreach, Prospect, ProspectSearch
from app.services import apify, geo, whatsapp_cloud

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prospect", tags=["prospect"])

# margem no filtro de raio: o Google raciocina por viewport, entao um lugar a
# 5,2 km numa busca de 5 km e resultado legitimo, nao erro de area.
RADIUS_SLACK = 1.10


# ---------------------------------------------------------------------------
# serializacao
# ---------------------------------------------------------------------------


def serialize_search(s: ProspectSearch) -> dict:
    return {
        "id": s.id,
        "label": s.label,
        "terms": s.terms or [],
        "center": {"lat": s.center_lat, "lng": s.center_lng},
        "radius_km": s.radius_km,
        "location_label": s.location_label,
        "max_per_term": s.max_per_term,
        "actor": s.actor,
        "apify_run_id": s.apify_run_id,
        "dataset_id": s.dataset_id,
        "status": s.status,
        "imported": s.imported,
        "error": s.error,
        "items_found": s.items_found,
        "prospects_new": s.prospects_new,
        "prospects_dupe": s.prospects_dupe,
        "prospects_skipped": s.prospects_skipped,
        "cost_usd": s.cost_usd,
        "apify_input": s.apify_input,
        "created_at": s.created_at,
        "finished_at": s.finished_at,
        "run_url": (
            f"https://console.apify.com/actors/runs/{s.apify_run_id}" if s.apify_run_id else None
        ),
    }


def serialize_outreach(o: Outreach) -> dict:
    return {
        "id": o.id,
        "prospect_id": o.prospect_id,
        "kind": o.kind,
        "template_name": o.template_name,
        "template_language": o.template_language,
        "body_preview": o.body_preview,
        "to_phone": o.to_phone,
        "wamid": o.wamid,
        "status": o.status,
        "http_status": o.http_status,
        "request_payload": o.request_payload,
        "response_body": o.response_body,
        "error": o.error,
        "created_at": o.created_at,
        "sent_at": o.sent_at,
    }


def serialize_prospect(p: Prospect, outreaches: bool = False) -> dict:
    out = {
        "id": p.id,
        "search_id": p.search_id,
        "place_id": p.place_id,
        "name": p.name,
        "category": p.category,
        "address": p.address,
        "city": p.city,
        "state": p.state,
        "phone_e164": p.phone_e164,
        "phone_raw": p.phone_raw,
        "phone_kind": p.phone_kind,
        "website": p.website,
        "email": p.email,
        "rating": p.rating,
        "reviews_count": p.reviews_count,
        "lat": p.lat,
        "lng": p.lng,
        "distance_km": p.distance_km,
        "maps_url": p.maps_url,
        "stage": p.stage,
        "note": p.note,
        "contact_id": p.contact_id,
        "last_outreach_at": p.last_outreach_at,
        "replied_at": p.replied_at,
        "created_at": p.created_at,
    }
    if outreaches:
        out["outreaches"] = [serialize_outreach(o) for o in (p.outreaches or [])]
        out["raw"] = p.raw
    return out


# ---------------------------------------------------------------------------
# geocode
# ---------------------------------------------------------------------------


@router.get("/geocode")
async def geocode_address(q: str = Query(min_length=2)):
    """Endereco/bairro/cidade -> candidatos de coordenada, pra fixar o centro do raio."""
    try:
        return {"results": await geo.geocode(q)}
    except geo.GeoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/account")
async def apify_account(session: AsyncSession = Depends(get_session)):
    """Status do Apify — token valido e credito do plano."""
    cfg = await settings_store.load(session)
    if not cfg.get("apify_token"):
        return {"configured": False, "ok": False, "error": "Token do Apify nao configurado."}
    try:
        return {"configured": True, "ok": True, **(await apify.account_info(cfg))}
    except apify.ApifyError as exc:
        return {"configured": True, "ok": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# varreduras
# ---------------------------------------------------------------------------


class SearchIn(BaseModel):
    terms: list[str] = Field(min_length=1)
    lat: float
    lng: float
    radius_km: float = Field(default=5, gt=0, le=50)
    location_label: str | None = None
    max_per_term: int = Field(default=60, ge=1, le=500)
    label: str | None = None
    skip_closed: bool = True
    min_stars: str = ""
    website: str = "allPlaces"
    scrape_contacts: bool = False


@router.post("/searches", status_code=201)
async def create_search(payload: SearchIn, session: AsyncSession = Depends(get_session)):
    """Cria a varredura e dispara o actor. Volta na hora, com status `running`."""
    cfg = await settings_store.load(session)
    terms = [t.strip() for t in payload.terms if t and t.strip()]
    if not terms:
        raise HTTPException(status_code=400, detail="Informe pelo menos um termo de busca.")

    run_input = apify.build_input(
        terms=terms,
        lat=payload.lat,
        lng=payload.lng,
        radius_km=payload.radius_km,
        max_per_term=payload.max_per_term,
        language=cfg.get("prospect_language") or "pt-BR",
        skip_closed=payload.skip_closed,
        min_stars=payload.min_stars,
        website=payload.website,
        scrape_contacts=payload.scrape_contacts,
    )

    label = payload.label or (
        f"{', '.join(terms)} · {payload.radius_km:g} km"
        + (f" · {payload.location_label}" if payload.location_label else "")
    )

    search = ProspectSearch(
        label=label[:240],
        terms=terms,
        center_lat=payload.lat,
        center_lng=payload.lng,
        radius_km=payload.radius_km,
        location_label=payload.location_label,
        max_per_term=payload.max_per_term,
        actor=cfg.get("apify_actor") or apify.DEFAULT_ACTOR,
        apify_input=run_input,
    )
    session.add(search)
    await session.flush()

    try:
        started = await apify.start_run(cfg, search.actor, run_input)
    except apify.ApifyError as exc:
        search.status = "failed"
        search.error = str(exc)
        search.finished_at = datetime.now(timezone.utc)
        await session.commit()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    search.apify_run_id = started["run_id"]
    search.dataset_id = started["dataset_id"]
    search.status = "running"
    await session.commit()
    await session.refresh(search)
    return serialize_search(search)


async def _sync_search(session: AsyncSession, cfg: dict, search: ProspectSearch) -> ProspectSearch:
    """Confere o run no Apify e, se acabou bem, importa os lugares como prospects."""
    if search.status not in ("queued", "running") or not search.apify_run_id:
        return search

    try:
        info = await apify.run_status(cfg, search.apify_run_id)
    except apify.ApifyError as exc:
        log.warning("sync da busca %s falhou: %s", search.id, exc)
        return search

    status = info.get("status") or ""
    if status not in apify.TERMINAL:
        search.status = "running"
        await session.commit()
        return search

    search.cost_usd = info.get("cost_usd")
    search.dataset_id = search.dataset_id or info.get("dataset_id")
    search.finished_at = datetime.now(timezone.utc)

    if status != "SUCCEEDED":
        search.status = "failed"
        search.error = info.get("message") or f"Run do Apify terminou como {status}."
        await session.commit()
        return search

    search.status = "succeeded"
    await session.commit()
    await _import_results(session, cfg, search)
    return search


async def _import_results(session: AsyncSession, cfg: dict, search: ProspectSearch) -> ProspectSearch:
    """Dataset -> prospects. Dedupe por place_id e por telefone canonico."""
    if search.imported or not search.dataset_id:
        return search

    try:
        items = await apify.dataset_items(cfg, search.dataset_id)
    except apify.ApifyError as exc:
        search.error = str(exc)
        await session.commit()
        return search

    center = (search.center_lat, search.center_lng)
    limit_km = search.radius_km * RADIUS_SLACK

    # o que ja existe no CRM — o dedupe atravessa varreduras diferentes
    existing_places = set(
        (await session.execute(select(Prospect.place_id).where(Prospect.place_id.is_not(None))))
        .scalars()
        .all()
    )
    existing_keys = {
        key
        for key in (
            phones.match_key(p)
            for p in (
                await session.execute(select(Prospect.phone_e164).where(Prospect.phone_e164.is_not(None)))
            )
            .scalars()
            .all()
        )
        if key
    }

    new_count = dupe = skipped = 0

    for item in items:
        fields = apify.normalize_place(item, center)
        closed = fields.pop("permanently_closed", False)

        if closed:
            skipped += 1
            continue
        if fields["distance_km"] is not None and fields["distance_km"] > limit_km:
            skipped += 1  # o Google devolveu algo fora do raio pedido
            continue

        place_id = fields.get("place_id")
        if place_id and place_id in existing_places:
            dupe += 1
            continue

        key = phones.match_key(fields.get("phone_e164"))
        if key and key in existing_keys:
            dupe += 1
            continue

        session.add(Prospect(search_id=search.id, raw=item, **fields))
        if place_id:
            existing_places.add(place_id)
        if key:
            existing_keys.add(key)
        new_count += 1

    search.items_found = len(items)
    search.prospects_new = new_count
    search.prospects_dupe = dupe
    search.prospects_skipped = skipped
    search.imported = True
    await session.commit()
    await session.refresh(search)
    return search


@router.get("/searches")
async def list_searches(
    limit: int = Query(default=50, le=200), session: AsyncSession = Depends(get_session)
):
    cfg = await settings_store.load(session)
    rows = (
        (await session.execute(select(ProspectSearch).order_by(desc(ProspectSearch.id)).limit(limit)))
        .scalars()
        .all()
    )
    for row in rows:
        if row.status in ("queued", "running"):
            await _sync_search(session, cfg, row)
    return [serialize_search(r) for r in rows]


@router.get("/searches/{search_id}")
async def get_search(search_id: int, session: AsyncSession = Depends(get_session)):
    search = await session.get(ProspectSearch, search_id)
    if search is None:
        raise HTTPException(status_code=404, detail="Varredura nao encontrada.")
    cfg = await settings_store.load(session)
    await _sync_search(session, cfg, search)
    return serialize_search(search)


@router.post("/searches/{search_id}/sync")
async def sync_search(search_id: int, session: AsyncSession = Depends(get_session)):
    """Forca a conferencia do run e a importacao — util se a busca ficou pendurada."""
    search = await session.get(ProspectSearch, search_id)
    if search is None:
        raise HTTPException(status_code=404, detail="Varredura nao encontrada.")
    cfg = await settings_store.load(session)
    await _sync_search(session, cfg, search)
    if search.status == "succeeded" and not search.imported:
        await _import_results(session, cfg, search)
    return serialize_search(search)


@router.post("/searches/{search_id}/abort")
async def abort_search(search_id: int, session: AsyncSession = Depends(get_session)):
    search = await session.get(ProspectSearch, search_id)
    if search is None:
        raise HTTPException(status_code=404, detail="Varredura nao encontrada.")
    if not search.apify_run_id:
        raise HTTPException(status_code=400, detail="Essa varredura nao tem run no Apify.")
    cfg = await settings_store.load(session)
    try:
        await apify.abort_run(cfg, search.apify_run_id)
    except apify.ApifyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    search.status = "failed"
    search.error = "Abortada manualmente."
    search.finished_at = datetime.now(timezone.utc)
    await session.commit()
    return serialize_search(search)


@router.delete("/searches/{search_id}", status_code=204)
async def delete_search(search_id: int, session: AsyncSession = Depends(get_session)):
    """Apaga o registro da varredura. Os prospects ficam — eles sao o CRM."""
    search = await session.get(ProspectSearch, search_id)
    if search is None:
        raise HTTPException(status_code=404, detail="Varredura nao encontrada.")
    await session.delete(search)
    await session.commit()


# ---------------------------------------------------------------------------
# prospects
# ---------------------------------------------------------------------------


@router.get("/prospects")
async def list_prospects(
    stage: str | None = Query(default=None),
    search_id: int | None = Query(default=None),
    q: str | None = Query(default=None),
    only_mobile: bool = Query(default=False),
    only_with_phone: bool = Query(default=False),
    limit: int = Query(default=200, le=1000),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Prospect)
    if stage:
        stmt = stmt.where(Prospect.stage == stage)
    if search_id:
        stmt = stmt.where(Prospect.search_id == search_id)
    if only_mobile:
        stmt = stmt.where(Prospect.phone_kind == "mobile")
    elif only_with_phone:
        stmt = stmt.where(Prospect.phone_e164.is_not(None))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(Prospect.name.ilike(like), Prospect.category.ilike(like), Prospect.address.ilike(like))
        )
    stmt = stmt.order_by(Prospect.distance_km.is_(None), Prospect.distance_km, desc(Prospect.id)).limit(limit)
    rows = (await session.execute(stmt)).scalars().all()
    return [serialize_prospect(p) for p in rows]


@router.get("/pipeline")
async def pipeline(session: AsyncSession = Depends(get_session)):
    """Contagem por etapa + numeros que a UI mostra no topo."""
    by_stage = dict(
        (await session.execute(select(Prospect.stage, func.count()).group_by(Prospect.stage))).all()
    )
    total = (await session.execute(select(func.count(Prospect.id)))).scalar_one()
    with_mobile = (
        await session.execute(select(func.count(Prospect.id)).where(Prospect.phone_kind == "mobile"))
    ).scalar_one()
    sent = (
        await session.execute(select(func.count(Outreach.id)).where(Outreach.status == "sent"))
    ).scalar_one()
    queued = (
        await session.execute(select(func.count(Outreach.id)).where(Outreach.status == "queued"))
    ).scalar_one()
    failed = (
        await session.execute(select(func.count(Outreach.id)).where(Outreach.status == "failed"))
    ).scalar_one()
    return {
        "stages": {s: by_stage.get(s, 0) for s in STAGES},
        "total": total,
        "with_mobile": with_mobile,
        "outreach": {"sent": sent, "queued": queued, "failed": failed},
        "sent_today": await _sent_today(session),
    }


@router.get("/prospects/{prospect_id}")
async def get_prospect(prospect_id: int, session: AsyncSession = Depends(get_session)):
    prospect = (
        await session.execute(
            select(Prospect).options(selectinload(Prospect.outreaches)).where(Prospect.id == prospect_id)
        )
    ).scalar_one_or_none()
    if prospect is None:
        raise HTTPException(status_code=404, detail="Prospect nao encontrado.")
    return serialize_prospect(prospect, outreaches=True)


class ProspectPatch(BaseModel):
    stage: str | None = None
    note: str | None = None
    phone_e164: str | None = None


@router.patch("/prospects/{prospect_id}")
async def patch_prospect(
    prospect_id: int, patch: ProspectPatch, session: AsyncSession = Depends(get_session)
):
    prospect = await session.get(Prospect, prospect_id)
    if prospect is None:
        raise HTTPException(status_code=404, detail="Prospect nao encontrado.")

    if patch.stage is not None:
        if patch.stage not in STAGES:
            raise HTTPException(status_code=400, detail=f"Etapa invalida. Use uma de: {', '.join(STAGES)}.")
        prospect.stage = patch.stage
    if patch.note is not None:
        prospect.note = patch.note
    if patch.phone_e164 is not None:
        # correcao manual de telefone: renormaliza e reclassifica junto
        normalized = phones.to_e164(patch.phone_e164)
        if patch.phone_e164.strip() and not normalized:
            raise HTTPException(status_code=400, detail="Telefone invalido.")
        prospect.phone_e164 = normalized
        prospect.phone_raw = patch.phone_e164.strip() or None
        prospect.phone_kind = phones.classify(normalized) if normalized else None

    await session.commit()
    await session.refresh(prospect)
    return serialize_prospect(prospect)


@router.delete("/prospects/{prospect_id}", status_code=204)
async def delete_prospect(prospect_id: int, session: AsyncSession = Depends(get_session)):
    prospect = await session.get(Prospect, prospect_id)
    if prospect is None:
        raise HTTPException(status_code=404, detail="Prospect nao encontrado.")
    await session.delete(prospect)
    await session.commit()


@router.get("/prospects.csv")
async def export_csv(
    stage: str | None = Query(default=None),
    search_id: int | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Prospect).order_by(Prospect.id)
    if stage:
        stmt = stmt.where(Prospect.stage == stage)
    if search_id:
        stmt = stmt.where(Prospect.search_id == search_id)
    rows = (await session.execute(stmt)).scalars().all()

    columns = [
        "id", "name", "category", "phone_e164", "phone_kind", "stage", "rating",
        "reviews_count", "distance_km", "city", "state", "address", "website",
        "email", "maps_url", "note",
    ]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(columns)
    for p in rows:
        writer.writerow([getattr(p, c, "") if getattr(p, c, None) is not None else "" for c in columns])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="prospects.csv"'},
    )


# ---------------------------------------------------------------------------
# abordagem ativa
# ---------------------------------------------------------------------------


@router.get("/templates")
async def list_templates(session: AsyncSession = Depends(get_session)):
    """Templates do WABA — a lista de onde a abordagem fria pode sair."""
    cfg = await settings_store.load(session)
    try:
        raw = await whatsapp_cloud.message_templates(cfg)
    except Exception as exc:  # noqa: BLE001 — a UI mostra o motivo cru
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return [
        {
            "name": t.get("name"),
            "language": t.get("language"),
            "status": t.get("status"),
            "category": t.get("category"),
            "body": whatsapp_cloud.template_body(t),
            "placeholders": whatsapp_cloud.template_placeholders(t),
            "approved": (t.get("status") or "").upper() == "APPROVED",
        }
        for t in raw
    ]


async def _sent_today(session: AsyncSession) -> int:
    since = datetime.now(timezone.utc) - timedelta(days=1)
    return (
        await session.execute(
            select(func.count(Outreach.id)).where(Outreach.status == "sent", Outreach.sent_at >= since)
        )
    ).scalar_one()


def _fill_params(template_params: list[str], prospect: Prospect) -> list[str]:
    """Troca os curingas do disparo em massa pelos dados do prospect."""
    mapping = {
        "{nome}": prospect.name or "",
        "{categoria}": prospect.category or "",
        "{cidade}": prospect.city or "",
        "{bairro}": prospect.city or "",
    }
    out = []
    for raw in template_params:
        value = raw
        for token, replacement in mapping.items():
            value = value.replace(token, replacement)
        out.append(value)
    return out


class OutreachIn(BaseModel):
    kind: str = "template"  # template | text
    template_name: str | None = None
    template_language: str | None = None
    template_params: list[str] = Field(default_factory=list)
    text: str | None = None


class BulkOutreachIn(OutreachIn):
    prospect_ids: list[int] = Field(min_length=1)


def _build_outreach(cfg: dict, payload: OutreachIn, prospect: Prospect) -> tuple[dict, Outreach]:
    """Monta o payload da Graph API e o registro de abordagem (ainda `queued`)."""
    to = phones.to_wa_id(prospect.phone_e164)
    if not to:
        raise ValueError("Prospect sem telefone valido.")

    if payload.kind == "text":
        body = (payload.text or "").strip()
        if not body:
            raise ValueError("Texto da mensagem vazio.")
        body = _fill_params([body], prospect)[0]
        request = whatsapp_cloud.build_text_payload(to, body)
        record = Outreach(
            prospect_id=prospect.id, kind="text", body_preview=body, to_phone=prospect.phone_e164
        )
        return request, record

    name = payload.template_name or cfg.get("outreach_template_name") or ""
    language = payload.template_language or cfg.get("outreach_template_language") or "pt_BR"
    if not name:
        raise ValueError(
            "Nenhum template escolhido. Abordagem fria (fora da janela de 24h) so entrega por "
            "template aprovado pela Meta."
        )
    params = _fill_params(payload.template_params, prospect)
    request = whatsapp_cloud.build_template_payload(to, name, language, params)
    record = Outreach(
        prospect_id=prospect.id,
        kind="template",
        template_name=name,
        template_language=language,
        body_preview=" | ".join(params) if params else None,
        to_phone=prospect.phone_e164,
    )
    return request, record


async def _send_one(session: AsyncSession, cfg: dict, record: Outreach, request: dict) -> Outreach:
    """Envia e grava o resultado. O payload vai pro banco antes do envio."""
    record.request_payload = request
    try:
        http_status, body = await whatsapp_cloud.send_message(cfg, request)
        record.http_status = http_status
        record.response_body = body if isinstance(body, dict) else {"data": body}
        record.wamid = whatsapp_cloud.first_wamid(record.response_body)
        record.status = "sent"
        record.sent_at = datetime.now(timezone.utc)
    except Exception as exc:  # noqa: BLE001 — o erro da Meta e o que interessa aqui
        record.status = "failed"
        record.error = str(exc)

    prospect = await session.get(Prospect, record.prospect_id)
    if prospect is not None and record.status == "sent":
        prospect.last_outreach_at = record.sent_at
        if prospect.stage == "novo":
            prospect.stage = "contatado"

    await session.commit()
    await session.refresh(record)
    return record


@router.post("/prospects/{prospect_id}/outreach")
async def outreach_one(
    prospect_id: int, payload: OutreachIn, session: AsyncSession = Depends(get_session)
):
    """Dispara uma abordagem agora e devolve a resposta crua da Meta."""
    cfg = await settings_store.load(session)
    if not cfg.get("outreach_enabled"):
        raise HTTPException(
            status_code=400,
            detail="Abordagem ativa esta desligada. Ligue em Prospecção → Configuração antes de disparar.",
        )

    prospect = await session.get(Prospect, prospect_id)
    if prospect is None:
        raise HTTPException(status_code=404, detail="Prospect nao encontrado.")
    if cfg.get("outreach_only_mobile") and prospect.phone_kind != "mobile" and payload.kind == "template":
        raise HTTPException(
            status_code=400,
            detail=f"Telefone classificado como {prospect.phone_kind or 'desconhecido'} — "
            "desligue 'só celular' na configuração se quiser tentar mesmo assim.",
        )

    cap = int(cfg.get("outreach_daily_cap") or 0)
    if cap and await _sent_today(session) >= cap:
        raise HTTPException(status_code=429, detail=f"Limite diario de {cap} abordagens atingido.")

    try:
        request, record = _build_outreach(cfg, payload, prospect)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    session.add(record)
    await session.flush()
    await _send_one(session, cfg, record, request)
    return serialize_outreach(record)


@router.post("/outreach/bulk", status_code=202)
async def outreach_bulk(payload: BulkOutreachIn, session: AsyncSession = Depends(get_session)):
    """Enfileira a abordagem de vários prospects; um worker em background esvazia a fila.

    Enfileirar em vez de enviar na hora e proposital: com throttle de alguns segundos
    por numero, 50 disparos levariam minutos e a requisicao estouraria.
    """
    cfg = await settings_store.load(session)
    if not cfg.get("outreach_enabled"):
        raise HTTPException(
            status_code=400,
            detail="Abordagem ativa esta desligada. Ligue em Prospecção → Configuração antes de disparar.",
        )

    rows = (
        (await session.execute(select(Prospect).where(Prospect.id.in_(payload.prospect_ids))))
        .scalars()
        .all()
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Nenhum prospect encontrado para esses ids.")

    only_mobile = bool(cfg.get("outreach_only_mobile"))
    queued = 0
    skipped: list[dict] = []

    for prospect in rows:
        if not prospect.phone_e164:
            skipped.append({"id": prospect.id, "name": prospect.name, "reason": "sem telefone"})
            continue
        if only_mobile and prospect.phone_kind != "mobile":
            skipped.append(
                {"id": prospect.id, "name": prospect.name, "reason": f"telefone {prospect.phone_kind}"}
            )
            continue
        try:
            request, record = _build_outreach(cfg, payload, prospect)
        except ValueError as exc:
            skipped.append({"id": prospect.id, "name": prospect.name, "reason": str(exc)})
            continue

        record.request_payload = request  # a fila envia exatamente o que foi montado aqui
        session.add(record)
        queued += 1

    await session.commit()
    if queued:
        start_queue_worker()

    return {"queued": queued, "skipped": skipped, "cap": cfg.get("outreach_daily_cap")}


@router.get("/outreach")
async def list_outreach(
    status: str | None = Query(default=None),
    limit: int = Query(default=100, le=500),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Outreach).order_by(desc(Outreach.id)).limit(limit)
    if status:
        stmt = stmt.where(Outreach.status == status)
    rows = (await session.execute(stmt)).scalars().all()
    ids = {r.prospect_id for r in rows}
    names = dict(
        (await session.execute(select(Prospect.id, Prospect.name).where(Prospect.id.in_(ids)))).all()
    ) if ids else {}
    return [{**serialize_outreach(o), "prospect_name": names.get(o.prospect_id)} for o in rows]


# ---------------------------------------------------------------------------
# fila de disparo
# ---------------------------------------------------------------------------

_worker: asyncio.Task | None = None


def start_queue_worker() -> None:
    """Sobe o worker se ainda nao houver um rodando. Idempotente."""
    global _worker
    if _worker is not None and not _worker.done():
        return
    _worker = asyncio.create_task(_drain_queue())


async def _drain_queue() -> None:
    """Envia as abordagens `queued`, uma a uma, respeitando throttle e cap diario.

    Sessao propria: o worker vive fora do ciclo de vida da requisicao.
    """
    while True:
        async with SessionLocal() as session:
            cfg = await settings_store.load(session)
            if not cfg.get("outreach_enabled"):
                log.info("fila de abordagem parada: outreach_enabled esta desligado")
                return

            record = (
                await session.execute(
                    select(Outreach).where(Outreach.status == "queued").order_by(Outreach.id).limit(1)
                )
            ).scalar_one_or_none()
            if record is None:
                return

            cap = int(cfg.get("outreach_daily_cap") or 0)
            if cap and await _sent_today(session) >= cap:
                record.status = "skipped"
                record.error = f"Limite diario de {cap} abordagens atingido."
                await session.commit()
                continue

            await _send_one(session, cfg, record, record.request_payload or {})
            throttle = max(0, int(cfg.get("outreach_throttle_seconds") or 0))

        if throttle:
            await asyncio.sleep(throttle)


@router.post("/outreach/drain")
async def drain_now(session: AsyncSession = Depends(get_session)):
    """Reacende o worker — util depois de reiniciar o backend com fila pendente."""
    pending = (
        await session.execute(select(func.count(Outreach.id)).where(Outreach.status == "queued"))
    ).scalar_one()
    if pending:
        start_queue_worker()
    return {"pending": pending}
