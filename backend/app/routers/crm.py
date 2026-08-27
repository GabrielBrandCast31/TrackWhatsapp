"""CRM por linha: as conversas daquele numero, com etapa, nota e disparo.

O registro do CRM e a propria conversa (`contacts`) — nao existe uma tabela de
"card" paralela que pudesse divergir do que aconteceu no chat. Quem chegou pelo
anuncio, quem chegou sozinho e quem veio do historico da instancia aparecem na
mesma lista, distinguidos por `origin` e pela atribuicao.

As tres visualizacoes da tela (kanban, lista e caixa de entrada) consomem os
MESMOS endpoints: o que muda e a ordenacao e o que cada uma pede de detalhe.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import crm as crm_service
from app import numbers as numbers_service
from app import settings_store
from app.db import get_session
from app.models import CONTACT_STAGES, Contact, Conversion, Message, WaNumber
from app.services import evolution

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/crm", tags=["crm"])

STAGE_LABELS = {
    "novo": "Novo",
    "atendendo": "Atendendo",
    "qualificado": "Qualificado",
    "ganho": "Ganho",
    "perdido": "Perdido",
}


def serialize(contact: Contact, conversions: int = 0) -> dict:
    return {
        "id": contact.id,
        "wa_id": contact.wa_id,
        "wa_number_id": contact.wa_number_id,
        "phone_e164": contact.phone_e164,
        "name": contact.name,
        "profile_pic_url": contact.profile_pic_url,
        "stage": contact.stage,
        "note": contact.note,
        "origin": contact.origin,
        "unread_count": contact.unread_count or 0,
        "last_message_at": contact.last_message_at,
        "last_message_body": contact.last_message_body,
        "last_message_from_me": contact.last_message_from_me,
        "first_message": contact.first_message,
        "created_at": contact.created_at,
        "last_seen_at": contact.last_seen_at,
        "synced_at": contact.synced_at,
        "conversions": conversions,
        "attribution": {
            "ctwa_clid": contact.ctwa_clid,
            "ad_id": contact.source_id,
            "source_type": contact.source_type,
            "source_url": contact.source_url,
            "ad_headline": contact.ad_headline,
            "ad_body": contact.ad_body,
            "gclid": contact.gclid,
            "wbraid": contact.wbraid,
            "gbraid": contact.gbraid,
            "utm": contact.utm or {},
        },
        "attributable_meta": bool(contact.ctwa_clid),
        "attributable_google": bool(contact.gclid or contact.wbraid or contact.gbraid),
    }


async def _require_number(session: AsyncSession, number_id: int) -> WaNumber:
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Linha não encontrada.")
    return number


async def _cfg(session: AsyncSession, number: WaNumber) -> dict:
    return numbers_service.effective_cfg(await settings_store.load(session), number)


@router.get("/stages")
async def stages():
    """Etapas na ordem das colunas do kanban."""
    return [{"value": s, "label": STAGE_LABELS.get(s, s)} for s in CONTACT_STAGES]


@router.get("/contacts")
async def list_contacts(
    number_id: int | None = Query(default=None),
    stage: str | None = Query(default=None),
    q: str | None = Query(default=None, description="nome, telefone, nota ou texto da conversa"),
    only_attributed: bool = Query(default=False),
    order: str = Query(default="last_message", description="last_message | created | name"),
    limit: int = Query(default=300, le=1000),
    session: AsyncSession = Depends(get_session),
):
    counts = dict(
        (
            await session.execute(
                select(Conversion.contact_id, func.count()).group_by(Conversion.contact_id)
            )
        ).all()
    )

    stmt = select(Contact).limit(limit)
    if number_id is not None:
        stmt = stmt.where(Contact.wa_number_id == number_id)
    if stage:
        if stage not in CONTACT_STAGES:
            raise HTTPException(status_code=400, detail=f"Etapa inválida: {stage}")
        stmt = stmt.where(Contact.stage == stage)
    if only_attributed:
        stmt = stmt.where(
            Contact.ctwa_clid.is_not(None)
            | Contact.gclid.is_not(None)
            | Contact.wbraid.is_not(None)
            | Contact.gbraid.is_not(None)
        )
    if q:
        like = f"%{q.strip()}%"
        # a busca entra na conversa inteira, nao so no resumo da ultima mensagem:
        # procurar "orcamento" e nao achar quem falou disso ontem seria inutil.
        in_messages = select(Message.contact_id).where(Message.body.ilike(like))
        stmt = stmt.where(
            or_(
                Contact.name.ilike(like),
                Contact.wa_id.ilike(like),
                Contact.phone_e164.ilike(like),
                Contact.last_message_body.ilike(like),
                Contact.note.ilike(like),
                Contact.id.in_(in_messages),
            )
        )

    if order == "name":
        stmt = stmt.order_by(Contact.name.is_(None), Contact.name)
    elif order == "created":
        stmt = stmt.order_by(desc(Contact.created_at))
    else:
        # conversa sem ultima mensagem (veio da agenda, nunca falou) vai pro fim
        stmt = stmt.order_by(
            Contact.last_message_at.is_(None), desc(Contact.last_message_at), desc(Contact.id)
        )

    rows = (await session.execute(stmt)).scalars().all()
    return [serialize(c, counts.get(c.id, 0)) for c in rows]


@router.get("/pipeline")
async def pipeline(
    number_id: int | None = Query(default=None), session: AsyncSession = Depends(get_session)
):
    """Contagem por etapa + os totais que o cabeçalho do CRM mostra."""

    def scoped(stmt):
        return stmt if number_id is None else stmt.where(Contact.wa_number_id == number_id)

    by_stage = dict(
        (await session.execute(scoped(select(Contact.stage, func.count()).group_by(Contact.stage)))).all()
    )
    total = (await session.execute(scoped(select(func.count(Contact.id))))).scalar_one()
    attributed = (
        await session.execute(
            scoped(select(func.count(Contact.id)).where(Contact.ctwa_clid.is_not(None)))
        )
    ).scalar_one()
    unread = (
        await session.execute(
            scoped(select(func.count(Contact.id)).where(Contact.unread_count > 0))
        )
    ).scalar_one()
    synced = (
        await session.execute(scoped(select(func.count(Contact.id)).where(Contact.origin == "sync")))
    ).scalar_one()

    return {
        "stages": {s: by_stage.get(s, 0) for s in CONTACT_STAGES},
        "total": total,
        "attributed": attributed,
        "unread": unread,
        "from_sync": synced,
    }


@router.get("/contacts/{contact_id}")
async def get_contact(contact_id: int, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Conversa não encontrada.")

    msgs = (
        (
            await session.execute(
                select(Message)
                .where(Message.contact_id == contact_id)
                .order_by(Message.sent_at)
                .limit(300)
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
        **serialize(contact, len(convs)),
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


class ContactPatch(BaseModel):
    stage: str | None = None
    note: str | None = None
    name: str | None = None
    mark_read: bool = False


@router.patch("/contacts/{contact_id}")
async def patch_contact(
    contact_id: int, payload: ContactPatch, session: AsyncSession = Depends(get_session)
):
    contact = await session.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Conversa não encontrada.")

    if payload.stage is not None:
        if payload.stage not in CONTACT_STAGES:
            raise HTTPException(status_code=400, detail=f"Etapa inválida: {payload.stage}")
        if payload.stage != contact.stage:
            from datetime import datetime, timezone

            contact.stage = payload.stage
            contact.stage_changed_at = datetime.now(timezone.utc)
    if payload.note is not None:
        contact.note = payload.note or None
    if payload.name is not None:
        contact.name = payload.name.strip() or None
    if payload.mark_read:
        contact.unread_count = 0

    await session.commit()
    await session.refresh(contact)
    return serialize(contact)


@router.post("/sync")
async def sync(
    number_id: int = Query(..., description="linha cujo WhatsApp será lido"),
    session: AsyncSession = Depends(get_session),
):
    """Puxa contatos e conversas da instância para o CRM dessa linha."""
    number = await _require_number(session, number_id)
    if number.channel != "evolution":
        raise HTTPException(
            status_code=400, detail="Só linha na Evolution API expõe a agenda e as conversas."
        )
    try:
        result = await crm_service.sync_from_instance(session, number, await _cfg(session, number))
    except evolution.EvolutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"number_id": number.id, **result}


@router.post("/contacts/{contact_id}/messages/sync")
async def sync_messages(
    contact_id: int,
    limit: int = Query(default=60, le=200),
    session: AsyncSession = Depends(get_session),
):
    """Histórico dessa conversa, buscado na Evolution. Não dispara regra nenhuma."""
    contact = await session.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Conversa não encontrada.")
    if contact.wa_number_id is None:
        raise HTTPException(status_code=400, detail="Conversa sem linha: não sei em qual instância buscar.")

    number = await _require_number(session, contact.wa_number_id)
    try:
        result = await crm_service.sync_messages(
            session, number, await _cfg(session, number), contact, limit=limit
        )
    except evolution.EvolutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result


class ReplyIn(BaseModel):
    text: str = Field(min_length=1)


@router.post("/contacts/{contact_id}/reply")
async def reply(contact_id: int, payload: ReplyIn, session: AsyncSession = Depends(get_session)):
    """Responde pela Evolution, direto da caixa de entrada.

    A mensagem NAO e gravada aqui: a Evolution devolve o evento `SEND_MESSAGE` no
    webhook, e e por lá que ela entra — junto com a avaliacao das regras de
    palavra-chave. Gravar dos dois lados duplicaria a conversa e o disparo.
    """
    contact = await session.get(Contact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail="Conversa não encontrada.")
    if contact.wa_number_id is None:
        raise HTTPException(status_code=400, detail="Conversa sem linha: não sei por qual número enviar.")

    number = await _require_number(session, contact.wa_number_id)
    if number.channel != "evolution":
        raise HTTPException(status_code=400, detail="Resposta pelo CRM só em linha na Evolution API.")

    try:
        body = await evolution.send_text(await _cfg(session, number), contact.wa_id, payload.text)
    except evolution.EvolutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"sent": True, "response": body}
