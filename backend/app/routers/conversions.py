"""Disparo e historico dos eventos de conversao."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import settings_store
from app.db import get_session
from app.models import Contact, Conversion
from app.services.dispatch import ALL_DESTINATIONS, dispatch_conversion, enabled_destinations

router = APIRouter(prefix="/api", tags=["conversions"])


def serialize_dispatch(d) -> dict:
    return {
        "id": d.id,
        "destination": d.destination,
        "status": d.status,
        "http_status": d.http_status,
        "error": d.error,
        "request_payload": d.request_payload,
        "response_body": d.response_body,
        "created_at": d.created_at,
    }


def serialize_conversion(c: Conversion, contact: Contact | None = None) -> dict:
    out = {
        "id": c.id,
        "contact_id": c.contact_id,
        "event_name": c.event_name,
        "event_id": c.event_id,
        "value": c.value,
        "currency": c.currency,
        "note": c.note,
        "is_test": c.is_test,
        "created_at": c.created_at,
        "dispatches": [serialize_dispatch(d) for d in (c.dispatches or [])],
    }
    if contact is not None:
        out["contact"] = {"id": contact.id, "wa_id": contact.wa_id, "name": contact.name}
    return out


class ConversionIn(BaseModel):
    contact_id: int
    event_name: str | None = None
    value: float | None = None
    currency: str | None = None
    note: str | None = None
    is_test: bool = True
    destinations: list[str] = Field(default_factory=list)


@router.get("/conversions")
async def list_conversions(limit: int = Query(default=100, le=500), session: AsyncSession = Depends(get_session)):
    rows = (
        (
            await session.execute(
                select(Conversion)
                .options(selectinload(Conversion.dispatches), selectinload(Conversion.contact))
                .order_by(desc(Conversion.id))
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [serialize_conversion(c, c.contact) for c in rows]


@router.post("/conversions")
async def create_conversion(payload: ConversionIn, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, payload.contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Contato nao encontrado.")

    cfg = await settings_store.load(session)
    invalid = [d for d in payload.destinations if d not in ALL_DESTINATIONS]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Destino invalido: {', '.join(invalid)}")

    targets = payload.destinations or enabled_destinations(cfg)
    if not targets:
        raise HTTPException(
            status_code=400,
            detail="Nenhum destino habilitado. Ative ao menos um em Configuracoes ou escolha na hora do disparo.",
        )

    conv = Conversion(
        contact_id=contact.id,
        event_name=payload.event_name or cfg.get("default_event_name") or "Lead",
        event_id=f"wa-{contact.id}-{uuid.uuid4().hex[:12]}",
        value=payload.value,
        currency=payload.currency or cfg.get("default_currency") or "BRL",
        note=payload.note,
        is_test=payload.is_test,
    )
    session.add(conv)
    await session.commit()
    await session.refresh(conv)

    await dispatch_conversion(session, cfg, conv, contact, targets)

    refreshed = (
        await session.execute(
            select(Conversion).options(selectinload(Conversion.dispatches)).where(Conversion.id == conv.id)
        )
    ).scalar_one()
    return serialize_conversion(refreshed, contact)


@router.post("/conversions/{conversion_id}/retry")
async def retry_conversion(
    conversion_id: int,
    destinations: list[str] | None = None,
    session: AsyncSession = Depends(get_session),
):
    """Reenvia a MESMA conversao (mesmo event_id) — o Meta deduplica pelo event_id."""
    conv = (
        await session.execute(
            select(Conversion).options(selectinload(Conversion.dispatches)).where(Conversion.id == conversion_id)
        )
    ).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversao nao encontrada.")

    contact = await session.get(Contact, conv.contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Contato da conversao nao existe mais.")

    cfg = await settings_store.load(session)
    targets = destinations or [d.destination for d in conv.dispatches if d.status == "error"] or None
    await dispatch_conversion(session, cfg, conv, contact, targets)

    refreshed = (
        await session.execute(
            select(Conversion).options(selectinload(Conversion.dispatches)).where(Conversion.id == conv.id)
        )
    ).scalar_one()
    return serialize_conversion(refreshed, contact)


@router.post("/conversions/preview")
async def preview_conversion(payload: ConversionIn, session: AsyncSession = Depends(get_session)):
    """Monta os payloads sem enviar nada — pra conferir o que sairia."""
    contact = await session.get(Contact, payload.contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Contato nao encontrado.")

    cfg = await settings_store.load(session)
    from datetime import datetime, timezone

    from app.services import google_ads, meta_capi
    from app.tracking import to_e164

    event_name = payload.event_name or cfg.get("default_event_name") or "Lead"
    currency = payload.currency or cfg.get("default_currency") or "BRL"
    event_id = "preview-nao-enviado"
    previews: dict = {}

    try:
        previews["meta_capi"] = meta_capi.build_payload(
            event_name=event_name,
            event_id=event_id,
            ctwa_clid=contact.ctwa_clid,
            phone=contact.phone_e164 or to_e164(contact.wa_id),
            value=payload.value,
            currency=currency,
            test_event_code=(cfg.get("meta_test_event_code") or None) if payload.is_test else None,
        )
    except Exception as exc:  # noqa: BLE001
        previews["meta_capi"] = {"error": str(exc)}

    try:
        previews["google_ads"] = google_ads.build_payload(
            cfg,
            gclid=contact.gclid,
            wbraid=contact.wbraid,
            gbraid=contact.gbraid,
            value=payload.value,
            currency=currency,
            when=datetime.now(timezone.utc),
        )
    except Exception as exc:  # noqa: BLE001
        previews["google_ads"] = {"error": str(exc)}

    previews["webhook"] = {
        "event_name": event_name,
        "contact": {"wa_id": contact.wa_id, "name": contact.name},
        "attribution": {"ctwa_clid": contact.ctwa_clid, "gclid": contact.gclid, "ad_id": contact.source_id},
    }
    return previews
