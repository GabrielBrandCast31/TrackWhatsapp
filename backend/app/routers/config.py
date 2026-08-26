"""Configuracao GLOBAL + status da conexao com o WhatsApp.

Depois do multi-numero, as credenciais da Cloud API vivem em `wa_numbers` (veja
`routers/numbers.py`). O que sobra aqui e a config que serve de base pra todas as
linhas: Apify, prospeccao e os destinos padrao que um numero herda quando nao
sobrescreve nada. As rotas de conexao continuam existindo e agora aceitam
`?number_id=` — sem ele, agem sobre o numero padrao.
"""

import os

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app import numbers as numbers_service
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
    default = await numbers_service.get_default(session)
    return {
        "config": settings_store.mask(cfg),
        # URL unica: serve todas as linhas, roteada pelo phone_number_id do payload
        "webhook_url": f"{PUBLIC_BASE_URL.rstrip('/')}/webhook/whatsapp",
        "enabled_destinations": enabled_destinations(cfg),
        "default_number_id": default.id if default else None,
        "overridable_fields": list(numbers_service.OVERRIDABLE),
    }


@router.put("/config")
async def put_config(patch: ConfigPatch, session: AsyncSession = Depends(get_session)):
    cfg = await settings_store.save(session, patch.model_dump())
    return {
        "config": settings_store.mask(cfg),
        "enabled_destinations": enabled_destinations(cfg),
    }


@router.get("/connection/status")
async def connection_status(
    number_id: int | None = Query(default=None), session: AsyncSession = Depends(get_session)
):
    """Compatibilidade: status do numero pedido, ou do padrao."""
    from app.routers.numbers import number_status

    number = await _number_or_400(session, number_id)
    return await number_status(number.id, session)


@router.post("/connection/subscribe")
async def connection_subscribe(
    number_id: int | None = Query(default=None), session: AsyncSession = Depends(get_session)
):
    number = await _number_or_400(session, number_id)
    cfg = numbers_service.effective_cfg(await settings_store.load(session), number)
    try:
        return await whatsapp_cloud.subscribe_app(cfg)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class SendTest(BaseModel):
    to: str
    body: str = "Teste de conexao da plataforma de trackeamento."


@router.post("/connection/send-test")
async def connection_send_test(
    payload: SendTest,
    number_id: int | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    """Manda uma mensagem de verdade — so funciona dentro da janela de 24h."""
    number = await _number_or_400(session, number_id)
    cfg = numbers_service.effective_cfg(await settings_store.load(session), number)
    try:
        return await whatsapp_cloud.send_text(cfg, payload.to, payload.body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _number_or_400(session: AsyncSession, number_id: int | None):
    try:
        return await numbers_service.require(session, number_id)
    except numbers_service.NumberError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
