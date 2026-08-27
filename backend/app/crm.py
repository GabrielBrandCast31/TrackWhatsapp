"""CRM da linha: traz do WhatsApp conectado quem ja conversa com aquele numero.

O webhook so conhece quem falou com a gente DEPOIS de a instancia ser conectada.
A agenda e as conversas que ja existiam no aparelho ficam do lado da Evolution —
este modulo e o que puxa isso pra dentro e transforma em registro do CRM.

Duas cargas, com custos bem diferentes:

* `sync_from_instance` — contatos e conversas (uma chamada de cada). Barato, e o
  que o botao "sincronizar" faz.
* `sync_messages` — historico de UMA conversa, sob demanda, quando a tela abre o
  chat. Puxar isso pra todo mundo de uma vez seria lento e quase todo descartado.

Historico importado **nao dispara regra de palavra-chave**. As regras existem pra
marcar o momento em que o atendimento acontece; reprocessar meses de conversa
antiga mandaria uma enxurrada de eventos falsos pro Meta.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.evolution_ingest import as_utc, text_of, timestamp_of
from app.models import Contact, Message, WaNumber
from app.services import evolution
from app.tracking import to_e164

log = logging.getLogger(__name__)

# jid que nao e conversa de pessoa
_IGNORED_SUFFIXES = ("@g.us", "@broadcast", "@newsletter", "@lid")



def wa_id_from_jid(jid: str | None) -> str | None:
    if not jid:
        return None
    flat = str(jid)
    if any(flat.endswith(suffix) for suffix in _IGNORED_SUFFIXES):
        return None
    digits = "".join(c for c in flat.split("@", 1)[0].split(":", 1)[0] if c.isdigit())
    return digits or None


def _name_of(row: dict) -> str | None:
    for key in ("pushName", "push_name", "name", "verifiedName", "notify"):
        value = row.get(key)
        if value and str(value).strip():
            return str(value).strip()[:160]
    return None


def _picture_of(row: dict) -> str | None:
    for key in ("profilePicUrl", "profilePictureUrl", "profile_pic_url"):
        value = row.get(key)
        if value:
            return str(value)
    return None


def _last_message_of(chat: dict) -> tuple[str | None, datetime | None, bool]:
    """Resumo da ultima mensagem da conversa, como a Evolution devolve em `findChats`."""
    last = chat.get("lastMessage") or chat.get("last_message")
    if not isinstance(last, dict):
        return None, None, False

    key = last.get("key") if isinstance(last.get("key"), dict) else {}
    return text_of(last), timestamp_of(last), bool(key.get("fromMe"))


async def _save_last_message(session: AsyncSession, contact: Contact, chat: dict) -> bool:
    """Grava a ultima mensagem que veio no `findChats` como mensagem de verdade.

    Sem isso a conversa sincronizada abriria vazia, e a busca por texto nao acharia
    nem o que a propria tela mostra no resumo. Vem com id, entao o dedupe funciona
    e o webhook depois nao duplica nada.
    """
    last = chat.get("lastMessage") or chat.get("last_message")
    if not isinstance(last, dict):
        return False

    key = last.get("key") if isinstance(last.get("key"), dict) else {}
    wamid = str(key.get("id")) if key.get("id") else None
    if not wamid:
        return False  # sem id nao da pra deduplicar: melhor nao gravar
    exists = await session.execute(select(Message.id).where(Message.wamid == wamid))
    if exists.scalar_one_or_none() is not None:
        return False

    body = text_of(last)
    session.add(
        Message(
            contact_id=contact.id,
            wamid=wamid,
            direction="out" if key.get("fromMe") else "in",
            msg_type=last.get("messageType"),
            body=body,
            raw=last,
            sent_at=timestamp_of(last) or datetime.now(timezone.utc),
        )
    )
    return True


async def _upsert(
    session: AsyncSession, wa_number_id: int, wa_id: str
) -> tuple[Contact, bool]:
    """Contato da linha, criando se nao existir. Nunca rouba contato de outra linha."""
    stmt = (
        select(Contact)
        .where(Contact.wa_id == wa_id)
        .where(Contact.wa_number_id.is_(None) | (Contact.wa_number_id == wa_number_id))
        .order_by(Contact.wa_number_id.is_(None), Contact.id)
    )
    contact = (await session.execute(stmt)).scalars().first()
    if contact is not None:
        if contact.wa_number_id is None:
            contact.wa_number_id = wa_number_id
        return contact, False

    contact = Contact(
        wa_id=wa_id,
        phone_e164=to_e164(wa_id),
        utm={},
        wa_number_id=wa_number_id,
        origin="sync",
        stage="novo",
    )
    session.add(contact)
    return contact, True


async def sync_from_instance(session: AsyncSession, number: WaNumber, cfg: dict) -> dict:
    """Puxa contatos e conversas da instancia. Devolve o que entrou e o que falhou."""
    result: dict = {
        "chats": 0,
        "contacts": 0,
        "created": 0,
        "updated": 0,
        "messages": 0,
        "skipped": 0,
        "errors": [],
    }

    # as duas chamadas sao independentes: se `findChats` falhar (Evolution sem
    # banco, por exemplo), a agenda sozinha ja povoa o CRM.
    rows: dict[str, dict] = {}

    try:
        chats = await evolution.find_chats(cfg)
        result["chats"] = len(chats)
        for chat in chats:
            jid = evolution.jid_of(chat)
            if jid:
                rows.setdefault(jid, {}).update(chat)
    except Exception as exc:  # noqa: BLE001 — o motivo vai pra tela
        result["errors"].append(f"conversas: {exc}")

    try:
        contacts = await evolution.find_contacts(cfg)
        result["contacts"] = len(contacts)
        for row in contacts:
            jid = evolution.jid_of(row)
            if jid:
                # o chat manda mais informacao (ultima mensagem); a agenda so
                # completa nome e foto, sem apagar o que o chat trouxe.
                merged = rows.setdefault(jid, {})
                for key, value in row.items():
                    if key not in merged or merged.get(key) in (None, ""):
                        merged[key] = value
    except Exception as exc:  # noqa: BLE001
        result["errors"].append(f"contatos: {exc}")

    now = datetime.now(timezone.utc)

    for jid, row in rows.items():
        wa_id = wa_id_from_jid(jid)
        if not wa_id:
            result["skipped"] += 1  # grupo, status, newsletter
            continue

        contact, created = await _upsert(session, number.id, wa_id)
        if created:
            result["created"] += 1
        else:
            result["updated"] += 1

        name = _name_of(row)
        if name and not contact.name:
            contact.name = name
        picture = _picture_of(row)
        if picture:
            contact.profile_pic_url = picture

        body, at, from_me = _last_message_of(row)
        # so avanca o resumo: o que o webhook gravou em tempo real e mais fresco
        # do que o que o sync devolve, e nao pode ser rebaixado.
        current = as_utc(contact.last_message_at)
        if at is not None and (current is None or at > current):
            contact.last_message_at = at
            contact.last_message_body = body
            contact.last_message_from_me = from_me
        elif current is None and body and not contact.last_message_body:
            contact.last_message_body = body

        unread = row.get("unreadCount") or row.get("unread_count")
        if isinstance(unread, int):
            contact.unread_count = unread

        await session.flush()  # garante contact.id antes de pendurar a mensagem
        if await _save_last_message(session, contact, row):
            result["messages"] += 1

        contact.synced_at = now

    await session.commit()
    return result


async def sync_messages(
    session: AsyncSession, number: WaNumber, cfg: dict, contact: Contact, limit: int = 60
) -> dict:
    """Historico de uma conversa. NAO avalia regra: ver o docstring do modulo."""
    jid = f"{contact.wa_id}@s.whatsapp.net"
    rows = await evolution.find_messages(cfg, jid, limit=limit)

    known = set(
        (
            await session.execute(
                select(Message.wamid).where(Message.contact_id == contact.id).where(Message.wamid.is_not(None))
            )
        )
        .scalars()
        .all()
    )

    saved = 0
    newest = as_utc(contact.last_message_at)
    newest_body, newest_from_me = contact.last_message_body, contact.last_message_from_me

    for row in rows:
        key = row.get("key") if isinstance(row.get("key"), dict) else {}
        wamid = str(key.get("id")) if key.get("id") else None
        if wamid and wamid in known:
            continue

        from_me = bool(key.get("fromMe"))
        body = text_of(row)
        at = timestamp_of(row)
        session.add(
            Message(
                contact_id=contact.id,
                wamid=wamid,
                direction="out" if from_me else "in",
                msg_type=row.get("messageType"),
                body=body,
                raw=row,
                sent_at=at or datetime.now(timezone.utc),
            )
        )
        if wamid:
            known.add(wamid)
        saved += 1
        if at is not None and (newest is None or at > newest):
            newest, newest_body, newest_from_me = at, body, from_me

    if saved:
        contact.last_message_at = newest
        contact.last_message_body = newest_body
        contact.last_message_from_me = newest_from_me
    contact.synced_at = datetime.now(timezone.utc)
    await session.commit()
    return {"fetched": len(rows), "saved": saved}
