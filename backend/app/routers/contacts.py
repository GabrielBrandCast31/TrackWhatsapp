"""Leads capturados do WhatsApp, com a atribuicao de origem."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import settings_store
from app.db import get_session
from app.ingest import build_simulated_payload, ingest_payload
from app.models import Contact, Conversion, Message, WebhookLog

router = APIRouter(prefix="/api", tags=["contacts"])


def serialize_contact(c: Contact, conversions: int = 0) -> dict:
    return {
        "id": c.id,
        "wa_id": c.wa_id,
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
    limit: int = Query(default=100, le=500),
    session: AsyncSession = Depends(get_session),
):
    counts = dict(
        (await session.execute(select(Conversion.contact_id, func.count()).group_by(Conversion.contact_id))).all()
    )
    stmt = select(Contact).order_by(desc(Contact.last_seen_at)).limit(limit)
    if only_attributed:
        stmt = stmt.where(
            (Contact.ctwa_clid.is_not(None))
            | (Contact.gclid.is_not(None))
            | (Contact.wbraid.is_not(None))
            | (Contact.gbraid.is_not(None))
        )
    rows = (await session.execute(stmt)).scalars().all()
    return [serialize_contact(c, counts.get(c.id, 0)) for c in rows]


@router.get("/contacts/{contact_id}")
async def get_contact(contact_id: int, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Contato nao encontrado.")

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


@router.post("/contacts/simulate")
async def simulate_inbound(payload: SimulateIn, session: AsyncSession = Depends(get_session)):
    """Injeta um payload identico ao da Meta — testa o fluxo inteiro sem anuncio no ar."""
    cfg = await settings_store.load(session)
    fake = build_simulated_payload(
        wa_id=payload.wa_id,
        name=payload.name,
        text=payload.text,
        ctwa_clid=payload.ctwa_clid,
        ad_id=payload.ad_id,
        source_url=payload.source_url,
        phone_number_id=cfg.get("wa_phone_number_id") or "SIMULATED",
    )
    result = await ingest_payload(session, fake)
    return {"simulated": True, **result}


@router.get("/webhook-logs")
async def webhook_logs(limit: int = Query(default=25, le=100), session: AsyncSession = Depends(get_session)):
    rows = (
        (await session.execute(select(WebhookLog).order_by(desc(WebhookLog.id)).limit(limit))).scalars().all()
    )
    return [{"id": r.id, "summary": r.summary, "created_at": r.created_at, "payload": r.payload} for r in rows]
