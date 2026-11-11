"""Formularios de captacao: painel (logado, por linha) e as rotas publicas que a
pagina /f/{slug} consome — no mesmo dominio do painel.
"""

import json
import time

import httpx
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import access, form_ai, forms, journey, phones
from app import qualification as ql
from app import sheets
from app.db import get_session
from app.models import Contact, FormPartial, FormResponse, LeadForm, WaNumber
from app.routers.collect import client_ip

router = APIRouter(prefix="/api/forms", tags=["forms"])
public_router = APIRouter(prefix="/api/forms/public", tags=["forms-public"])


async def _form(session: AsyncSession, form_id: int) -> LeadForm:
    form = await session.get(LeadForm, form_id)
    if form is None or not access.can_see(form.wa_number_id):
        raise HTTPException(status_code=404, detail="Formulário não encontrado.")
    return form


async def _number(session: AsyncSession, number_id: int | None) -> WaNumber:
    if number_id is None:
        raise HTTPException(status_code=400, detail="Escolha a linha (cliente) do formulário.")
    access.ensure_number(number_id)
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Linha não encontrada.")
    return number


# ---------------------------------------------------------------------------
# painel
# ---------------------------------------------------------------------------

@router.get("")
async def list_forms(number_id: int | None = Query(default=None), session: AsyncSession = Depends(get_session)):
    stmt = access.scope(select(LeadForm).order_by(desc(LeadForm.id)), LeadForm.wa_number_id, number_id)
    rows = (await session.execute(stmt)).scalars().all()
    ids = [f.id for f in rows]
    counts = await forms.response_counts(session, ids)
    partials = await forms.partial_counts(session, ids)
    qualified = await forms.qualified_counts(session, ids)
    numbers = {n.id: n for n in (await session.execute(select(WaNumber))).scalars().all()}
    return [
        forms.serialize(
            f, counts.get(f.id, 0), numbers.get(f.wa_number_id), partials.get(f.id, 0), qualified.get(f.id, 0),
        )
        for f in rows
    ]


@router.get("/frameworks")
async def frameworks():
    return {
        "frameworks": form_ai.catalog(),
        "min_questions": form_ai.MIN_Q,
        "max_questions": form_ai.MAX_Q,
        "ai_available": form_ai.is_available(),
    }


class AiIn(BaseModel):
    framework: str = "bant"
    number_id: int | None = None
    business: str = ""
    offer: str = ""
    audience: str = ""
    tone: str = ""
    questions: int = 0
    notes: str = ""


@router.post("/ai-generate")
async def ai_generate(payload: AiIn, session: AsyncSession = Depends(get_session)):
    """Rascunho seguindo o metodo escolhido. Nao grava nada."""
    label = None
    if payload.number_id is not None:
        label = (await _number(session, payload.number_id)).label
    try:
        return await form_ai.generate(payload.model_dump(), label)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("")
async def create_form(payload: dict, session: AsyncSession = Depends(get_session)):
    number = await _number(session, payload.get("wa_number_id"))
    form = LeadForm(
        wa_number_id=number.id,
        slug=forms.slugify(payload.get("title") or ""),
        title=(payload.get("title") or "Novo formulário").strip()[:200],
        thank_you=forms.THANK_YOU,
        fields=[], theme=forms.clean_theme({}), settings=forms.clean_settings({}),
        created_by=(access.current_user().id if access.current_user() else None),
    )
    forms.apply(form, payload)
    session.add(form)
    await session.commit()
    await session.refresh(form)
    return forms.serialize(form, 0, number)


class NotifyTestIn(BaseModel):
    wa_number_id: int | None = None
    phone: str = ""
    title: str = ""
    fields: list = []


@router.post("/test-notify")
async def test_notify(payload: NotifyTestIn, session: AsyncSession = Depends(get_session)):
    """Manda o aviso de novo lead com respostas de exemplo. Usa o que esta na
    tela (mesmo sem salvar), pra conferir o numero e a instancia antes de publicar."""
    number = await _number(session, payload.wa_number_id)
    if len(phones.digits(payload.phone)) < 10:
        raise HTTPException(status_code=400, detail="Digite o número que recebe o aviso, com DDD.")
    text = forms.notify_text(payload.title.strip() or "Novo formulário", forms.sample_resumo(payload.fields), test=True)
    try:
        await forms.send_notify(session, number, payload.phone, text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"O WhatsApp da linha “{number.label}” não enviou: {str(exc)[:300]}"
        ) from exc
    return {"ok": True}


@router.get("/sheets-script")
async def sheets_script(secret: str = Query(..., min_length=16, max_length=64)):
    """O Apps Script que vai na planilha, ja com o segredo do formulario."""
    return {"script": sheets.apps_script(secret)}


class SheetsTestIn(BaseModel):
    wa_number_id: int | None = None
    url: str = ""
    secret: str = ""
    tab: str = ""
    title: str = ""
    fields: list = []


@router.post("/sheets-test")
async def sheets_test(payload: SheetsTestIn, session: AsyncSession = Depends(get_session)):
    """Grava uma linha de exemplo (marcada TESTE) com o que esta na tela, mesmo sem salvar."""
    await _number(session, payload.wa_number_id)
    fields = forms.clean_fields(payload.fields)
    answers = {f["id"]: (f["options"][0] if f["options"] else forms.SAMPLE_ANSWERS.get(f["type"], "Exemplo"))
               for f in fields}
    columns = sheets.build_columns(
        form_title=payload.title.strip() or "Formulário", response_id="teste", created_at=None,
        fields=fields, answers=answers, qualified=True,
        page_url="https://exemplo.com/?utm_source=teste&utm_medium=cpc&utm_campaign=teste", test=True,
    )
    try:
        r = await sheets.append_row(payload.url.strip(), payload.secret.strip(), payload.tab.strip(), columns)
    except sheets.SheetsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Não foi possível falar com o Apps Script: {exc}") from exc
    return {"ok": True, "row": r.get("row")}


@router.patch("/{form_id}")
async def update_form(form_id: int, payload: dict, session: AsyncSession = Depends(get_session)):
    form = await _form(session, form_id)
    if "wa_number_id" in payload and payload["wa_number_id"] != form.wa_number_id:
        form.wa_number_id = (await _number(session, payload["wa_number_id"])).id
    forms.apply(form, payload)
    await session.commit()
    await session.refresh(form)
    counts = await forms.response_counts(session, [form.id])
    partials = await forms.partial_counts(session, [form.id])
    number = await session.get(WaNumber, form.wa_number_id) if form.wa_number_id else None
    qualified = await forms.qualified_counts(session, [form.id])
    return forms.serialize(form, counts.get(form.id, 0), number, partials.get(form.id, 0), qualified.get(form.id, 0))


@router.delete("/{form_id}", status_code=204)
async def delete_form(form_id: int, session: AsyncSession = Depends(get_session)):
    form = await _form(session, form_id)
    await session.delete(form)
    await session.commit()


@router.get("/{form_id}/responses")
async def responses(form_id: int, limit: int = Query(default=300, le=2000), session: AsyncSession = Depends(get_session)):
    form = await _form(session, form_id)
    rows = (
        await session.execute(
            select(FormResponse).where(FormResponse.form_id == form.id).order_by(desc(FormResponse.id)).limit(limit)
        )
    ).scalars().all()
    return [forms.serialize_response(r) for r in rows]


@router.post("/{form_id}/responses/{response_id}/sheets")
async def resend_to_sheets(form_id: int, response_id: int, session: AsyncSession = Depends(get_session)):
    """Reenvia a resposta para a planilha (depois de corrigir a URL, por exemplo)."""
    form = await _form(session, form_id)
    response = await session.get(FormResponse, response_id)
    if response is None or response.form_id != form.id:
        raise HTTPException(status_code=404, detail="Resposta não encontrada.")
    if not forms.sheets_ready(form):
        raise HTTPException(status_code=400, detail="Ligue a planilha e salve a URL do Apps Script antes.")
    await forms.push_to_sheets(session, form, response)
    await session.refresh(response)
    return forms.serialize_response(response)


class QualifyIn(BaseModel):
    # True/False = classificacao da equipe; None = volta para os criterios automaticos
    qualified: bool | None = None


@router.patch("/{form_id}/responses/{response_id}/qualification")
async def qualify_response(
    form_id: int, response_id: int, payload: QualifyIn, session: AsyncSession = Depends(get_session),
):
    """Marca a resposta como qualificada ou nao. Qualificou: move para MQL (se
    configurado) e manda o evento ao Meta, uma unica vez por resposta."""
    form = await _form(session, form_id)
    response = await session.get(FormResponse, response_id)
    if response is None or response.form_id != form.id:
        raise HTTPException(status_code=404, detail="Resposta não encontrada.")
    await forms.set_manual_qualification(session, form, response, payload.qualified)
    await session.refresh(response)
    return forms.serialize_response(response)


class SimulateIn(BaseModel):
    qualification: dict = {}
    fields: list | None = None
    limit: int = 500


@router.post("/{form_id}/qualification/simulate")
async def simulate_qualification(form_id: int, payload: SimulateIn, session: AsyncSession = Depends(get_session)):
    """Testa criterios (ainda nao salvos) contra as respostas ja recebidas."""
    form = await _form(session, form_id)
    fields = forms.clean_fields(payload.fields if payload.fields is not None else form.fields)
    rows = (
        await session.execute(
            select(FormResponse.answers).where(FormResponse.form_id == form.id)
            .order_by(desc(FormResponse.id)).limit(max(1, min(payload.limit, 2000)))
        )
    ).scalars().all()
    return ql.simulate(payload.qualification, fields, [a or {} for a in rows])


@router.post("/{form_id}/qualification/reapply")
async def reapply_qualification(form_id: int, session: AsyncSession = Depends(get_session)):
    """Reclassifica as respostas antigas com os criterios salvos, sem disparar evento."""
    form = await _form(session, form_id)
    return await forms.reapply_qualification(session, form)


@router.get("/{form_id}/partials")
async def partials(form_id: int, limit: int = Query(default=300, le=2000), session: AsyncSession = Depends(get_session)):
    """Quem comecou a preencher e nao enviou."""
    form = await _form(session, form_id)
    rows = (
        await session.execute(
            select(FormPartial)
            .where(FormPartial.form_id == form.id, FormPartial.response_id.is_(None))
            .order_by(desc(FormPartial.updated_at))
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": p.id, "answers": p.answers or {}, "step": p.step or 0,
            "transaction_id": p.transaction_id, "created_at": p.created_at, "updated_at": p.updated_at,
        }
        for p in rows
    ]


@router.delete("/{form_id}/partials/{partial_id}", status_code=204)
async def delete_partial(form_id: int, partial_id: int, session: AsyncSession = Depends(get_session)):
    form = await _form(session, form_id)
    partial = await session.get(FormPartial, partial_id)
    if partial is None or partial.form_id != form.id:
        raise HTTPException(status_code=404, detail="Preenchimento não encontrado.")
    await session.delete(partial)
    await session.commit()


@router.get("/contact/{contact_id}")
async def contact_responses(contact_id: int, session: AsyncSession = Depends(get_session)):
    """Respostas de formulario de uma conversa do CRM."""
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    rows = (
        await session.execute(
            select(FormResponse, LeadForm)
            .join(LeadForm, LeadForm.id == FormResponse.form_id)
            .where(FormResponse.contact_id == contact_id)
            .order_by(desc(FormResponse.id))
        )
    ).all()
    out = []
    for r, f in rows:
        labels = {q["id"]: q["label"] for q in forms.clean_fields(f.fields)}
        out.append({
            "id": r.id, "form_id": f.id, "form_title": f.title, "created_at": r.created_at,
            "answers": [{"label": labels.get(k, k), "value": v} for k, v in (r.answers or {}).items() if v],
        })
    return out


# ---------------------------------------------------------------------------
# publico: o lead abre /f/{slug}
# ---------------------------------------------------------------------------

# trava simples por IP: formulario publico nao pode virar metralhadora de lead falso
_hits: dict[str, deque] = defaultdict(deque)
_WINDOW, _MAX = 600, 12
# o rascunho salva a cada pergunta: folga maior, mas ainda com teto
_PARTIAL_MAX = 300


def _throttle(key: str, limit: int = _MAX) -> None:
    now = time.monotonic()
    q = _hits[key]
    while q and now - q[0] > _WINDOW:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(status_code=429, detail="Muitos envios em pouco tempo. Tente de novo em alguns minutos.")
    q.append(now)


async def _public(session: AsyncSession, slug: str) -> LeadForm:
    form = (await session.execute(select(LeadForm).where(LeadForm.slug == slug))).scalars().first()
    if form is None or not form.active:
        raise HTTPException(status_code=404, detail="Formulário não encontrado ou desativado.")
    return form


@public_router.get("/{slug}")
async def public_form(slug: str, preview: bool = Query(default=False), session: AsyncSession = Depends(get_session)):
    form = await _public(session, slug)
    if not preview:
        form.views = (form.views or 0) + 1
        await session.commit()
    number = await session.get(WaNumber, form.wa_number_id) if form.wa_number_id else None
    if number is not None and forms.clean_settings(form.settings)["track_journey"]:
        # linha que nunca abriu "Tag do site" ainda nao tem chave: nasce aqui
        await journey.ensure_site_key(session, number)
    return forms.public_payload(form, number)


@public_router.post("/{slug}/submit")
async def public_submit(slug: str, payload: dict, request: Request, session: AsyncSession = Depends(get_session)):
    payload = payload or {}
    # honeypot: campo invisivel preenchido = robo. Finge sucesso e nao grava.
    if payload.get("website"):
        return {"ok": True, "thank_you": "Obrigado!"}
    ip = client_ip(request) or ""
    _throttle(f"{ip}:{slug}")
    form = await _public(session, slug)
    ctx = {
        "event_id": str(payload.get("event_id") or "")[:64],
        "url": str(payload.get("url") or "")[:500],
        "fbp": str(payload.get("fbp") or "")[:100],
        "fbc": str(payload.get("fbc") or "")[:200],
        "tl": str(payload.get("tl") or "")[:64],
        "ip": ip,
        "ua": (request.headers.get("user-agent") or "")[:500],
        "consent": bool(payload.get("consent")),
        "sid": str(payload.get("sid") or "")[:64],
    }
    answers = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
    try:
        return await forms.submit(session, form, answers, ctx)
    except forms.SubmitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@public_router.post("/{slug}/partial")
async def public_partial(slug: str, request: Request, session: AsyncSession = Depends(get_session)):
    """Rascunho de quem ainda esta preenchendo. Le o corpo cru porque a pagina
    usa sendBeacon ao fechar a aba, que nao garante o Content-Type."""
    try:
        payload = json.loads(await request.body() or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="Corpo inválido.") from None
    if not isinstance(payload, dict) or payload.get("website"):
        return {"ok": True}
    ip = client_ip(request) or ""
    _throttle(f"partial:{ip}:{slug}", _PARTIAL_MAX)
    form = await _public(session, slug)
    answers = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
    try:
        step = int(payload.get("step") or 0)
    except (TypeError, ValueError):
        step = 0
    ctx = {
        "tl": str(payload.get("tl") or "")[:64],
        "ip": ip,
        "ua": (request.headers.get("user-agent") or "")[:500],
    }
    saved = await forms.save_partial(session, form, str(payload.get("sid") or "")[:64], answers, step, ctx)
    return {"ok": True, "saved": saved}
