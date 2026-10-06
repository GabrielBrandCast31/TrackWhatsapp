"""Junta conversas duplicadas da mesma pessoa na mesma linha.

Ate aqui o contato era achado pelo `wa_id` exato. O formulario grava o telefone
como a pessoa digitou (5531993370270) e o WhatsApp entrega sem o nono digito
(553193370270), entao quem preenchia o formulario e depois conversava virava
duas conversas: o card do formulario (MQL, com a origem) e um "Organico" com as
mensagens. `ingest.find_by_phone` impede o caso novo; isto aqui arruma a base
que ja existe, e roda no startup (idempotente: sem duplicata, nao faz nada).

O sobrevivente e o contato do WhatsApp (o `wa_id` dele e o que a Evolution usa);
o outro doa mensagens, respostas de formulario, atribuicao, jornada e etapa.
"""

import logging

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import funnel, phones
from app.models import Contact, ConversationAnalysis, Conversion, FormResponse, Message, Prospect

log = logging.getLogger(__name__)

# campo vazio no sobrevivente e preenchido pelo duplicado
_FILL = (
    "name", "wa_lid",
    "ctwa_clid", "source_id", "source_type", "source_url", "ad_headline", "ad_body", "ad_source_app",
    "gclid", "wbraid", "gbraid",
    "utm", "first_utm", "last_utm",
    "transaction_id", "visitor_id", "session_id", "fbp", "fbc", "ttclid", "landing_page", "page_url",
    "match_method", "match_score", "whatsapp_arrived_at",
    "first_message", "phone_number_id", "profile_pic_url", "deal_value",
    "first_response_at", "customer_replied_at", "synced_at",
)
# marcos do funil: vale o mais antigo
_EARLIEST = ("mql_at", "conversation_at", "scheduled_at", "attended_at", "closed_at", "lost_at", "created_at")
_CHILDREN = (Message, Conversion, ConversationAnalysis, FormResponse, Prospect)


def _rank(contact: Contact) -> int:
    return funnel.RANK.get(contact.stage or "novo", -1)


def merge_into(keep: Contact, dup: Contact) -> None:
    """Copia para `keep` o que so `dup` sabe. Nao mexe nas tabelas filhas."""
    for field in _FILL:
        if not getattr(keep, field) and getattr(dup, field):
            setattr(keep, field, getattr(dup, field))
    for field in _EARLIEST:
        a, b = getattr(keep, field), getattr(dup, field)
        if b is not None and (a is None or b < a):
            setattr(keep, field, b)
    if _rank(dup) > _rank(keep):
        keep.stage, keep.stage_changed_at, keep.stage_source = dup.stage, dup.stage_changed_at, dup.stage_source
    if dup.note and dup.note not in (keep.note or ""):
        keep.note = f"{keep.note}\n\n{dup.note}" if keep.note else dup.note
    if dup.origin == "form" and keep.origin in ("webhook", "sync"):
        keep.origin = "form"
    if dup.last_message_at and (keep.last_message_at is None or dup.last_message_at > keep.last_message_at):
        keep.last_message_at = dup.last_message_at
        keep.last_message_body = dup.last_message_body
        keep.last_message_from_me = dup.last_message_from_me
    keep.unread_count = (keep.unread_count or 0) + (dup.unread_count or 0)


async def absorb(session: AsyncSession, keep: Contact, dup: Contact) -> None:
    """`dup` some dentro de `keep`: dados, mensagens, respostas e analises. Sem commit."""
    merge_into(keep, dup)
    for model in _CHILDREN:
        await session.execute(update(model).where(model.contact_id == dup.id).values(contact_id=keep.id))
    session.expunge(dup)
    await session.execute(delete(Contact).where(Contact.id == dup.id))
    log.info("contato %s (%s) juntado ao %s (%s)", dup.id, dup.wa_id, keep.id, keep.wa_id)


async def merge_duplicates(session: AsyncSession) -> int:
    """Junta os pares que so diferem pelo nono digito. Devolve quantos sairam."""
    rows = (
        await session.execute(select(Contact).where(Contact.phone_e164.is_not(None)).order_by(Contact.id))
    ).scalars().all()
    groups: dict[tuple, list[Contact]] = {}
    for contact in rows:
        key = phones.match_key(contact.wa_id)
        if key and len(key) >= 10:
            groups.setdefault((contact.wa_number_id, key), []).append(contact)

    merged = 0
    for group in groups.values():
        if len(group) < 2:
            continue
        # o contato do WhatsApp sobrevive: o do formulario carrega um wa_id digitado
        group.sort(key=lambda c: (c.origin == "form", c.id))
        keep, *dups = group
        for dup in dups:
            await absorb(session, keep, dup)
            merged += 1
    if merged:
        await session.commit()
    return merged
