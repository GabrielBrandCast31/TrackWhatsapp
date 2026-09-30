"""Jornadas do lead: do anuncio ao site, do site ao WhatsApp, do WhatsApp ao lead.

A tela principal do rastreador. Tudo aqui le `tracking_events` (a navegacao,
gravada pela tag do site) e `contacts` (a conversa, com a referencia ao TL_ID).
"""

import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import access, journey
from app.db import get_session
from app.models import Contact, TrackingEvent, WaNumber

router = APIRouter(prefix="/api/journeys", tags=["journeys"])

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:3031").rstrip("/")

# sinais que o overview precisa por evento — sem carregar a linha inteira
_LIGHT = (
    TrackingEvent.transaction_id,
    TrackingEvent.event_time,
    TrackingEvent.event_name,
    TrackingEvent.utm_source,
    TrackingEvent.utm_medium,
    TrackingEvent.first_utm_source,
    TrackingEvent.first_utm_medium,
    TrackingEvent.gclid,
    TrackingEvent.gbraid,
    TrackingEvent.wbraid,
    TrackingEvent.fbclid,
    TrackingEvent.ttclid,
    TrackingEvent.page_referrer,
    TrackingEvent.hostname,
    TrackingEvent.visitor_id,
    TrackingEvent.landing_page,
    TrackingEvent.page_path,
    TrackingEvent.page_url,
    TrackingEvent.utm_campaign,
)


def _since(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365)))


def _scoped(stmt, model, number_id: int | None):
    return access.scope(stmt, model.wa_number_id, number_id)


def _lead(contact: Contact | None) -> dict | None:
    if contact is None:
        return None
    return {
        "id": contact.id,
        "name": contact.name,
        "wa_id": contact.wa_id,
        "phone_e164": contact.phone_e164,
        "stage": contact.stage,
        "wa_number_id": contact.wa_number_id,
        "created_at": contact.created_at,
        **journey.contact_journey_fields(contact),
    }


def _origin_of(rows) -> dict:
    """Origem da jornada a partir das linhas leves (mesma regra do `summarize`)."""
    signal = None
    first = None
    referrer = None
    for r in rows:
        if first is None and r.first_utm_source:
            first = {"source": r.first_utm_source, "medium": r.first_utm_medium}
        if journey.has_signal(r.utm_source, r.page_url):
            signal = r
        if referrer is None and r.page_referrer:
            referrer = r
    clicks = {k: getattr(r, k) for r in rows for k in ("gclid", "gbraid", "wbraid", "fbclid", "ttclid") if getattr(r, k)}
    if signal is not None:
        utm = {"source": signal.utm_source, "medium": signal.utm_medium, "campaign": signal.utm_campaign}
        touch = journey.signal_touch({k: v for k, v in utm.items() if v}, signal.page_url)
    else:
        touch = first or {}
    if not touch and referrer is not None:
        host = (urlparse(referrer.page_referrer).hostname or "").lower()
        if host and host != (referrer.hostname or "").lower():
            source = host.removeprefix("www.").removeprefix("m.").removeprefix("l.")
            touch = {"source": source, "medium": "organic" if journey._is_search(source) else "referral"}
    return journey.classify({k: v for k, v in touch.items() if v}, clicks)


# ---------------------------------------------------------------------------
# instalacao da tag
# ---------------------------------------------------------------------------

async def _number(session: AsyncSession, number_id: int) -> WaNumber:
    access.ensure_number(number_id)
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Linha não encontrada.")
    return number


def _setup(number: WaNumber) -> dict:
    script = f"{PUBLIC_BASE_URL}/t/tl.js?k={number.site_key}"
    return {
        "number_id": number.id,
        "site_key": number.site_key,
        "script_url": script,
        "collect_url": f"{PUBLIC_BASE_URL}/t/collect",
        "snippet": f'<script async src="{script}"></script>',
        "match_window_seconds": int(journey.MATCH_WINDOW.total_seconds()),
    }


@router.get("/setup")
async def setup(number_id: int = Query(...), session: AsyncSession = Depends(get_session)):
    number = await _number(session, number_id)
    await journey.ensure_site_key(session, number)
    last = (
        await session.execute(
            select(TrackingEvent.event_time, TrackingEvent.hostname, TrackingEvent.page_url)
            .where(TrackingEvent.wa_number_id == number.id)
            .order_by(TrackingEvent.id.desc())
            .limit(1)
        )
    ).first()
    return {
        **_setup(number),
        "last_event_at": last.event_time if last else None,
        "last_event_host": last.hostname if last else None,
        "last_event_url": last.page_url if last else None,
    }


@router.post("/setup/{number_id}/rotate")
async def rotate_key(number_id: int, session: AsyncSession = Depends(get_session)):
    number = await _number(session, number_id)
    number.site_key = journey.new_site_key()
    await session.commit()
    return _setup(number)


# ---------------------------------------------------------------------------
# visao geral: o funil da jornada
# ---------------------------------------------------------------------------

@router.get("/overview")
async def overview(
    number_id: int | None = Query(default=None),
    days: int = Query(default=30),
    session: AsyncSession = Depends(get_session),
):
    since = _since(days)
    stmt = _scoped(select(*_LIGHT).where(TrackingEvent.event_time >= since), TrackingEvent, number_id)
    rows = (await session.execute(stmt.order_by(TrackingEvent.event_time).limit(100_000))).all()

    by_tl: dict[str, list] = {}
    for r in rows:
        by_tl.setdefault(r.transaction_id, []).append(r)

    leads_stmt = _scoped(
        select(Contact).where(Contact.transaction_id.is_not(None)).where(
            or_(Contact.whatsapp_arrived_at >= since, Contact.created_at >= since)
        ),
        Contact,
        number_id,
    )
    leads = (await session.execute(leads_stmt)).scalars().all()
    lead_tls = {c.transaction_id for c in leads}

    total_conversations = (
        await session.execute(
            _scoped(select(func.count(Contact.id)).where(Contact.created_at >= since), Contact, number_id)
        )
    ).scalar_one()

    clicked = {tl for tl, evs in by_tl.items() if any(e.event_name == "click_whatsapp" for e in evs)}
    by_origin: dict[str, dict] = {}
    for tl, evs in by_tl.items():
        origin = _origin_of(evs)
        slot = by_origin.setdefault(
            origin["label"], {"label": origin["label"], "channel": origin["channel"], "journeys": 0, "clicks": 0, "leads": 0}
        )
        slot["journeys"] += 1
        slot["clicks"] += tl in clicked
        slot["leads"] += tl in lead_tls

    methods: dict[str, int] = {}
    for c in leads:
        methods[c.match_method or "transaction_id"] = methods.get(c.match_method or "transaction_id", 0) + 1

    events_by_name: dict[str, int] = {}
    for r in rows:
        events_by_name[r.event_name] = events_by_name.get(r.event_name, 0) + 1

    # serie diaria: jornadas iniciadas, cliques no WhatsApp e leads identificados
    daily: dict[str, dict] = {}
    for tl, evs in by_tl.items():
        day = evs[0].event_time.date().isoformat()
        daily.setdefault(day, {"day": day, "journeys": 0, "clicks": 0, "leads": 0})["journeys"] += 1
        if tl in clicked:
            click_day = next(e.event_time for e in evs if e.event_name == "click_whatsapp").date().isoformat()
            daily.setdefault(click_day, {"day": click_day, "journeys": 0, "clicks": 0, "leads": 0})["clicks"] += 1
    for c in leads:
        stamp = c.whatsapp_arrived_at or c.created_at
        day = stamp.date().isoformat()
        daily.setdefault(day, {"day": day, "journeys": 0, "clicks": 0, "leads": 0})["leads"] += 1

    landing: dict[str, int] = {}
    for evs in by_tl.values():
        page = next((e.landing_page for e in evs if e.landing_page), None) or evs[0].page_path or "/"
        landing[page] = landing.get(page, 0) + 1

    return {
        "days": days,
        "journeys": len(by_tl),
        "visitors": len({r.visitor_id for r in rows if r.visitor_id}) or len(by_tl),
        "page_views": events_by_name.get("page_view", 0),
        "whatsapp_clicks": len(clicked),
        "matched_leads": len(leads),
        "conversations": total_conversations,
        "match_rate": round(len(leads) / total_conversations, 4) if total_conversations else None,
        "click_to_lead": round(len(lead_tls & clicked) / len(clicked), 4) if clicked else None,
        "events_by_name": events_by_name,
        "by_origin": sorted(by_origin.values(), key=lambda o: (-o["leads"], -o["journeys"])),
        "by_method": [
            {"method": m, "label": journey.MATCH_LABELS.get(m, m), "leads": n}
            for m, n in sorted(methods.items(), key=lambda x: -x[1])
        ],
        "landing_pages": [
            {"page": p, "journeys": n} for p, n in sorted(landing.items(), key=lambda x: -x[1])[:8]
        ],
        "daily": sorted(daily.values(), key=lambda d: d["day"]),
    }


# ---------------------------------------------------------------------------
# lista de jornadas
# ---------------------------------------------------------------------------

@router.get("")
async def list_journeys(
    number_id: int | None = Query(default=None),
    status: str = Query(default="all"),  # all | lead | clicked | browsing
    q: str | None = Query(default=None),
    days: int = Query(default=30),
    limit: int = Query(default=80, le=300),
    session: AsyncSession = Depends(get_session),
):
    since = _since(days)
    agg = (
        select(
            TrackingEvent.transaction_id,
            func.min(TrackingEvent.event_time).label("started"),
            func.max(TrackingEvent.event_time).label("last"),
            func.count(TrackingEvent.id).label("events"),
        )
        .where(TrackingEvent.event_time >= since)
        .group_by(TrackingEvent.transaction_id)
    )
    agg = _scoped(agg, TrackingEvent, number_id)
    if q:
        like = f"%{q.strip()}%"
        agg = agg.where(
            or_(
                TrackingEvent.transaction_id.ilike(like),
                TrackingEvent.utm_campaign.ilike(like),
                TrackingEvent.utm_source.ilike(like),
                TrackingEvent.page_path.ilike(like),
                TrackingEvent.protocol.ilike(like),
            )
        )
    if status == "clicked":
        clicked = select(TrackingEvent.transaction_id).where(TrackingEvent.event_name == "click_whatsapp")
        agg = agg.where(TrackingEvent.transaction_id.in_(clicked))
    lead_tls = _scoped(select(Contact.transaction_id).where(Contact.transaction_id.is_not(None)), Contact, number_id)
    if status == "lead":
        agg = agg.where(TrackingEvent.transaction_id.in_(lead_tls))
    elif status == "browsing":
        agg = agg.where(TrackingEvent.transaction_id.not_in(lead_tls))

    heads = (await session.execute(agg.order_by(func.max(TrackingEvent.event_time).desc()).limit(limit))).all()
    tls = [h.transaction_id for h in heads]
    if not tls:
        return []

    events = (
        await session.execute(
            _scoped(select(TrackingEvent).where(TrackingEvent.transaction_id.in_(tls)), TrackingEvent, number_id)
        )
    ).scalars().all()
    grouped: dict[str, list[TrackingEvent]] = {}
    for e in events:
        grouped.setdefault(e.transaction_id, []).append(e)

    contacts = (
        await session.execute(_scoped(select(Contact).where(Contact.transaction_id.in_(tls)), Contact, number_id))
    ).scalars().all()
    by_tl = {c.transaction_id: c for c in contacts}

    out = []
    for tl in tls:
        summary = journey.summarize(grouped.get(tl, []))
        if not summary:
            continue
        out.append({**summary, "lead": _lead(by_tl.get(tl))})
    return out


# ---------------------------------------------------------------------------
# uma jornada
# ---------------------------------------------------------------------------

def _answers(summary: dict, lead: dict | None) -> list[dict]:
    """As sete perguntas que o framework promete responder."""
    first, last = summary.get("first_touch") or {}, summary.get("last_touch") or {}
    campaign = last.get("campaign") or first.get("campaign")
    clicks = summary.get("click_ids") or {}
    ids = ", ".join(f"{k}" for k in ("gclid", "gbraid", "wbraid", "fbclid", "fbc", "ttclid") if clicks.get(k))
    return [
        {"q": "Quem é esse visitante?", "a": summary.get("transaction_id"), "how": "Pelo TL_ID."},
        {"q": "De qual mídia ele veio?", "a": (summary.get("origin") or {}).get("label"), "how": "Last touch + click IDs."},
        {
            "q": "De qual campanha?",
            "a": campaign or (f"sem utm_campaign · {ids}" if ids else None),
            "how": "Pelas UTMs e identificadores das plataformas.",
        },
        {"q": "Qual foi a página de entrada?", "a": summary.get("landing_page"), "how": "Pela landing_page."},
        {
            "q": "Quais páginas ele navegou?",
            "a": " → ".join(summary.get("pages") or []) or None,
            "how": "Pelos eventos ligados ao mesmo transaction_id.",
        },
        {"q": "Quando clicou no WhatsApp?", "a": summary.get("clicked_whatsapp_at"), "how": "Pelo evento click_whatsapp."},
        {
            "q": "Qual conversa nasceu daquele clique?",
            "a": (lead or {}).get("name") or (lead or {}).get("phone_e164") or ((lead or {}).get("wa_id")),
            "how": "Pela associação do TL_ID com o lead recebido no WhatsApp.",
        },
    ]


async def _journey_payload(session: AsyncSession, tl: str, number_id: int | None, contact: Contact | None = None) -> dict:
    if number_id is not None:
        access.ensure_number(number_id)
    events = await journey.events_for(session, tl, number_id)
    # jornada de linha que o usuario nao ve nao aparece nem pelo TL_ID
    events = [e for e in events if access.can_see(e.wa_number_id)]
    if contact is None:
        contact = (
            await session.execute(
                _scoped(select(Contact).where(Contact.transaction_id == tl), Contact, number_id).order_by(Contact.id)
            )
        ).scalars().first()
    summary = journey.summarize(events) if events else {"transaction_id": tl, "events": 0}
    lead = _lead(contact)
    return {
        "summary": summary,
        "events": [journey.serialize_event(e) for e in events],
        "lead": lead,
        "answers": _answers(summary, lead),
    }


@router.get("/contact/{contact_id}")
async def contact_journey(contact_id: int, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    if not contact.transaction_id:
        return {"summary": None, "events": [], "lead": _lead(contact), "answers": []}
    return await _journey_payload(session, contact.transaction_id, contact.wa_number_id, contact)


class LinkIn(BaseModel):
    transaction_id: str = Field(min_length=8, max_length=64)


@router.post("/contact/{contact_id}/link")
async def link_contact(contact_id: int, payload: LinkIn, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    tl = payload.transaction_id.strip()
    if not journey.TL_ID_SHAPE.match(tl):
        raise HTTPException(status_code=422, detail="TL_ID em formato inválido.")
    await journey.link_manually(session, contact, tl)
    await session.commit()
    return await _journey_payload(session, tl, contact.wa_number_id, contact)


@router.delete("/contact/{contact_id}/link")
async def unlink_contact(contact_id: int, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    for field in ("transaction_id", "visitor_id", "session_id", "match_method", "match_score", "landing_page", "page_url"):
        setattr(contact, field, None)
    contact.first_utm, contact.last_utm = {}, {}
    await session.commit()
    return {"ok": True}


@router.get("/{tl}")
async def get_journey(
    tl: str, number_id: int | None = Query(default=None), session: AsyncSession = Depends(get_session)
):
    payload = await _journey_payload(session, tl, number_id)
    if not payload["events"] and payload["lead"] is None:
        raise HTTPException(status_code=404, detail="Jornada não encontrada.")
    return payload


# ---------------------------------------------------------------------------
# simulador: uma jornada inteira sem anuncio no ar
# ---------------------------------------------------------------------------

_PRESETS = {
    "google": {"utm": {"source": "google", "medium": "cpc", "campaign": "implante_dentario"}, "gclid": True},
    "meta": {"utm": {"source": "instagram", "medium": "paid_social", "campaign": "lancamento_studio"}, "fbclid": True},
    "tiktok": {"utm": {"source": "tiktok", "medium": "paid", "campaign": "video_depoimento"}, "ttclid": True},
    "organic": {"utm": {}, "referrer": "https://www.google.com/"},
    "direct": {"utm": {}},
}


class SimulateIn(BaseModel):
    number_id: int
    preset: str = "google"
    # como a conversa chega: com o tl na mensagem, com protocolo, ou sem nada (temporal)
    reference: str = "tl"  # tl | protocol | none
    send_message: bool = True
    # vazio = um numero novo a cada simulacao (o match temporal so vale pra conversa nova)
    wa_id: str | None = None
    name: str = "Maria (simulada)"
    message: str = "Olá! Quero saber mais sobre implante."
    host: str = "clinicastudiodental.com.br"


@router.post("/simulate")
async def simulate(payload: SimulateIn, session: AsyncSession = Depends(get_session)):
    from app.evolution_ingest import build_simulated_payload, ingest_event

    number = await _number(session, payload.number_id)
    preset = _PRESETS.get(payload.preset, _PRESETS["google"])
    now = datetime.now(timezone.utc)
    tl = f"{int(now.timestamp() * 1000)}_{int(now.timestamp() * 1000)}{secrets.randbelow(10)}"
    visitor = f"vsim{secrets.token_hex(4)}"
    sess = f"ssim{secrets.token_hex(4)}"
    protocol = "TL-" + "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
    utm = preset["utm"]
    clicks = {}
    if preset.get("gclid"):
        clicks["gclid"] = f"Cj0KCQsim{secrets.token_hex(6)}"
    if preset.get("fbclid"):
        clicks["fbclid"] = f"IwARsim{secrets.token_hex(6)}"
        clicks["fbc"] = f"fb.1.{int(now.timestamp() * 1000)}.{clicks['fbclid']}"
        clicks["fbp"] = f"fb.1.{int(now.timestamp() * 1000)}.{secrets.randbelow(10**9)}"
    if preset.get("ttclid"):
        clicks["ttclid"] = f"E.Csim{secrets.token_hex(6)}"

    base = f"https://{payload.host}"
    query = "&".join(f"utm_{k}={v}" for k, v in utm.items())
    query += "".join(f"&{k}={v}" for k, v in clicks.items() if k in ("gclid", "fbclid", "ttclid"))
    steps = [
        ("page_view", "/studio/", "Studio Dental — Implantes", 240, True),
        ("view_service", "/studio/servicos/implante", "Implante dentário", 170, False),
        ("page_view", "/studio/servicos/implante", "Implante dentário", 168, False),
        ("page_view", "/studio/contato", "Contato", 60, False),
        ("click_whatsapp", "/studio/contato", "Contato", 35, False),
    ]
    for name, path, title, ago, entry in steps:
        url = f"{base}{path}" + (f"?{query.lstrip('&')}&tl={tl}" if entry and query else f"?tl={tl}")
        data = {
            "tl": tl,
            "visitor_id": visitor,
            "session_id": sess,
            "event_name": name,
            "event_time": (now - timedelta(seconds=ago)).isoformat(),
            "page_url": url,
            "page_path": path,
            "page_title": title,
            "page_referrer": preset.get("referrer") if entry else f"{base}/studio/",
            "landing_page": "/studio/",
            "hostname": payload.host,
            "utm": utm if entry else {},
            "first_touch": utm,
            "last_touch": utm,
            "click_ids": clicks,
            "ga": {"client_id": "123456789.1790195601", "session_id": "1790195601", "session_number": "1"},
            "props": {"simulated": True, **({"service": "implante"} if name == "view_service" else {})},
            "protocol": protocol if name == "click_whatsapp" else None,
        }
        event = journey.build_event(number, data, "187.0.0.1", "Mozilla/5.0 (simulado)")
        session.add(event)
    await session.commit()

    result: dict = {"transaction_id": tl, "protocol": protocol}
    if payload.send_message:
        text = payload.message
        if payload.reference == "tl":
            text = f"{text}\n\ntl={tl}"
        elif payload.reference == "protocol":
            text = f"{text}\n\nProtocolo: {protocol}"
        fake = build_simulated_payload(
            instance=number.evo_instance or "simulado",
            wa_id="".join(c for c in (payload.wa_id or "") if c.isdigit())
            or f"55119{secrets.randbelow(10**8):08d}",
            name=payload.name,
            text=text,
            ctwa_clid=None,
            ad_id=None,
            source_url=None,
        )
        ingest = await ingest_event(session, fake, number)
        result["contact_ids"] = ingest.get("contact_ids") or []
        result["summary"] = ingest.get("summary")
    return result
