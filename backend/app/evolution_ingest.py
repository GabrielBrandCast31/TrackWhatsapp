"""Webhook da Evolution API -> lead com atribuicao -> evento de conversao.

O ganho do canal Evolution esta aqui: o payload e a mensagem crua do WhatsApp, e
nela vem o `contextInfo.externalAdReply` — o bloco do anuncio Click to WhatsApp,
com o **ctwaClid**. E ele que amarra a conversa a campanha no Meta.

O bloco pode estar em niveis diferentes conforme o tipo de mensagem (texto,
imagem com legenda, botao), entao a busca e recursiva: procura `externalAdReply`
em qualquer lugar do objeto em vez de fixar um caminho que muda a cada tipo.

Duas coisas acontecem na entrada de cada mensagem:

1. atribuicao — grava/completa o lead (nunca sobrescreve atribuicao existente);
2. regras — se o texto casar com uma palavra-chave configurada, dispara o evento
   na hora. E o caso do atendente confirmando o atendimento no chat.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import numbers as numbers_service
from app import settings_store
from app.firing import already_fired, fire_event
from app.ingest import link_prospect, merge_attribution, upsert_contact
from app.models import Contact, KeywordRule, Message, WaNumber, WebhookLog
from app.services import rules as rules_engine
from app.tracking import extract

log = logging.getLogger(__name__)

# eventos que mexem em lead; o resto e descartado na entrada
MESSAGE_EVENTS = {"messages.upsert", "send.message", "messages.set"}
STATE_EVENTS = {"connection.update"}

# jid que nao e conversa de pessoa. `@lid` NAO entra aqui: e conversa individual
# sim, so identificada pelo LID em vez do telefone — veja `identity_of`.
_IGNORED_JID_SUFFIXES = ("@g.us", "@broadcast", "@newsletter")

# onde o telefone real viaja quando o jid da conversa vem como `@lid`
PHONE_ALT_FIELDS = ("remoteJidAlt", "senderPn", "participantAlt", "participantPn")


def event_name(payload: dict) -> str:
    """Nome do evento normalizado: `MESSAGES_UPSERT` e `messages.upsert` viram o mesmo."""
    raw = payload.get("event") or payload.get("Event") or ""
    return str(raw).strip().lower().replace("_", ".")


def instance_name(payload: dict) -> str | None:
    for key in ("instance", "instanceName", "instance_name"):
        value = payload.get(key)
        if value:
            return str(value)
    return None


def _as_messages(payload: dict) -> list[dict]:
    """A Evolution manda uma mensagem em `data`, ou uma lista, ou `data.messages`."""
    data = payload.get("data")
    if isinstance(data, dict):
        inner = data.get("messages")
        if isinstance(inner, list):
            return [m for m in inner if isinstance(m, dict)]
        return [data]
    if isinstance(data, list):
        return [m for m in data if isinstance(m, dict)]
    return []


def _find_key(node, wanted: str, depth: int = 0):
    """Primeiro valor de `wanted` em qualquer profundidade do objeto."""
    if depth > 8:
        return None
    if isinstance(node, dict):
        if wanted in node:
            return node[wanted]
        for value in node.values():
            found = _find_key(value, wanted, depth + 1)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_key(value, wanted, depth + 1)
            if found is not None:
                return found
    return None


def text_of(message: dict) -> str | None:
    """Texto visivel da mensagem, qualquer que seja o tipo."""
    body = message.get("message")
    if not isinstance(body, dict):
        # alguns webhooks entregam o texto pronto
        for key in ("text", "body", "conversation"):
            if message.get(key):
                return str(message[key])
        return None

    direct = (
        body.get("conversation")
        or (body.get("extendedTextMessage") or {}).get("text")
        or (body.get("imageMessage") or {}).get("caption")
        or (body.get("videoMessage") or {}).get("caption")
        or (body.get("documentMessage") or {}).get("caption")
        or (body.get("buttonsResponseMessage") or {}).get("selectedDisplayText")
        or (body.get("templateButtonReplyMessage") or {}).get("selectedDisplayText")
        or ((body.get("listResponseMessage") or {}).get("title"))
        or (body.get("ephemeralMessage") or {}).get("message", {}).get("conversation")
    )
    if direct:
        return str(direct)

    kind = message.get("messageType") or next(iter(body), None)
    return f"[{kind}]" if kind else None


def _find_all(node, wanted: str, depth: int = 0):
    """Todos os valores de `wanted` no objeto, em qualquer profundidade."""
    if depth > 8:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if key == wanted:
                yield value
            yield from _find_all(value, wanted, depth + 1)
    elif isinstance(node, list):
        for value in node:
            yield from _find_all(value, wanted, depth + 1)


def _clid_of(block: dict) -> str | None:
    value = block.get("ctwaClid") or block.get("ctwa_clid")
    return str(value) if value else None


def ad_referral(message: dict) -> dict | None:
    """Bloco do anuncio Click to WhatsApp, no formato que `tracking.extract` espera.

    A Evolution repassa o objeto do WhatsApp em camelCase (`ctwaClid`, `sourceUrl`),
    entao a traducao pro nome que o resto do sistema usa acontece aqui — um lugar so.

    O bloco aparece em lugares diferentes conforme a versao e a origem do objeto:

    * webhook de texto simples / `findMessages` da v2: `contextInfo` no MESMO nivel
      de `message`, nao dentro dele (`data.contextInfo.externalAdReply`);
    * texto estendido, imagem com legenda: `message.<tipo>.contextInfo.externalAdReply`;
    * formato da Cloud API: `referral.ctwa_clid`.

    Pode haver mais de um `externalAdReply` (mensagem citada, por exemplo); vale o
    que traz o `ctwaClid`. Sem `externalAdReply` nenhum, um `ctwaClid` solto ou os
    marcadores de conversao (`conversionSource: FB_Ads`, `entryPointConversionSource:
    ctwa_ad`) ainda dizem que a conversa veio de anuncio.
    """
    blocks = [b for b in _find_all(message, "externalAdReply") if isinstance(b, dict)]
    blocks += [b for b in _find_all(message, "referral") if isinstance(b, dict)]
    ad = next((b for b in blocks if _clid_of(b)), blocks[0] if blocks else None)

    clid = _clid_of(ad) if ad else None
    if not clid:
        loose = next((v for v in _find_all(message, "ctwaClid") if v), None)
        clid = str(loose) if loose else None

    from_ad = str(_find_key(message, "conversionSource") or "").lower() == "fb_ads" or str(
        _find_key(message, "entryPointConversionSource") or ""
    ).lower() == "ctwa_ad"

    if ad is None and not clid and not from_ad:
        return None

    ad = ad or {}
    return {
        "ctwa_clid": clid,
        "source_id": ad.get("sourceId") or ad.get("source_id"),
        "source_type": ad.get("sourceType") or ad.get("source_type") or "ad",
        "source_url": ad.get("sourceUrl") or ad.get("source_url"),
        "headline": ad.get("title") or ad.get("headline"),
        "body": ad.get("body"),
    }


def apply_ad_attribution(contact: Contact, message: dict) -> bool:
    """Completa a atribuicao do contato a partir de um objeto de mensagem cru.

    E o que o sync de historico usa: la nao ha `upsert_contact` com atribuicao, e
    sem isso o lead que entrou por "sincronizar" ficava sem o `ctwaClid` que estava
    ali no `raw`. So mensagem do cliente conta — o anuncio nunca vem no `fromMe`.
    Devolve True se o contato ganhou o `ctwa_clid` agora.
    """
    if not isinstance(message, dict) or is_from_me(message):
        return False
    referral = ad_referral(message)
    if referral is None:
        return False
    return merge_attribution(contact, extract(referral, text_of(message)))


def _digits_of_jid(jid: str | None) -> str | None:
    if not jid:
        return None
    return "".join(c for c in str(jid).split("@", 1)[0].split(":", 1)[0] if c.isdigit()) or None


def identity_of(message: dict) -> tuple[str | None, str | None]:
    """`(telefone, lid)` da PESSOA do outro lado — o mesmo nos dois sentidos da conversa.

    `(None, None)` significa "isto nao e atendimento 1:1": grupo, status, canal.

    O WhatsApp migrou o enderecamento para LID: o `remoteJid` de uma conversa
    individual passa a vir como `<id>@lid`, um identificador opaco que NAO e
    telefone. O numero real viaja ao lado, em `remoteJidAlt` (ou `senderPn` /
    `participantAlt`, conforme o tipo de evento).

    Este codigo tratava `@lid` como "nao e pessoa", na mesma lista de grupo e
    status — e com isso descartava em silencio toda conversa de contato ja
    migrado. Numa instancia real isso era quase metade das conversas.

    Quando so o LID chega, ele mesmo vira a identidade: uma conversa no CRM sem
    telefone e melhor do que conversa nenhuma, e o telefone entra depois, no
    primeiro evento que trouxer o campo alternativo (veja `upsert_contact`).
    """
    key = message.get("key") if isinstance(message.get("key"), dict) else {}
    jid = str(key.get("remoteJid") or message.get("remoteJid") or "")
    if not jid or any(jid.endswith(suffix) for suffix in _IGNORED_JID_SUFFIXES):
        return None, None

    if not jid.endswith("@lid"):
        return _digits_of_jid(jid), None

    lid = _digits_of_jid(jid)
    for field in PHONE_ALT_FIELDS:
        alt = key.get(field) or message.get(field)
        if alt and not str(alt).endswith("@lid"):
            phone = _digits_of_jid(alt)
            if phone:
                return phone, lid
    return None, lid


def wa_id_of(message: dict) -> str | None:
    """Identidade da conversa: o telefone quando ele existe, senao o LID."""
    phone, lid = identity_of(message)
    return phone or lid


def is_from_me(message: dict) -> bool:
    key = message.get("key") if isinstance(message.get("key"), dict) else {}
    return bool(key.get("fromMe"))


def message_id_of(message: dict) -> str | None:
    key = message.get("key") if isinstance(message.get("key"), dict) else {}
    value = key.get("id") or message.get("id")
    return str(value) if value else None


def as_utc(value: datetime | None) -> datetime | None:
    """Datetime com fuso. O SQLite devolve naive mesmo em coluna `timezone=True`,
    e comparar naive com aware levanta TypeError na hora de ordenar a conversa."""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def timestamp_of(message: dict) -> datetime | None:
    """Quando a mensagem foi enviada, ou None se o payload nao disser.

    Separado de `sent_at_of` porque para ORDENAR (a ultima mensagem do CRM) um
    "nao sei" tem que continuar sendo "nao sei" — virar `agora` jogaria mensagem
    antiga pro topo da caixa de entrada.
    """
    raw = message.get("messageTimestamp") or message.get("timestamp")
    try:
        ts = int(raw)
    except (TypeError, ValueError):
        return None
    if ts > 10_000_000_000:  # veio em milissegundos
        ts //= 1000
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def sent_at_of(message: dict) -> datetime:
    """Igual a `timestamp_of`, mas sempre devolve algo — a coluna nao aceita nulo."""
    return timestamp_of(message) or datetime.now(timezone.utc)


async def _rules_for(session: AsyncSession, wa_number_id: int | None) -> list[KeywordRule]:
    """Regras da linha + as globais (sem linha), na ordem de cadastro."""
    stmt = select(KeywordRule).where(KeywordRule.active.is_(True)).order_by(KeywordRule.id)
    if wa_number_id is None:
        stmt = stmt.where(KeywordRule.wa_number_id.is_(None))
    else:
        stmt = stmt.where(
            KeywordRule.wa_number_id.is_(None) | (KeywordRule.wa_number_id == wa_number_id)
        )
    return list((await session.execute(stmt)).scalars().all())


async def _apply_rules(
    session: AsyncSession,
    cfg: dict,
    contact: Contact,
    text: str | None,
    direction: str,
    rules: list[KeywordRule],
) -> list[dict]:
    """Dispara o que casar. Devolve o que aconteceu, pra aparecer no log do webhook."""
    fired: list[dict] = []
    if not text:
        return fired

    for hit in rules_engine.first_firing(rules, text, direction):
        rule: KeywordRule = hit["rule"]

        if rule.require_attribution and not contact.ctwa_clid:
            fired.append(
                {
                    "rule_id": rule.id,
                    "event": rule.event_name,
                    "status": "skipped",
                    "reason": "lead sem ctwa_clid (regra exige atribuição)",
                }
            )
            continue

        if rule.once_per_contact and await already_fired(session, contact.id, rule.id):
            fired.append(
                {"rule_id": rule.id, "event": rule.event_name, "status": "skipped", "reason": "já disparou para esse lead"}
            )
            continue

        conv = await fire_event(
            session,
            cfg,
            contact,
            event_name=rule.event_name,
            value=hit["value"],
            currency=rule.currency,
            is_test=rule.is_test,
            note=f'Regra "{rule.keyword}" ({rule.match_mode}) casou em mensagem do {rules_engine.DIRECTION_LABEL.get(direction, direction)}.',
            source="rule",
            rule_id=rule.id,
        )
        rule.hits = (rule.hits or 0) + 1
        rule.last_fired_at = datetime.now(timezone.utc)
        fired.append(
            {
                "rule_id": rule.id,
                "event": rule.event_name,
                "status": "fired",
                "conversion_id": conv.id,
                "value": hit["value"],
            }
        )
    return fired


async def ingest_event(session: AsyncSession, payload: dict, number: WaNumber) -> dict:
    """Processa um POST do webhook da Evolution para uma linha ja autenticada."""
    event = event_name(payload)
    global_cfg = await settings_store.load(session)
    cfg = numbers_service.effective_cfg(global_cfg, number)

    result: dict = {
        "event": event,
        "instance": instance_name(payload),
        "wa_number_id": number.id,
        "messages": 0,
        "new_contacts": 0,
        "contact_ids": [],
        "rules": [],
        "ignored": None,
    }

    # O log do webhook entra ANTES de processar: e ele que guarda o payload
    # inteiro (envelope + lote), e cada mensagem gravada aponta pra ele em
    # `webhook_log_id`. Sem isso, a tela so tinha `Message.raw` (a mensagem
    # sozinha) e nao havia como dizer QUAL POST a trouxe. O resumo so existe no
    # fim, entao ele e preenchido la — no mesmo commit.
    log_entry = WebhookLog(
        payload=payload,
        phone_number_id=number.evo_instance,
        wa_number_id=number.id,
    )
    session.add(log_entry)
    await session.flush()
    result["webhook_log_id"] = log_entry.id

    if event in STATE_EVENTS:
        state = (payload.get("data") or {}).get("state") if isinstance(payload.get("data"), dict) else None
        if state:
            number.evo_state = str(state)
        result["state"] = state
    elif event in MESSAGE_EVENTS:
        rules = await _rules_for(session, number.id)
        auto_event = (cfg.get("auto_fire_event_name") or "Contact").strip()

        for message in _as_messages(payload):
            phone, lid = identity_of(message)
            wa_id = phone or lid
            if not wa_id:
                continue  # grupo, status ou jid que nao representa pessoa
            if phone is None:
                # conversa que so se identifica por LID. Nao e erro, mas tambem nao
                # e normal: sem telefone, a conversao nao tem o que mandar pro Meta.
                result["lid_sem_telefone"] = result.get("lid_sem_telefone", 0) + 1

            from_me = is_from_me(message)
            direction = "attendant" if from_me else "customer"
            text = text_of(message)
            referral = ad_referral(message)
            attribution = extract(referral, None if from_me else text)

            contact, created = await upsert_contact(
                session,
                wa_id,
                None if from_me else (message.get("pushName") or None),
                attribution,
                numbers_service.evo_routing_key(number.evo_instance or ""),
                number.id,
                lid=lid,
            )
            if created:
                result["new_contacts"] += 1
                contact.origin = "simulado" if payload.get("simulated") else "webhook"
            await session.flush()

            if not from_me and not contact.first_message and text:
                contact.first_message = text

            if not from_me and phone:
                # sem telefone (conversa so com LID) nao da pra casar com prospect:
                # o LID nao e numero, e comparar por ele acharia par errado.
                await link_prospect(session, contact)

            wamid = message_id_of(message)
            if wamid:
                dup = await session.execute(select(Message.id).where(Message.wamid == wamid))
                if dup.scalar_one_or_none() is not None:
                    continue  # a Evolution reentrega o mesmo evento; nao duplica nada

            stamp = sent_at_of(message)
            session.add(
                Message(
                    contact_id=contact.id,
                    wamid=wamid,
                    direction="out" if from_me else "in",
                    msg_type=message.get("messageType"),
                    body=text,
                    raw=message,
                    webhook_log_id=log_entry.id,
                    sent_at=stamp,
                )
            )
            result["messages"] += 1
            result["contact_ids"].append(contact.id)

            # --- resumo pro CRM da linha ---
            # A lista de conversas precisa da ultima mensagem e do nao-lido sem
            # varrer `messages` por contato; e aqui que esses campos se mantem.
            current = as_utc(contact.last_message_at)
            if current is None or stamp >= current:
                contact.last_message_at = stamp
                contact.last_message_body = text
                contact.last_message_from_me = from_me

            if from_me:
                contact.unread_count = 0
                if contact.stage == "novo":
                    # o atendente respondeu: o card sai de "novo" sozinho. Etapa
                    # movida a mao nunca e rebaixada por isso.
                    contact.stage = "atendendo"
                    contact.stage_changed_at = datetime.now(timezone.utc)
            else:
                contact.unread_count = (contact.unread_count or 0) + 1

            # primeiro contato atribuido: manda o evento leve na hora, se ligado
            if created and not from_me and contact.ctwa_clid and cfg.get("auto_fire_on_first_message"):
                conv = await fire_event(
                    session,
                    cfg,
                    contact,
                    event_name=auto_event,
                    note="Disparo automático no primeiro contato vindo de anúncio.",
                    source="auto",
                )
                result["rules"].append(
                    {"rule_id": None, "event": auto_event, "status": "fired", "conversion_id": conv.id}
                )

            result["rules"].extend(await _apply_rules(session, cfg, contact, text, direction, rules))
    else:
        result["ignored"] = f"evento {event or 'sem nome'} não usado no rastreio"

    result["contact_ids"] = sorted(set(result["contact_ids"]))
    fired = [r for r in result["rules"] if r["status"] == "fired"]
    parts = [f"[{event or 'sem evento'}]"]
    if result["messages"]:
        parts.append(f"{result['messages']} msg(s), {result['new_contacts']} lead(s) novo(s)")
    if fired:
        parts.append(f"{len(fired)} evento(s) disparado(s) por regra")
    if result["ignored"]:
        parts.append(result["ignored"])
    summary = " — ".join(parts)

    log_entry.summary = summary
    await session.commit()
    result["summary"] = summary
    return result


def build_simulated_payload(
    *,
    instance: str,
    wa_id: str,
    name: str,
    text: str,
    ctwa_clid: str | None,
    ad_id: str | None,
    source_url: str | None,
    from_me: bool = False,
) -> dict:
    """Payload no formato exato da Evolution — testa o fluxo sem anuncio no ar."""
    now = int(datetime.now(timezone.utc).timestamp())
    content: dict = {"conversation": text}
    if ctwa_clid or ad_id or source_url:
        content = {
            "extendedTextMessage": {
                "text": text,
                "contextInfo": {
                    "externalAdReply": {
                        "title": "Anúncio simulado",
                        "body": "Clique aqui e fale no WhatsApp",
                        "mediaType": "IMAGE",
                        "sourceType": "ad",
                        "sourceId": ad_id or "",
                        "sourceUrl": source_url or "https://fb.me/simulado",
                        "ctwaClid": ctwa_clid or "",
                    }
                },
            }
        }

    return {
        "event": "messages.upsert",
        "instance": instance,
        "data": {
            "key": {
                "remoteJid": f"{wa_id}@s.whatsapp.net",
                "fromMe": from_me,
                "id": f"SIM{now}{wa_id[-4:]}",
            },
            "pushName": name,
            "message": content,
            "messageType": "extendedTextMessage" if "extendedTextMessage" in content else "conversation",
            "messageTimestamp": now,
        },
        "date_time": datetime.now(timezone.utc).isoformat(),
        "simulated": True,
    }
