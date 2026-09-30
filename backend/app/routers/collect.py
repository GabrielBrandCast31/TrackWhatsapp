"""Coletor publico da tag do site: `/t/tl.js` e `/t/collect`.

Publico de proposito — quem chama e o navegador de qualquer visitante do site do
cliente. A `k` (site_key) nao e segredo: so diz de qual linha e a jornada. O pior
que alguem com ela consegue e gravar evento falso de navegacao, que nao dispara
conversao nenhuma sozinho (a conversao continua saindo da conversa no WhatsApp).

O corpo chega como `text/plain` (sendBeacon / fetch no-cors): assim o navegador
nao faz preflight de CORS e o evento sai mesmo quando a pessoa ja esta saindo da
pagina pro WhatsApp.
"""

import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import journey
from app.db import get_session
from app.models import WaNumber

log = logging.getLogger(__name__)
router = APIRouter(prefix="/t", tags=["tag"])

_TAG = (Path(__file__).resolve().parent.parent / "static" / "tl.js").read_text(encoding="utf-8")
_MAX_BODY = 64 * 1024
_MAX_BATCH = 20


def client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.headers.get("x-real-ip") or (request.client.host if request.client else None)


@router.get("/tl.js", include_in_schema=False)
async def tag(k: str = Query(default="")):
    body = _TAG.replace("__SITE_KEY__", "".join(c for c in k if c.isalnum())[:32])
    return Response(
        body,
        media_type="application/javascript; charset=utf-8",
        headers={"Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*"},
    )


async def _number_for(session: AsyncSession, key: str | None) -> WaNumber | None:
    if not key:
        return None
    return (await session.execute(select(WaNumber).where(WaNumber.site_key == key))).scalars().first()


@router.options("/collect", include_in_schema=False)
async def collect_preflight():
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
        },
    )


@router.post("/collect", include_in_schema=False)
async def collect(request: Request, session: AsyncSession = Depends(get_session)):
    raw = await request.body()
    headers = {"Access-Control-Allow-Origin": "*"}
    if not raw or len(raw) > _MAX_BODY:
        return Response(status_code=204, headers=headers)
    try:
        data = json.loads(raw)
    except ValueError:
        return Response(status_code=204, headers=headers)

    items = data.get("events") if isinstance(data, dict) and isinstance(data.get("events"), list) else [data]
    items = [i for i in items[:_MAX_BATCH] if isinstance(i, dict)]
    if not items:
        return Response(status_code=204, headers=headers)

    number = await _number_for(session, items[0].get("k") or request.query_params.get("k"))
    if number is None:
        # chave desconhecida: evento de site que nao e de linha nenhuma daqui
        return Response(status_code=204, headers=headers)

    ip = client_ip(request)
    ua = request.headers.get("user-agent")
    stored = 0
    for item in items:
        event = journey.build_event(number, item, ip, ua)
        if event is None:
            continue
        # o navegador pode reenviar o mesmo beacon: event_id e a chave de dedupe
        if event.event_id:
            dup = await session.execute(
                select(journey.TrackingEvent.id).where(journey.TrackingEvent.event_id == event.event_id)
            )
            if dup.scalar_one_or_none() is not None:
                continue
        session.add(event)
        stored += 1
    if stored:
        await session.commit()
    return Response(status_code=204, headers=headers)
