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

from app import campaigns as campaigns_service
from app import journey as journey_service
from app import crm as crm_service
from app import numbers as numbers_service
from app import settings_store
from app.db import get_session
from app.evolution_ingest import ad_referral, apply_ad_attribution, is_from_me
from app.models import CONTACT_STAGES, AdCampaign, Contact, Conversion, Message, WaNumber, WebhookLog
from app.services import evolution, meta_ads

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/crm", tags=["crm"])

STAGE_LABELS = {
    "novo": "Novo",
    "atendendo": "Atendendo",
    "qualificado": "Qualificado",
    "ganho": "Ganho",
    "perdido": "Perdido",
}


def serialize(
    contact: Contact,
    conversions: int = 0,
    campaign: AdCampaign | None = None,
    cfg: dict | None = None,
) -> dict:
    return {
        "id": contact.id,
        "wa_id": contact.wa_id,
        "wa_lid": contact.wa_lid,
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
            "ad_source_app": contact.ad_source_app,
            "gclid": contact.gclid,
            "wbraid": contact.wbraid,
            "gbraid": contact.gbraid,
            "utm": contact.utm or {},
        },
        "attributable_meta": bool(contact.ctwa_clid),
        "attributable_google": bool(contact.gclid or contact.wbraid or contact.gbraid),
        # etiqueta "de onde veio": canal, campanha, objetivo e o evento que ele pede
        "source": campaigns_service.lead_source(contact, campaign, cfg),
        # referencia a jornada do site (TL_ID, first/last touch, metodo do match)
        "journey": journey_service.contact_journey_fields(contact),
    }


class _CfgCache:
    """Config efetiva por linha, carregada uma vez por requisicao."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.global_cfg: dict | None = None
        self.by_number: dict[int | None, dict] = {}

    async def get(self, number_id: int | None) -> dict:
        if number_id not in self.by_number:
            if self.global_cfg is None:
                self.global_cfg = await settings_store.load(self.session)
            number = await self.session.get(WaNumber, number_id) if number_id is not None else None
            self.by_number[number_id] = numbers_service.effective_cfg(self.global_cfg, number)
        return self.by_number[number_id]


async def _serialize_many(session: AsyncSession, rows, counts: dict | None = None) -> list[dict]:
    """Serializa varias conversas com uma consulta so de campanha.

    Anuncio que ainda nao tem campanha no cache e mandado resolver em segundo
    plano: a lista responde na hora, e a etiqueta aparece na proxima leitura.
    """
    counts = counts or {}
    known = await campaigns_service.campaigns_for(session, (c.source_id for c in rows))
    cache = _CfgCache(session)
    out = []
    pending: dict[int | None, set[str]] = {}
    for c in rows:
        cfg = await cache.get(c.wa_number_id)
        out.append(serialize(c, counts.get(c.id, 0), known.get(c.source_id or ""), cfg))
        if c.source_id and c.source_id not in known:
            pending.setdefault(c.wa_number_id, set()).add(c.source_id)
    for number_id, ad_ids in pending.items():
        campaigns_service.schedule_resolve(await cache.get(number_id), ad_ids)
    return out


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
    return await _serialize_many(session, rows, counts)


@router.get("/campaigns")
async def campaigns(
    number_id: int | None = Query(default=None), session: AsyncSession = Depends(get_session)
):
    """Leads agrupados por origem/campanha — o filtro e o resumo do topo do CRM."""
    stmt = select(Contact)
    if number_id is not None:
        stmt = stmt.where(Contact.wa_number_id == number_id)
    rows = (await session.execute(stmt)).scalars().all()

    conv_stmt = select(Conversion.contact_id, func.count()).group_by(Conversion.contact_id)
    counts = dict((await session.execute(conv_stmt)).all())

    groups: dict[str, dict] = {}
    for item in await _serialize_many(session, rows, counts):
        src = item["source"]
        g = groups.setdefault(
            src["key"],
            {
                "key": src["key"],
                "channel": src["channel"],
                "channel_label": src["channel_label"],
                "platform": src["platform"],
                "campaign_name": src["campaign_name"],
                "campaign_id": src["campaign_id"],
                "objective": src["objective"],
                "objective_label": src["objective_label"],
                "suggested_event": src["suggested_event"],
                "ad_ids": [],
                "contacts": 0,
                "won": 0,
                "with_conversion": 0,
            },
        )
        g["contacts"] += 1
        g["won"] += 1 if item["stage"] == "ganho" else 0
        g["with_conversion"] += 1 if item["conversions"] else 0
        if src["ad_id"] and src["ad_id"] not in g["ad_ids"]:
            g["ad_ids"].append(src["ad_id"])

    cfg = await _CfgCache(session).get(number_id)
    return {
        "has_ads_token": bool(meta_ads.ads_token(cfg)),
        "groups": sorted(groups.values(), key=lambda g: (-g["contacts"], g["key"])),
        "objectives": [
            {
                "value": o,
                "label": meta_ads.objective_label(o),
                "event": meta_ads.event_for_objective(o, cfg),
                "default_event": meta_ads.OBJECTIVE_EVENTS.get(o),
            }
            for o in meta_ads.EDITABLE_OBJECTIVES
        ],
    }


@router.post("/campaigns/resolve")
async def resolve_campaigns(
    number_id: int | None = Query(default=None),
    force: bool = Query(default=False, description="consulta de novo até o que já foi resolvido"),
    session: AsyncSession = Depends(get_session),
):
    """Consulta na Marketing API a campanha dos anúncios dos leads dessa linha."""
    cfg = await _CfgCache(session).get(number_id)
    return await campaigns_service.resolve_for_number(session, cfg, number_id, force=force)


class CampaignIn(BaseModel):
    campaign_name: str | None = None
    adset_name: str | None = None
    ad_name: str | None = None
    objective: str | None = None


@router.put("/campaigns/{ad_id}")
async def set_campaign(ad_id: str, payload: CampaignIn, session: AsyncSession = Depends(get_session)):
    """Campanha preenchida à mão — para quem não tem token com `ads_read`.

    Fica marcada como manual e a consulta automática nunca a sobrescreve.
    Mandar tudo vazio desfaz o manual e devolve o anúncio para a consulta.
    """
    row = await session.get(AdCampaign, ad_id)
    fields = payload.model_dump()
    if not any((v or "").strip() for v in fields.values()):
        if row is not None:
            await session.delete(row)
            await session.commit()
        return {"ad_id": ad_id, "removed": True}

    if payload.objective and payload.objective not in meta_ads.OBJECTIVE_LABEL:
        raise HTTPException(status_code=400, detail=f"Objetivo desconhecido: {payload.objective}")
    if row is None:
        row = AdCampaign(ad_id=ad_id)
        session.add(row)
    for key, value in fields.items():
        setattr(row, key, (value or "").strip() or None)
    row.manual = True
    row.status = "manual"
    row.error = None
    await session.commit()
    await session.refresh(row)
    return campaigns_service.serialize_campaign(row)


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


@router.get("/activity")
async def activity(
    number_id: int | None = Query(default=None), session: AsyncSession = Depends(get_session)
):
    """Cursor barato de mudanca — e o que faz a tela do CRM se atualizar sozinha.

    A tela pergunta por isto de poucos em poucos segundos. Enquanto o `cursor`
    for o mesmo, nada mudou e nada e recarregado; quando muda (mensagem nova,
    conversa nova, etapa movida, lida/nao lida, conversao disparada) a tela
    refaz as consultas pesadas. Sao cinco agregacoes em coluna indexada: barato
    o bastante pra rodar a cada poucos segundos com a tela aberta o dia todo.
    """

    def scoped(stmt):
        return stmt if number_id is None else stmt.where(Contact.wa_number_id == number_id)

    contacts = (await session.execute(scoped(select(func.count(Contact.id))))).scalar_one()
    # `last_seen_at` tem onupdate: qualquer mexida na conversa (etapa, nota,
    # marcar como lida, mensagem nova) empurra esse relogio pra frente.
    touched = (await session.execute(scoped(select(func.max(Contact.last_seen_at))))).scalar_one()
    unread = (
        await session.execute(scoped(select(func.coalesce(func.sum(Contact.unread_count), 0))))
    ).scalar_one()

    msg_stmt = select(func.count(Message.id), func.max(Message.id))
    if number_id is not None:
        msg_stmt = msg_stmt.join(Contact, Message.contact_id == Contact.id).where(
            Contact.wa_number_id == number_id
        )
    messages, last_message_id = (await session.execute(msg_stmt)).one()

    conv_stmt = select(func.count(Conversion.id))
    if number_id is not None:
        conv_stmt = conv_stmt.join(Contact, Conversion.contact_id == Contact.id).where(
            Contact.wa_number_id == number_id
        )
    conversions = (await session.execute(conv_stmt)).scalar_one()

    # o SQLite devolve datas agregadas ora como datetime, ora como texto — pro
    # cursor tanto faz, desde que seja sempre a mesma forma pra mesma data
    stamp = touched.isoformat() if hasattr(touched, "isoformat") else str(touched or "-")

    return {
        "contacts": contacts,
        "messages": messages,
        "last_message_id": last_message_id or 0,
        "unread": int(unread or 0),
        "conversions": conversions,
        "last_activity_at": touched,
        # a tela compara so isto: mudou a string, recarrega
        "cursor": (
            f"{contacts}:{messages}:{last_message_id or 0}:{int(unread or 0)}:{conversions}:{stamp}"
        ),
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

    app_before = contact.ad_source_app
    if not contact.ctwa_clid or (contact.source_id and not contact.ad_source_app):
        # Confere o payload de cada mensagem gravada. O `externalAdReply` pode ter
        # entrado por um caminho que nao olhava o anuncio (sync antigo, historico
        # puxado antes da correcao); se esta no `raw` que a tela mostra, o lead
        # tem que sair daqui atribuido — nao na proxima rodada do sync.
        found = [apply_ad_attribution(contact, m.raw or {}) for m in msgs]
        if any(found):
            log.info("contato %s: ctwa_clid achado no payload de uma mensagem gravada", contact.id)
        if any(found) or contact.ad_source_app != app_before:
            await session.commit()
            await session.refresh(contact)

    cfg = await _CfgCache(session).get(contact.wa_number_id)
    # abrir a conversa e a hora de saber a campanha: consulta aqui mesmo se faltar
    campaign = (
        await campaigns_service.resolve_ad(session, cfg, contact.source_id) if contact.source_id else None
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
        **serialize(contact, len(convs), campaign, cfg),
        "messages": [
            {
                "id": m.id,
                "direction": m.direction,
                "type": m.msg_type,
                "body": m.body,
                "sent_at": m.sent_at,
                "wamid": m.wamid,
                # o payload cru NAO vem aqui: uma conversa com anexo carrega
                # miniatura em base64, e 300 mensagens dessas travariam a tela.
                # Quem quiser ver pede a mensagem especifica em /messages/{id}/payload.
                "has_payload": bool(m.raw) or m.webhook_log_id is not None,
            }
            for m in msgs
        ],
        "conversion_events": [serialize_conversion(c) for c in convs],
    }


@router.get("/messages/{message_id}/payload")
async def message_payload(message_id: int, session: AsyncSession = Depends(get_session)):
    """Tudo que chegou nessa mensagem: o objeto cru + o POST inteiro do webhook.

    Duas camadas, porque sao coisas diferentes e as duas fazem falta na hora de
    entender por que um lead nao foi atribuido:

    * `raw` — o objeto da mensagem como o WhatsApp mandou (`key`, `message`,
      `contextInfo.externalAdReply`, `messageTimestamp`);
    * `webhook` — o POST inteiro em que ela veio: envelope (`event`, `instance`,
      `date_time`), o lote todo e o resumo do que o sistema fez com ele.

    Mensagem trazida pelo "puxar historico" nao tem webhook: ela foi buscada na
    Evolution, nao entregue por ela. Nesse caso `webhook` vem nulo e so `raw` existe.
    """
    message = await session.get(Message, message_id)
    if message is None:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada.")

    log_row = (
        await session.get(WebhookLog, message.webhook_log_id)
        if message.webhook_log_id is not None
        else None
    )

    return {
        "id": message.id,
        "contact_id": message.contact_id,
        "wamid": message.wamid,
        "direction": message.direction,
        "type": message.msg_type,
        "body": message.body,
        "sent_at": message.sent_at,
        "raw": message.raw or {},
        # o que o sistema le do anuncio nesse payload — e o que decide a atribuicao.
        # `ignored_from_me`: bloco de anuncio em mensagem enviada pela propria linha
        # nao conta (e o aparelho clicando no anuncio de outra empresa).
        "ad": ad_referral(message.raw or {}),
        "ad_ignored_from_me": bool(message.raw) and is_from_me(message.raw),
        "webhook": None
        if log_row is None
        else {
            "id": log_row.id,
            "summary": log_row.summary,
            "created_at": log_row.created_at,
            "instance": log_row.phone_number_id,
            "wa_number_id": log_row.wa_number_id,
            "payload": log_row.payload,
        },
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
    return (await _serialize_many(session, [contact]))[0]


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

    # Conversa que so se identifica por LID: o destino tem de ser o jid do LID.
    # O `wa_id` dela nao e telefone, e a Evolution nao teria pra quem mandar.
    to = f"{contact.wa_lid}@lid" if contact.wa_lid and contact.wa_id == contact.wa_lid else contact.wa_id

    try:
        body = await evolution.send_text(await _cfg(session, number), to, payload.text)
    except evolution.EvolutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"sent": True, "response": body}
