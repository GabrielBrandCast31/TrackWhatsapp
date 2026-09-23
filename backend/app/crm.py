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

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import String, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.evolution_ingest import (
    PHONE_ALT_FIELDS,
    apply_ad_attribution,
    as_utc,
    text_of,
    timestamp_of,
)
from app.models import Contact, Message, WaNumber
from app.services import evolution
from app.tracking import to_e164

log = logging.getLogger(__name__)

# jid que nao e conversa de pessoa. `@lid` fica de fora de proposito: veja
# `identity_from_chat` e o docstring de `evolution_ingest.identity_of`.
_IGNORED_SUFFIXES = ("@g.us", "@broadcast", "@newsletter")


def wa_id_from_jid(jid: str | None) -> str | None:
    """Digitos do jid, ou None se ele nao representa uma conversa 1:1.

    Para um jid `@lid` isso devolve o LID, que NAO e telefone — quem precisa da
    distincao usa `identity_from_chat`.
    """
    if not jid:
        return None
    flat = str(jid)
    if any(flat.endswith(suffix) for suffix in _IGNORED_SUFFIXES):
        return None
    digits = "".join(c for c in flat.split("@", 1)[0].split(":", 1)[0] if c.isdigit())
    return digits or None


def identity_from_chat(jid: str | None, chat: dict | None = None) -> tuple[str | None, str | None]:
    """`(telefone, lid)` de uma conversa devolvida pela Evolution.

    A conversa `@lid` nao traz o telefone no proprio jid; ele aparece no `key` da
    ultima mensagem, em `remoteJidAlt`/`senderPn`. Quando nem ali existe — conversa
    antiga, de antes de a Evolution passar a guardar o par —, o telefone e mesmo
    desconhecido, e quem chama decide o que fazer com isso.
    """
    if not jid:
        return None, None
    flat = str(jid)
    if any(flat.endswith(suffix) for suffix in _IGNORED_SUFFIXES):
        return None, None
    if not flat.endswith("@lid"):
        return wa_id_from_jid(flat), None

    lid = wa_id_from_jid(flat)
    last = (chat or {}).get("lastMessage") or (chat or {}).get("last_message") or {}
    key = last.get("key") if isinstance(last.get("key"), dict) else {}
    for field in PHONE_ALT_FIELDS:
        alt = key.get(field)
        if alt and not str(alt).endswith("@lid"):
            phone = wa_id_from_jid(str(alt))
            if phone:
                return phone, lid
    return None, lid


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
    session: AsyncSession, wa_number_id: int, wa_id: str, lid: str | None = None
) -> tuple[Contact, bool]:
    """Contato da linha, criando se nao existir. Nunca rouba contato de outra linha."""

    def scoped(stmt):
        return stmt.where(
            Contact.wa_number_id.is_(None) | (Contact.wa_number_id == wa_number_id)
        ).order_by(Contact.wa_number_id.is_(None), Contact.id)

    stmt = scoped(select(Contact).where(Contact.wa_id == wa_id))
    contact = (await session.execute(stmt)).scalars().first()

    if contact is None and lid and lid != wa_id:
        # mesma pessoa, ja conhecida so pelo LID: promove em vez de duplicar
        by_lid = scoped(select(Contact).where(Contact.wa_lid == lid))
        contact = (await session.execute(by_lid)).scalars().first()
        if contact is not None:
            contact.wa_id = wa_id
            contact.phone_e164 = to_e164(wa_id)

    if contact is not None:
        if contact.wa_number_id is None:
            contact.wa_number_id = wa_number_id
        if lid and not contact.wa_lid:
            contact.wa_lid = lid
        return contact, False

    contact = Contact(
        wa_id=wa_id,
        wa_lid=lid,
        # conversa identificada so por LID nao tem telefone: veja `upsert_contact`
        phone_e164=None if (lid and wa_id == lid) else to_e164(wa_id),
        utm={},
        wa_number_id=wa_number_id,
        origin="sync",
        stage="novo",
    )
    session.add(contact)
    return contact, True


# Um sync por linha de cada vez. O automatico (`auto_sync`) e o botao podem cair
# juntos, e duas rodadas simultaneas criariam o mesmo contato duas vezes.
_sync_locks: dict[int, asyncio.Lock] = {}


async def sync_from_instance(session: AsyncSession, number: WaNumber, cfg: dict) -> dict:
    """Puxa contatos e conversas da instancia. Devolve o que entrou e o que falhou."""
    async with _sync_locks.setdefault(number.id, asyncio.Lock()):
        return await _sync_from_instance(session, number, cfg)


async def _sync_from_instance(session: AsyncSession, number: WaNumber, cfg: dict) -> dict:
    result: dict = {
        "chats": 0,
        "contacts": 0,
        "created": 0,
        "updated": 0,
        "messages": 0,
        "skipped": 0,
        # conversas que entraram identificadas so pelo LID, sem telefone conhecido
        "sem_telefone": 0,
        # leads que ganharam o ctwa_clid do anuncio nesta sincronizacao
        "attributed": 0,
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
        wa_id, lid = identity_from_chat(jid, row)
        if not wa_id and not lid:
            result["skipped"] += 1  # grupo, status, newsletter
            continue
        if not wa_id:
            # conversa por LID cujo telefone a Evolution tambem nao conhece. Entra
            # assim mesmo: sumir com ela era o bug que este trecho corrige.
            wa_id = lid
            result["sem_telefone"] += 1

        contact, created = await _upsert(session, number.id, wa_id, lid)
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

        last = row.get("lastMessage") or row.get("last_message")
        if isinstance(last, dict) and apply_ad_attribution(contact, last):
            result["attributed"] += 1

        await session.flush()  # garante contact.id antes de pendurar a mensagem
        if await _save_last_message(session, contact, row):
            result["messages"] += 1

        contact.synced_at = now

    result["attributed"] += await backfill_attribution(session, number.id)
    result["attributed"] += await probe_ad_attribution(session, number, cfg)
    await session.commit()
    return result


def _jid_of_contact(contact: Contact) -> str:
    # conversa migrada e indexada pelo LID na Evolution: pedir o historico por
    # `<telefone>@s.whatsapp.net` volta vazio.
    return f"{contact.wa_lid}@lid" if contact.wa_lid else f"{contact.wa_id}@s.whatsapp.net"


# janela e teto da busca do anuncio no "sincronizar". O ctwa_clid so vale pra
# atribuicao por poucos dias, entao conversa parada ha mais de um mes nao compensa
# as chamadas; o teto segura instancia com milhares de conversas.
PROBE_DAYS = 30
PROBE_MAX = 300
PROBE_CONCURRENCY = 6

# Conversas cujo comeco ja foi lido nesta execucao. A primeira mensagem nao muda,
# entao reler a cada rodada do sync automatico so gastaria chamada na Evolution.
# Fica em memoria: um restart relê uma vez, o que e barato.
_probed: set[int] = set()


async def probe_ad_attribution(
    session: AsyncSession, number: WaNumber, cfg: dict, days: int = PROBE_DAYS, limit: int = PROBE_MAX
) -> int:
    """Busca na Evolution a PRIMEIRA mensagem das conversas recentes sem `ctwa_clid`.

    O sync so enxerga a ultima mensagem de cada conversa, e o anuncio vem sempre
    na primeira. Sem isto, lead que entrou por "sincronizar" (ou cujo webhook se
    perdeu) nunca era atribuido, mesmo com o `ctwaClid` guardado na Evolution.
    As chamadas HTTP correm em paralelo; a escrita no contato e sequencial.
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    stmt = (
        select(Contact)
        .where(Contact.wa_number_id == number.id)
        .where(Contact.ctwa_clid.is_(None))
        .where(Contact.last_message_at >= since)
        .order_by(Contact.last_message_at.desc())
    )
    contacts = [c for c in (await session.execute(stmt)).scalars().all() if c.id not in _probed][:limit]
    if not contacts:
        return 0

    gate = asyncio.Semaphore(PROBE_CONCURRENCY)

    async def first_of(contact: Contact) -> list[dict]:
        async with gate:
            try:
                rows = await evolution.find_first_messages(cfg, _jid_of_contact(contact))
            except Exception as exc:  # noqa: BLE001 — uma conversa nao derruba o sync
                # nao marca como lida: a proxima rodada tenta de novo
                log.warning("contato %s: nao deu pra buscar a primeira mensagem: %s", contact.id, exc)
                return []
            _probed.add(contact.id)
            return rows

    batches = await asyncio.gather(*(first_of(c) for c in contacts))
    fixed = 0
    for contact, rows in zip(contacts, batches):
        if any(apply_ad_attribution(contact, row) for row in rows):
            fixed += 1
            log.info("contato %s: ctwa_clid achado na primeira mensagem da conversa", contact.id)
    return fixed


async def backfill_attribution(session: AsyncSession, wa_number_id: int | None = None) -> int:
    """Recupera o `ctwa_clid` de mensagens que ja estao no banco.

    Antes o sync gravava o objeto cru sem olhar o anuncio, entao ha lead com o
    `ctwaClid` guardado no `raw` da primeira mensagem e a coluna vazia. Aqui so
    entram contatos sem clid e mensagens cujo texto cru cita o anuncio — o filtro
    por texto roda no banco, e so o que passa nele e decodificado.
    """
    stmt = (
        select(Contact, Message.raw)
        .join(Message, Message.contact_id == Contact.id)
        .where(Contact.ctwa_clid.is_(None))
        .where(Message.direction == "in")
        .where(cast(Message.raw, String).like("%ctwa%"))
        .order_by(Message.sent_at)
    )
    if wa_number_id is not None:
        stmt = stmt.where(Contact.wa_number_id == wa_number_id)

    fixed = 0
    for contact, raw in (await session.execute(stmt)).all():
        if contact.ctwa_clid:
            continue  # ja resolvido por uma mensagem anterior deste mesmo lote
        if apply_ad_attribution(contact, raw or {}):
            fixed += 1
            log.info("contato %s: ctwa_clid recuperado do historico gravado", contact.id)
    return fixed


async def sync_messages(
    session: AsyncSession, number: WaNumber, cfg: dict, contact: Contact, limit: int = 60
) -> dict:
    """Historico de uma conversa. NAO avalia regra: ver o docstring do modulo."""
    jid = _jid_of_contact(contact)
    rows = await evolution.find_messages(cfg, jid, limit=limit)

    if not contact.ctwa_clid:
        # o anuncio vem na PRIMEIRA mensagem, que numa conversa longa fica fora
        # das `limit` mais recentes. Busca o comeco da conversa tambem.
        try:
            head = await evolution.find_first_messages(cfg, jid)
        except evolution.EvolutionError as exc:
            log.warning("contato %s: nao deu pra buscar a primeira mensagem: %s", contact.id, exc)
            head = []
        seen = {str((r.get("key") or {}).get("id")) for r in rows if isinstance(r.get("key"), dict)}
        rows += [r for r in head if str((r.get("key") or {}).get("id")) not in seen]

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

    attributed = False
    for row in rows:
        # antes do dedupe de proposito: a mensagem do anuncio pode ja estar
        # gravada de um sync antigo, que nao extraia a atribuicao.
        attributed = apply_ad_attribution(contact, row) or attributed

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
    return {"fetched": len(rows), "saved": saved, "attributed": attributed}
