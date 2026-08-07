"""Configuracao + status da conexao com o WhatsApp."""

import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app import settings_store
from app.db import get_session
from app.services import whatsapp_cloud
from app.services.dispatch import enabled_destinations

router = APIRouter(prefix="/api", tags=["config"])

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000")


class ConfigPatch(BaseModel):
    model_config = {"extra": "allow"}


@router.get("/config")
async def get_config(session: AsyncSession = Depends(get_session)):
    cfg = await settings_store.load(session)
    return {
        "config": settings_store.mask(cfg),
        "webhook_url": f"{PUBLIC_BASE_URL.rstrip('/')}/webhook/whatsapp",
        "enabled_destinations": enabled_destinations(cfg),
    }


@router.put("/config")
async def put_config(patch: ConfigPatch, session: AsyncSession = Depends(get_session)):
    cfg = await settings_store.save(session, patch.model_dump())
    return {
        "config": settings_store.mask(cfg),
        "enabled_destinations": enabled_destinations(cfg),
    }


@router.get("/connection/status")
async def connection_status(session: AsyncSession = Depends(get_session)):
    """Bate na Graph API pra provar que o token e o numero estao valendo."""
    cfg = await settings_store.load(session)
    out: dict = {
        "configured": bool(cfg.get("wa_access_token") and cfg.get("wa_phone_number_id")),
        "connected": False,
        "phone_number": None,
        "subscribed_apps": [],
        "errors": [],
    }
    if not out["configured"]:
        out["errors"].append("Preencha o Access Token e o Phone Number ID em Configuracoes.")
        return out

    try:
        info = await whatsapp_cloud.phone_number_info(cfg)
        out["phone_number"] = info
        out["connected"] = True
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"Numero: {exc}")

    if cfg.get("wa_business_account_id"):
        try:
            subs = await whatsapp_cloud.subscribed_apps(cfg)
            out["subscribed_apps"] = subs.get("data", [])
            if not out["subscribed_apps"]:
                out["errors"].append(
                    "Nenhum app assinado nos webhooks do WABA — clique em 'Assinar webhooks'."
                )
        except Exception as exc:  # noqa: BLE001
            out["errors"].append(f"Webhooks: {exc}")
    else:
        out["errors"].append("WABA ID nao configurado — nao da pra checar a assinatura do webhook.")

    return out


@router.post("/connection/subscribe")
async def connection_subscribe(session: AsyncSession = Depends(get_session)):
    cfg = await settings_store.load(session)
    try:
        return await whatsapp_cloud.subscribe_app(cfg)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class SendTest(BaseModel):
    to: str
    body: str = "Teste de conexao da plataforma de trackeamento."


@router.post("/connection/send-test")
async def connection_send_test(payload: SendTest, session: AsyncSession = Depends(get_session)):
    """Manda uma mensagem de verdade — so funciona dentro da janela de 24h."""
    cfg = await settings_store.load(session)
    try:
        return await whatsapp_cloud.send_text(cfg, payload.to, payload.body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
