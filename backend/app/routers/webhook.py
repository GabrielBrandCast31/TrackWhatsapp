"""Webhook da WhatsApp Cloud API.

GET  /webhook/whatsapp  -> handshake de verificacao da Meta (hub.challenge)
POST /webhook/whatsapp  -> recebimento das mensagens

A Meta reentrega o payload se a gente nao responder 200 rapido. Por isso qualquer
erro de processamento e logado e a resposta continua 200 — reentrega infinita do
mesmo payload quebrado nao ajuda ninguem.
"""

import logging

from fastapi import APIRouter, Depends, Header, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app import settings_store
from app.db import get_session
from app.ingest import ingest_payload
from app.services import whatsapp_cloud

log = logging.getLogger("webhook")
router = APIRouter(prefix="/webhook", tags=["webhook"])


@router.get("/whatsapp")
async def verify(request: Request, session: AsyncSession = Depends(get_session)):
    cfg = await settings_store.load(session)
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge", "")

    if mode == "subscribe" and token and token == cfg.get("wa_verify_token"):
        return Response(content=challenge, media_type="text/plain")
    return Response(content="verify token invalido", status_code=403, media_type="text/plain")


@router.post("/whatsapp")
async def receive(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
):
    raw = await request.body()
    cfg = await settings_store.load(session)

    if not whatsapp_cloud.verify_signature(cfg, raw, x_hub_signature_256):
        log.warning("assinatura do webhook invalida")
        return Response(status_code=401, content="assinatura invalida")

    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        log.warning("webhook com corpo nao-JSON")
        return {"received": True, "ignored": "corpo invalido"}

    try:
        result = await ingest_payload(session, payload)
    except Exception as exc:  # noqa: BLE001
        log.exception("falha ao processar webhook")
        await session.rollback()
        return {"received": True, "error": str(exc)}

    return {"received": True, **result}
