"""Webhook da WhatsApp Cloud API.

GET  /webhook/whatsapp        -> handshake de verificacao da Meta (hub.challenge)
POST /webhook/whatsapp        -> recebimento das mensagens de QUALQUER numero
GET/POST /webhook/whatsapp/{n}-> mesma coisa, com URL dedicada a um numero

Duas URLs porque ha dois jeitos de montar isso na Meta: varios numeros no mesmo
app (uma URL so, roteada pelo `metadata.phone_number_id` do payload) ou um app
por cliente (URL propria, com verify token e app secret so daquele numero).

A assinatura autoriza POR LINHA, nunca o payload inteiro: cada change so e gravado
se o X-Hub-Signature-256 bater com o segredo da linha de destino dele. Sem isso, quem
conhecesse o app secret de um cliente poderia escrever na base de outro — o destino de
cada change vem do proprio payload.

A Meta reentrega o payload se a gente nao responder 200 rapido. Por isso qualquer
erro de processamento e logado e a resposta continua 200 — reentrega infinita do
mesmo payload quebrado nao ajuda ninguem.
"""

import json
import logging

from fastapi import APIRouter, Depends, Header, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app import numbers, settings_store
from app.db import get_session
from app.ingest import ingest_payload, payload_phone_number_ids
from app.models import WaNumber
from app.services import whatsapp_cloud

log = logging.getLogger("webhook")
router = APIRouter(prefix="/webhook", tags=["webhook"])


async def _verify_response(session: AsyncSession, request: Request, number: WaNumber | None) -> Response:
    """Handshake. Sem numero na URL, o token de QUALQUER linha ativa serve."""
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge", "")

    if mode != "subscribe" or not token:
        return Response(content="verify token invalido", status_code=403, media_type="text/plain")

    if number is not None:
        accepted = {number.verify_token} if number.verify_token else set()
    else:
        accepted = {n.verify_token for n in await numbers.list_numbers(session) if n.verify_token}
    global_cfg = await settings_store.load(session)
    if global_cfg.get("wa_verify_token"):
        accepted.add(global_cfg["wa_verify_token"])

    if token in accepted:
        return Response(content=challenge, media_type="text/plain")
    return Response(content="verify token invalido", status_code=403, media_type="text/plain")


def _secret_of(number: WaNumber | None, global_cfg: dict) -> str:
    """Segredo que autoriza escrever nessa linha: o dela, ou o global como base."""
    own = (number.app_secret if number is not None else None) or ""
    return own or (global_cfg.get("wa_app_secret") or "")


async def _authorize(
    session: AsyncSession, raw: bytes, header: str | None, route_number: WaNumber | None
) -> tuple[set[str], list[str]]:
    """Decide, linha por linha, o que essa requisicao pode gravar.

    A autorizacao e POR DESTINO, nao pelo payload inteiro: cada change so entra se a
    assinatura bater com o segredo da linha em que ele seria escrito. Validar contra
    "qualquer" segredo citado no payload deixaria quem conhece o app secret de um
    cliente forjar leads e atribuicao na base de outro — o payload traz o
    `phone_number_id` de destino, e quem o escreve e quem assina.

    Linha sem app secret (nem proprio, nem global) segue sem validacao, como sempre
    foi no modo de numero unico; a diferenca e que essa leniencia agora vale so pra
    ELA, e nao serve de porta pra escrever nas outras.

    Devolve (linhas liberadas, linhas barradas).
    """
    global_cfg = await settings_store.load(session)
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        payload = {}

    keys = payload_phone_number_ids(payload)
    fallback = route_number or await numbers.get_default(session)

    if not keys:
        # nada endereçado (payload de status, teste do painel): valida contra a linha
        # da URL, ou o global, e nao libera escrita nenhuma
        secret = _secret_of(fallback, global_cfg)
        ok = not secret or whatsapp_cloud.verify_signature({"wa_app_secret": secret}, raw, header)
        return (set(), [] if ok else ["payload sem metadata"])

    allowed: set[str] = set()
    denied: list[str] = []

    for key in keys:
        target = await numbers.by_phone_number_id(session, key) if key else None

        # URL exclusiva de uma linha nao grava na base de outra, mesmo assinada
        if route_number is not None and target is not None and target.id != route_number.id:
            denied.append(key)
            continue

        line = target or fallback
        secret = _secret_of(line, global_cfg)
        if not secret:
            allowed.add(key)
        elif whatsapp_cloud.verify_signature({"wa_app_secret": secret}, raw, header):
            allowed.add(key)
        else:
            denied.append(key or "sem metadata")

    return allowed, denied


async def _receive(
    session: AsyncSession, request: Request, header: str | None, number: WaNumber | None
) -> dict | Response:
    raw = await request.body()

    try:
        payload = json.loads(raw)
    except ValueError:
        log.warning("webhook com corpo nao-JSON")
        return {"received": True, "ignored": "corpo invalido"}

    allowed, denied = await _authorize(session, raw, header, number)
    if denied:
        log.warning("assinatura invalida para a(s) linha(s) %s", ", ".join(denied))
    if not allowed:
        # nada nesse payload provou de quem e — 401 em vez de 200 pra Meta reentregar
        # se for problema transitorio de configuracao.
        return Response(status_code=401, content="assinatura invalida")

    fallback = number or await numbers.get_default(session)
    try:
        result = await ingest_payload(
            session, payload, fallback_number=fallback, allowed_phone_number_ids=allowed
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("falha ao processar webhook")
        await session.rollback()
        return {"received": True, "error": str(exc)}

    return {"received": True, **result}


@router.get("/whatsapp")
async def verify(request: Request, session: AsyncSession = Depends(get_session)):
    return await _verify_response(session, request, None)


@router.post("/whatsapp")
async def receive(
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
):
    return await _receive(session, request, x_hub_signature_256, None)


@router.get("/whatsapp/{number_id}")
async def verify_for_number(
    number_id: int, request: Request, session: AsyncSession = Depends(get_session)
):
    number = await session.get(WaNumber, number_id)
    if number is None:
        return Response(content="numero nao encontrado", status_code=404, media_type="text/plain")
    return await _verify_response(session, request, number)


@router.post("/whatsapp/{number_id}")
async def receive_for_number(
    number_id: int,
    request: Request,
    x_hub_signature_256: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
):
    number = await session.get(WaNumber, number_id)
    if number is None:
        return Response(content="numero nao encontrado", status_code=404, media_type="text/plain")
    return await _receive(session, request, x_hub_signature_256, number)
