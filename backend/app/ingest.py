"""Transforma o payload do webhook da Cloud API em Contato + Mensagem.

O objeto `referral` (com o ctwa_clid) so vem na PRIMEIRA mensagem depois do
clique no anuncio. Por isso, quando ele chega a gente grava na hora; nas
mensagens seguintes o contato ja carrega a atribuicao, e a gente so preenche
campos que ainda estiverem vazios (nunca sobrescreve uma atribuicao existente
com None).

Multi-numero: um mesmo webhook pode carregar mensagens de linhas diferentes, e o
roteamento sai do `metadata.phone_number_id` de cada change. Contato e prospect
sao escopados pelo numero — a mesma pessoa falando com duas linhas vira dois
leads, cada um com a atribuicao da campanha daquela linha.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import numbers, phones
from app.models import Contact, Message, Prospect, WaNumber, WebhookLog
from app.tracking import extract, to_e164

_ATTRIBUTION_FIELDS = (
    "ctwa_clid",
    "source_id",
    "source_type",
    "source_url",
    "ad_headline",
    "ad_body",
    "gclid",
    "wbraid",
    "gbraid",
)


def _text_of(message: dict) -> str | None:
    msg_type = message.get("type")
    if msg_type == "text":
        return (message.get("text") or {}).get("body")
    if msg_type == "button":
        return (message.get("button") or {}).get("text")
    if msg_type == "interactive":
        interactive = message.get("interactive") or {}
        for key in ("button_reply", "list_reply"):
            if key in interactive:
                return (interactive[key] or {}).get("title")
    for media in ("image", "video", "document", "audio"):
        if msg_type == media:
            caption = (message.get(media) or {}).get("caption")
            return caption or f"[{media}]"
    return None


def _ts(message: dict) -> datetime:
    raw = message.get("timestamp")
    try:
        return datetime.fromtimestamp(int(raw), tz=timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


async def _upsert_contact(
    session: AsyncSession,
    wa_id: str,
    name: str | None,
    attribution: dict,
    phone_number_id: str | None,
    wa_number_id: int | None,
) -> tuple[Contact, bool]:
    stmt = select(Contact).where(Contact.wa_id == wa_id)
    if wa_number_id is not None:
        # contato ainda sem dono (base pre-multinumero) e adotado pela linha que o atendeu
        stmt = stmt.where(Contact.wa_number_id.is_(None) | (Contact.wa_number_id == wa_number_id))
    result = await session.execute(stmt.order_by(Contact.wa_number_id.is_(None), Contact.id))
    contact = result.scalars().first()
    created = contact is None

    if contact is None:
        contact = Contact(wa_id=wa_id, phone_e164=to_e164(wa_id), utm={}, wa_number_id=wa_number_id)
        session.add(contact)
    elif contact.wa_number_id is None and wa_number_id is not None:
        contact.wa_number_id = wa_number_id

    if name and not contact.name:
        contact.name = name
    if phone_number_id:
        contact.phone_number_id = phone_number_id

    for field in _ATTRIBUTION_FIELDS:
        incoming = attribution.get(field)
        if incoming and not getattr(contact, field):
            setattr(contact, field, incoming)

    incoming_utm = attribution.get("utm") or {}
    if incoming_utm:
        merged = dict(contact.utm or {})
        merged.update(incoming_utm)
        contact.utm = merged

    contact.last_seen_at = datetime.now(timezone.utc)
    return contact, created


async def _link_prospect(session: AsyncSession, contact: Contact) -> int | None:
    """Se quem mandou a mensagem foi alguem que a gente abordou, fecha o ciclo do CRM.

    O wa_id brasileiro chega sem o nono digito e o Google Maps devolve com — por isso
    o match e por chave canonica (`phones.match_key`), nao por igualdade de string.
    """
    key = phones.match_key(contact.wa_id)
    if not key:
        return None

    # os 8 ultimos digitos nao mudam com o nono digito — filtram no banco antes
    # de a comparacao canonica confirmar o par.
    stmt = (
        select(Prospect)
        .where(Prospect.phone_e164.like(f"%{key[-8:]}"))
        .where(Prospect.contact_id.is_(None) | (Prospect.contact_id == contact.id))
    )
    if contact.wa_number_id is not None:
        # so fecha o ciclo com prospect da MESMA linha: cliente A nao herda resposta do cliente B
        stmt = stmt.where(
            Prospect.wa_number_id.is_(None) | (Prospect.wa_number_id == contact.wa_number_id)
        )
    candidates = (await session.execute(stmt)).scalars().all()
    for prospect in candidates:
        if phones.match_key(prospect.phone_e164) != key:
            continue
        prospect.contact_id = contact.id
        if prospect.replied_at is None:
            prospect.replied_at = datetime.now(timezone.utc)
        if prospect.stage in ("novo", "contatado"):
            prospect.stage = "respondeu"
        return prospect.id
    return None


def change_key(change: dict) -> str:
    """Linha que um change endereca. String vazia = payload sem metadata."""
    pnid = ((change.get("value") or {}).get("metadata") or {}).get("phone_number_id")
    return str(pnid) if pnid else ""


def payload_phone_number_ids(payload: dict) -> list[str]:
    """Todas as linhas citadas no payload — o webhook autoriza uma por uma."""
    found: list[str] = []
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            if change.get("field") != "messages":
                continue
            key = change_key(change)
            if key not in found:
                found.append(key)
    return found


async def ingest_payload(
    session: AsyncSession,
    payload: dict,
    fallback_number: WaNumber | None = None,
    allowed_phone_number_ids: set[str] | None = None,
) -> dict:
    """Processa um POST do webhook. Devolve um resumo do que entrou.

    `fallback_number` cobre dois casos: payload de simulacao e webhook de uma linha
    que ainda nao foi cadastrada (a mensagem entra no numero padrao em vez de sumir).

    `allowed_phone_number_ids` e a lista de linhas que ESTA requisicao provou poder
    escrever (veja `routers/webhook.py`). Change de linha fora dela e descartado: um
    payload assinado com o segredo do cliente A nao grava nada na base do cliente B.
    `None` desliga a checagem — usado so pelo simulador, que nao vem da internet.
    """
    contacts_touched: list[int] = []
    prospects_replied: list[int] = []
    numbers_touched: list[int] = []
    new_contacts = 0
    messages_saved = 0
    statuses = 0
    log_phone_number_id: str | None = None
    log_number_id: int | None = None
    unknown_lines: list[str] = []
    blocked_lines: list[str] = []

    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            if change.get("field") != "messages":
                continue

            phone_number_id = (value.get("metadata") or {}).get("phone_number_id")
            key = change_key(change)
            if allowed_phone_number_ids is not None and key not in allowed_phone_number_ids:
                label = key or "sem metadata"
                if label not in blocked_lines:
                    blocked_lines.append(label)
                continue

            matched = await numbers.by_phone_number_id(session, phone_number_id)
            if matched is None and phone_number_id and str(phone_number_id) not in unknown_lines:
                unknown_lines.append(str(phone_number_id))
            wa_number = matched or fallback_number
            wa_number_id = wa_number.id if wa_number else None
            log_phone_number_id = log_phone_number_id or (
                str(phone_number_id) if phone_number_id else None
            )
            log_number_id = log_number_id or wa_number_id
            if wa_number_id is not None and wa_number_id not in numbers_touched:
                numbers_touched.append(wa_number_id)

            profiles = {c.get("wa_id"): (c.get("profile") or {}).get("name") for c in value.get("contacts") or []}
            statuses += len(value.get("statuses") or [])

            for message in value.get("messages") or []:
                wa_id = message.get("from")
                if not wa_id:
                    continue

                text = _text_of(message)
                attribution = extract(message.get("referral"), text)
                contact, created = await _upsert_contact(
                    session, wa_id, profiles.get(wa_id), attribution, phone_number_id, wa_number_id
                )
                if created:
                    new_contacts += 1
                await session.flush()  # garante contact.id

                if not contact.first_message and text:
                    contact.first_message = text

                prospect_id = await _link_prospect(session, contact)
                if prospect_id is not None:
                    prospects_replied.append(prospect_id)

                wamid = message.get("id")
                if wamid:
                    dup = await session.execute(select(Message.id).where(Message.wamid == wamid))
                    if dup.scalar_one_or_none() is not None:
                        continue  # reentrega da Meta — ignora

                session.add(
                    Message(
                        contact_id=contact.id,
                        wamid=wamid,
                        direction="in",
                        msg_type=message.get("type"),
                        body=text,
                        raw=message,
                        sent_at=_ts(message),
                    )
                )
                messages_saved += 1
                contacts_touched.append(contact.id)

    summary = (
        f"{messages_saved} msg(s), {new_contacts} contato(s) novo(s), {statuses} status"
        if (messages_saved or new_contacts or statuses)
        else "payload sem mensagens"
    )
    if prospects_replied:
        summary += f", {len(set(prospects_replied))} prospect(s) respondeu"
    if blocked_lines:
        summary += f" — {len(blocked_lines)} linha(s) barrada(s) por assinatura: {', '.join(blocked_lines)}"
    if unknown_lines:
        # sem isso, uma linha nova cairia no numero padrao sem ninguem notar
        destino = "caiu no número padrão" if log_number_id is not None else "sem destino"
        summary += f" — linha {', '.join(unknown_lines)} nao cadastrada ({destino})"
    session.add(
        WebhookLog(
            payload=payload,
            summary=summary,
            phone_number_id=log_phone_number_id,
            wa_number_id=log_number_id,
        )
    )
    await session.commit()

    return {
        "messages": messages_saved,
        "new_contacts": new_contacts,
        "statuses": statuses,
        "contact_ids": sorted(set(contacts_touched)),
        "prospect_ids": sorted(set(prospects_replied)),
        "wa_number_ids": numbers_touched,
        "blocked_lines": blocked_lines,
        "summary": summary,
    }


def build_simulated_payload(
    *,
    wa_id: str,
    name: str,
    text: str,
    ctwa_clid: str | None,
    ad_id: str | None,
    source_url: str | None,
    phone_number_id: str,
) -> dict:
    """Monta um payload identico ao da Meta pra testar o fluxo sem gastar clique em anuncio."""
    now = int(datetime.now(timezone.utc).timestamp())
    message: dict = {
        "from": wa_id,
        "id": f"wamid.SIM{now}{wa_id[-4:]}",
        "timestamp": str(now),
        "type": "text",
        "text": {"body": text},
    }
    if ctwa_clid or ad_id or source_url:
        message["referral"] = {
            "source_url": source_url or "https://fb.me/simulado",
            "source_id": ad_id or "",
            "source_type": "ad",
            "headline": "Anuncio simulado",
            "body": "Clique aqui e fale no WhatsApp",
            "media_type": "image",
            "ctwa_clid": ctwa_clid or "",
        }
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "SIMULATED_WABA",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "simulado",
                                "phone_number_id": phone_number_id or "SIMULATED",
                            },
                            "contacts": [{"profile": {"name": name}, "wa_id": wa_id}],
                            "messages": [message],
                        },
                    }
                ],
            }
        ],
    }
