"""Leads capturados do WhatsApp, com a atribuicao de origem."""

import csv
import io
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import numbers as numbers_service
from app import access
from app import campaigns as campaigns_service
from app.db import get_session
from app.ingest import build_simulated_payload, ingest_payload
from app.models import Contact, Conversion, Message, WaNumber, WebhookLog

router = APIRouter(prefix="/api", tags=["contacts"])


def serialize_contact(c: Contact, conversions: int = 0) -> dict:
    return {
        "id": c.id,
        "wa_id": c.wa_id,
        "wa_number_id": c.wa_number_id,
        "phone_e164": c.phone_e164,
        "name": c.name,
        "first_message": c.first_message,
        "created_at": c.created_at,
        "last_seen_at": c.last_seen_at,
        "conversions": conversions,
        "attribution": {
            "ctwa_clid": c.ctwa_clid,
            "ad_id": c.source_id,
            "source_type": c.source_type,
            "source_url": c.source_url,
            "ad_headline": c.ad_headline,
            "ad_body": c.ad_body,
            "gclid": c.gclid,
            "wbraid": c.wbraid,
            "gbraid": c.gbraid,
            "utm": c.utm or {},
        },
        "attributable_meta": bool(c.ctwa_clid),
        "attributable_google": bool(c.gclid or c.wbraid or c.gbraid),
    }


@router.get("/contacts")
async def list_contacts(
    only_attributed: bool = Query(default=False),
    number_id: int | None = Query(default=None, description="filtra pela linha de WhatsApp"),
    limit: int = Query(default=100, le=500),
    session: AsyncSession = Depends(get_session),
):
    counts = dict(
        (await session.execute(select(Conversion.contact_id, func.count()).group_by(Conversion.contact_id))).all()
    )
    stmt = select(Contact).order_by(desc(Contact.last_seen_at)).limit(limit)
    stmt = access.scope(stmt, Contact.wa_number_id, number_id)
    if only_attributed:
        stmt = stmt.where(
            (Contact.ctwa_clid.is_not(None))
            | (Contact.gclid.is_not(None))
            | (Contact.wbraid.is_not(None))
            | (Contact.gbraid.is_not(None))
        )
    rows = (await session.execute(stmt)).scalars().all()
    return [serialize_contact(c, counts.get(c.id, 0)) for c in rows]


# canais que contam como "veio de campanha" (`campaigns.lead_source`)
CAMPAIGN_CHANNELS = ("meta_ads", "google_ads", "utm")

CAMPAIGN_CSV_COLUMNS = [
    "telefone", "nome", "canal", "plataforma", "campanha", "conjunto", "anuncio",
    "titulo_anuncio", "utm_source", "utm_medium", "utm_campaign", "utm_content",
    "primeira_mensagem", "linha", "etapa", "chegou_em",
]


def _csv_safe(value) -> str:
    """Texto livre (nome, mensagem do lead) nao pode virar formula no Excel/Sheets."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def _lead_phone(c: Contact) -> str:
    """Telefone em E.164; sem ele, o wa_id quando e telefone (LID nao e numero)."""
    if c.phone_e164:
        return c.phone_e164
    wa = (c.wa_id or "").strip()
    return f"+{wa}" if wa.isdigit() else ""


@router.get("/contacts/campaign-leads.csv")
async def export_campaign_leads(
    number_id: int | None = Query(default=None, description="filtra pela linha de WhatsApp"),
    channel: list[str] | None = Query(default=None, description="meta_ads | google_ads | utm (padrão: todos)"),
    campaign: str | None = Query(default=None, description="trecho do nome da campanha"),
    date_from: date | None = Query(default=None, description="chegou a partir de (AAAA-MM-DD)"),
    date_to: date | None = Query(default=None, description="chegou até (AAAA-MM-DD, inclusive)"),
    unique: bool = Query(default=True, description="um telefone por linha do arquivo"),
    session: AsyncSession = Depends(get_session),
):
    """Leads que chamaram no WhatsApp vindos de campanha (Meta Ads, Google Ads ou link com UTM).

    Separado por `;` e com BOM, para abrir direto no Excel em português.
    """
    channels = set(channel or CAMPAIGN_CHANNELS) & set(CAMPAIGN_CHANNELS)
    if not channels:
        raise HTTPException(status_code=422, detail=f"canal inválido; use {', '.join(CAMPAIGN_CHANNELS)}")

    stmt = select(Contact).where(Contact.origin != "simulado").order_by(Contact.created_at)
    stmt = access.scope(stmt, Contact.wa_number_id, number_id)
    if date_from:
        stmt = stmt.where(Contact.created_at >= datetime.combine(date_from, time.min, tzinfo=timezone.utc))
    if date_to:
        stmt = stmt.where(
            Contact.created_at < datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=timezone.utc)
        )
    rows = (await session.execute(stmt)).scalars().all()

    known = await campaigns_service.campaigns_for(session, (c.source_id for c in rows))
    labels = dict((await session.execute(select(WaNumber.id, WaNumber.label))).all())
    needle = (campaign or "").strip().lower()

    buf = io.StringIO()
    buf.write("﻿")
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(CAMPAIGN_CSV_COLUMNS)
    seen: set[str] = set()
    for c in rows:
        src = campaigns_service.lead_source(c, known.get(c.source_id or ""))
        if src["channel"] not in channels:
            continue
        if needle and needle not in (src["campaign_name"] or "").lower():
            continue
        phone = _lead_phone(c)
        if not phone:
            continue
        if unique:
            if phone in seen:
                continue
            seen.add(phone)
        utm = src["utm"] or {}
        writer.writerow([phone] + [_csv_safe(v) for v in (
            c.name,
            src["channel_label"],
            src["platform_label"],
            src["campaign_name"],
            src["adset_name"],
            src["ad_name"] or src["ad_id"],
            src["ad_headline"],
            utm.get("utm_source"),
            utm.get("utm_medium"),
            utm.get("utm_campaign"),
            utm.get("utm_content"),
            (c.first_message or "").replace("\r", " ").replace("\n", " "),
            labels.get(c.wa_number_id),
            c.stage,
            c.created_at.strftime("%d/%m/%Y %H:%M") if c.created_at else "",
        )])

    filename = f"leads-campanha-{datetime.now().strftime('%Y%m%d-%H%M')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/contacts/{contact_id}")
async def get_contact(contact_id: int, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)

    msgs = (
        (
            await session.execute(
                select(Message).where(Message.contact_id == contact_id).order_by(Message.sent_at).limit(200)
            )
        )
        .scalars()
        .all()
    )
    convs = (
        (
            await session.execute(
                select(Conversion)
                .options(selectinload(Conversion.dispatches))
                .where(Conversion.contact_id == contact_id)
                .order_by(desc(Conversion.created_at))
            )
        )
        .scalars()
        .all()
    )

    from app.routers.conversions import serialize_conversion

    return {
        **serialize_contact(contact, len(convs)),
        "messages": [
            {
                "id": m.id,
                "direction": m.direction,
                "type": m.msg_type,
                "body": m.body,
                "sent_at": m.sent_at,
                "wamid": m.wamid,
                # payload cru so sob demanda, em /api/crm/messages/{id}/payload
                "has_payload": bool(m.raw) or m.webhook_log_id is not None,
            }
            for m in msgs
        ],
        "conversion_events": [serialize_conversion(c) for c in convs],
    }


class SimulateIn(BaseModel):
    wa_id: str = "5511999998888"
    name: str = "Lead de Teste"
    text: str = "Ola! Vim pelo anuncio."
    ctwa_clid: str | None = "ARAySIMULADOclid1234567890"
    ad_id: str | None = "120210000000000000"
    source_url: str | None = "https://fb.me/simulado?utm_source=meta&utm_campaign=teste"
    number_id: int | None = None


@router.post("/contacts/simulate")
async def simulate_inbound(
    payload: SimulateIn,
    number_id: int | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    """Injeta um payload identico ao da Meta — testa o fluxo inteiro sem anuncio no ar."""
    try:
        access.ensure_number(number_id or payload.number_id)
        number = await numbers_service.require(session, number_id or payload.number_id)
    except numbers_service.NumberError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    fake = build_simulated_payload(
        wa_id=payload.wa_id,
        name=payload.name,
        text=payload.text,
        ctwa_clid=payload.ctwa_clid,
        ad_id=payload.ad_id,
        source_url=payload.source_url,
        phone_number_id=number.phone_number_id or "SIMULATED",
    )
    result = await ingest_payload(session, fake, fallback_number=number)
    return {"simulated": True, "wa_number_id": number.id, **result}


@router.get("/webhook-logs")
async def webhook_logs(
    number_id: int | None = Query(default=None),
    limit: int = Query(default=25, le=100),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(WebhookLog).order_by(desc(WebhookLog.id)).limit(limit)
    stmt = access.scope(stmt, WebhookLog.wa_number_id, number_id)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        {
            "id": r.id,
            "summary": r.summary,
            "created_at": r.created_at,
            "wa_number_id": r.wa_number_id,
            "phone_number_id": r.phone_number_id,
            "payload": r.payload,
        }
        for r in rows
    ]
