"""Campanhas de disparo: mensagem de venda para os contatos do CRM de uma linha.

Fluxo: filtra a audiencia no CRM -> manda um TESTE pro proprio numero -> cria a
campanha (a audiencia e congelada em `broadcast_recipients`) -> inicia -> um
worker em background envia um por um, respeitando intervalo, janela de horario e
limite diario DA LINHA.

Anti-bloqueio (Evolution conecta como aparelho pareado, nao e API oficial):

* intervalo minimo + sorteio de alguns segundos a mais entre envios;
* spintax `{Oi|Olá|E aí}`: cada pessoa recebe uma variacao do texto;
* limite diario por linha e janela de horario comercial;
* quem responde "SAIR" e descadastrado e nenhuma campanha inclui de novo;
* falhas seguidas pausam a campanha — quase sempre e a linha que caiu, e seguir
  enviando so queimaria a lista inteira em `failed`.

Na Cloud API, mensagem fora da janela de 24h so entrega por template aprovado
pela Meta. Isso e regra da Meta, nao daqui.
"""

import asyncio
import logging
import os
import random
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import campaigns as campaigns_service
from app import numbers as numbers_service
from app import settings_store
from app.db import SessionLocal
from app.models import Broadcast, BroadcastRecipient, Contact, Message, WaNumber
from app.services import evolution, whatsapp_cloud

log = logging.getLogger(__name__)

TZ = ZoneInfo(os.getenv("BROADCAST_TZ", "America/Sao_Paulo"))

# falhas seguidas numa campanha antes de pausar sozinha
MAX_CONSECUTIVE_FAILS = 3
# piso do intervalo: abaixo disso o numero vira alvo facil de bloqueio
MIN_THROTTLE_SECONDS = 5

OPT_OUT_WORDS = {
    "sair", "parar", "pare", "stop", "cancelar", "descadastrar", "remover",
    "nao quero", "nao quero mais", "nao quero receber", "nao envie mais",
}
OPT_OUT_FOOTER = "\n\n_Responda SAIR para não receber mais mensagens._"


# ---------------------------------------------------------------------------
# texto
# ---------------------------------------------------------------------------

_SPIN = re.compile(r"\{([^{}]*\|[^{}]*)\}")


def spin(text: str, rng: random.Random | None = None) -> str:
    """`{Oi|Olá}` -> uma das opcoes. So grupos com `|`: `{nome}` fica intacto."""
    rng = rng or random
    while True:
        new = _SPIN.sub(lambda m: rng.choice(m.group(1).split("|")), text)
        if new == text:
            return new
        text = new


def variables(contact: Contact | None, campaign_name: str | None = None) -> dict[str, str]:
    name = ((contact.name if contact else None) or "").strip()
    return {
        "{nome}": name,
        "{primeiro_nome}": name.split()[0] if name else "",
        "{telefone}": (contact.phone_e164 if contact else None) or "",
        "{campanha}": campaign_name or "",
    }


def fill(text: str, values: dict[str, str]) -> str:
    out = text
    for token, value in values.items():
        out = out.replace(token, value)
    # variavel vazia ("Oi {primeiro_nome}, tudo bem?") nao pode deixar "Oi , tudo bem?"
    out = re.sub(r"[ \t]+([,!?.;:])", r"\1", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return out.strip()


def render(text: str, contact: Contact | None, campaign_name: str | None = None, rng=None) -> str:
    return fill(spin(text, rng), variables(contact, campaign_name))


def _normalize(text: str) -> str:
    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z ]", "", plain.lower()).strip()


def is_opt_out(text: str | None) -> bool:
    """A mensagem INTEIRA e o pedido. "vou parar no caminho" nao descadastra ninguem."""
    if not text or len(text) > 40:
        return False
    return _normalize(text) in OPT_OUT_WORDS


def register_opt_out(contact: Contact, text: str | None) -> bool:
    """Chamado na entrada de cada mensagem do cliente. True se descadastrou agora."""
    if contact.opted_out_at is None and is_opt_out(text):
        contact.opted_out_at = datetime.now(timezone.utc)
        return True
    return False


# ---------------------------------------------------------------------------
# destino e payload
# ---------------------------------------------------------------------------


def destination(contact: Contact, channel: str) -> str | None:
    """Para quem enviar. Conversa so com LID: na Evolution vai pelo jid do LID;
    na Cloud API nao ha como (ela so fala com telefone)."""
    lid_only = bool(contact.wa_lid and contact.wa_id == contact.wa_lid)
    if channel == "evolution":
        return f"{contact.wa_lid}@lid" if lid_only else contact.wa_id
    return None if lid_only else (contact.wa_id or None)


def build_payload(broadcast: Broadcast, channel: str, to: str, contact: Contact | None, rng=None) -> tuple[dict, str]:
    """(request, texto que a pessoa ve). Na Cloud, template; na Evolution, texto."""
    if channel == "evolution" or broadcast.kind == "text":
        body = render(broadcast.text or "", contact, broadcast.name, rng)
        if not body:
            raise ValueError("Mensagem vazia.")
        if channel == "evolution":
            return evolution.build_text_payload(to, body), body
        return whatsapp_cloud.build_text_payload(to, body), body

    if not broadcast.template_name:
        raise ValueError("Linha da Cloud API: escolha um template aprovado.")
    values = variables(contact, broadcast.name)
    params = [fill(p, values) for p in (broadcast.template_params or [])]
    request = whatsapp_cloud.build_template_payload(
        to, broadcast.template_name, broadcast.template_language or "pt_BR", params
    )
    preview = f"[template {broadcast.template_name}]" + (f" {' | '.join(params)}" if params else "")
    return request, preview


async def send(cfg: dict, channel: str, request: dict) -> tuple[int, dict, str | None]:
    """Envia pelo canal da linha. Devolve (http_status, corpo, id da mensagem)."""
    if channel == "evolution":
        status, body = await evolution.send_message(cfg, request)
        body = body if isinstance(body, dict) else {"data": body}
        return status, body, evolution.first_message_id(body)
    status, body = await whatsapp_cloud.send_message(cfg, request)
    body = body if isinstance(body, dict) else {"data": body}
    if status >= 400:
        raise RuntimeError(str(body.get("error") or body))
    return status, body, whatsapp_cloud.first_wamid(body)


# ---------------------------------------------------------------------------
# audiencia
# ---------------------------------------------------------------------------


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


async def audience(session: AsyncSession, number: WaNumber, cfg: dict, filters: dict) -> tuple[list[Contact], dict]:
    """Contatos da linha que entram na campanha + quantos cairam em cada barreira.

    Filtros: `stages`, `channels` (meta_ads, google_ads, utm, organic, agenda),
    `source_keys` (campanha de origem), `inactive_days` (sem falar ha N dias),
    `active_days` (falou nos ultimos N dias), `exclude_recent_days` (nao recebeu
    campanha nos ultimos N dias), `contact_ids` (lista explicita) e `q`.
    """
    stmt = select(Contact).where(Contact.wa_number_id == number.id)
    if filters.get("contact_ids"):
        stmt = stmt.where(Contact.id.in_(filters["contact_ids"]))
    if filters.get("stages"):
        stmt = stmt.where(Contact.stage.in_(filters["stages"]))
    if filters.get("q"):
        like = f"%{str(filters['q']).strip()}%"
        stmt = stmt.where(Contact.name.ilike(like) | Contact.wa_id.ilike(like) | Contact.note.ilike(like))
    rows = (await session.execute(stmt.order_by(Contact.id))).scalars().all()

    now = datetime.now(timezone.utc)
    inactive = int(filters.get("inactive_days") or 0)
    active = int(filters.get("active_days") or 0)
    recent = int(filters.get("exclude_recent_days") or 0)
    channels = set(filters.get("channels") or [])
    keys = set(filters.get("source_keys") or [])

    recently_hit: set[int] = set()
    if recent:
        since = now - timedelta(days=recent)
        recently_hit = set(
            (
                await session.execute(
                    select(BroadcastRecipient.contact_id).where(
                        BroadcastRecipient.wa_number_id == number.id,
                        BroadcastRecipient.status == "sent",
                        BroadcastRecipient.sent_at >= since,
                    )
                )
            ).scalars().all()
        )

    known = {}
    if channels or keys:
        known = await campaigns_service.campaigns_for(session, (c.source_id for c in rows))

    channel = number.channel or "evolution"
    out: list[Contact] = []
    dropped = {"opted_out": 0, "no_destination": 0, "recent": 0, "filtered": 0}
    for c in rows:
        if c.opted_out_at is not None:
            dropped["opted_out"] += 1
            continue
        if not destination(c, channel):
            dropped["no_destination"] += 1
            continue
        if c.id in recently_hit:
            dropped["recent"] += 1
            continue
        last = _as_utc(c.last_message_at)
        if inactive and last is not None and last > now - timedelta(days=inactive):
            dropped["filtered"] += 1
            continue
        if active and (last is None or last < now - timedelta(days=active)):
            dropped["filtered"] += 1
            continue
        if channels or keys:
            src = campaigns_service.lead_source(c, known.get(c.source_id or ""), cfg)
            if channels and src["channel"] not in channels:
                dropped["filtered"] += 1
                continue
            if keys and src["key"] not in keys:
                dropped["filtered"] += 1
                continue
        out.append(c)
    return out, dropped


# ---------------------------------------------------------------------------
# contagens
# ---------------------------------------------------------------------------


async def counts(session: AsyncSession, broadcast_ids: list[int]) -> dict[int, dict]:
    """Por campanha: status dos envios e quantos RESPONDERAM depois de receber."""
    out = {
        bid: {"total": 0, "queued": 0, "sent": 0, "failed": 0, "skipped": 0, "replied": 0}
        for bid in broadcast_ids
    }
    if not broadcast_ids:
        return out
    rows = (
        await session.execute(
            select(BroadcastRecipient.broadcast_id, BroadcastRecipient.status, func.count())
            .where(BroadcastRecipient.broadcast_id.in_(broadcast_ids))
            .group_by(BroadcastRecipient.broadcast_id, BroadcastRecipient.status)
        )
    ).all()
    for bid, status, n in rows:
        out[bid][status] = out[bid].get(status, 0) + n
        out[bid]["total"] += n

    replied = (
        await session.execute(
            select(BroadcastRecipient.broadcast_id, func.count(func.distinct(BroadcastRecipient.id)))
            .join(Message, Message.contact_id == BroadcastRecipient.contact_id)
            .where(
                BroadcastRecipient.broadcast_id.in_(broadcast_ids),
                BroadcastRecipient.status == "sent",
                Message.direction == "in",
                Message.sent_at > BroadcastRecipient.sent_at,
            )
            .group_by(BroadcastRecipient.broadcast_id)
        )
    ).all()
    for bid, n in replied:
        out[bid]["replied"] = n
    return out


async def replied_ids(session: AsyncSession, broadcast_id: int) -> set[int]:
    return set(
        (
            await session.execute(
                select(BroadcastRecipient.id)
                .join(Message, Message.contact_id == BroadcastRecipient.contact_id)
                .where(
                    BroadcastRecipient.broadcast_id == broadcast_id,
                    BroadcastRecipient.status == "sent",
                    Message.direction == "in",
                    Message.sent_at > BroadcastRecipient.sent_at,
                )
            )
        ).scalars().all()
    )


async def sent_last_24h(session: AsyncSession, number_id: int | None) -> int:
    since = datetime.now(timezone.utc) - timedelta(days=1)
    return (
        await session.execute(
            select(func.count(BroadcastRecipient.id)).where(
                BroadcastRecipient.wa_number_id == number_id,
                BroadcastRecipient.status == "sent",
                BroadcastRecipient.sent_at >= since,
            )
        )
    ).scalar_one()


# ---------------------------------------------------------------------------
# fila
# ---------------------------------------------------------------------------


def in_window(broadcast: Broadcast, now: datetime | None = None) -> bool:
    start, end = broadcast.window_start_hour, broadcast.window_end_hour
    if start is None or end is None or start == end:
        return True  # janela desligada: qualquer hora
    hour = (now or datetime.now(TZ)).astimezone(TZ).hour
    return start <= hour < end if start < end else hour >= start or hour < end


_worker: asyncio.Task | None = None
# quando cada linha pode enviar de novo (monotonic). O intervalo e por linha:
# duas linhas disparando em paralelo nao atrasam uma a outra.
_next_at: dict[int | None, float] = {}


def start_worker() -> None:
    """Sobe o worker se ainda nao houver um rodando. Idempotente."""
    global _worker
    if _worker is not None and not _worker.done():
        return
    _worker = asyncio.create_task(_drain())


async def _drain() -> None:
    """Esvazia as campanhas `running`. Sessao propria: vive fora da requisicao."""
    loop = asyncio.get_running_loop()
    fails: dict[int, int] = {}
    while True:
        wait: float | None = None
        async with SessionLocal() as session:
            running = (
                await session.execute(select(Broadcast).where(Broadcast.status == "running").order_by(Broadcast.id))
            ).scalars().all()
            if not running:
                return

            global_cfg = await settings_store.load(session)
            progressed = False
            for broadcast in running:
                line = broadcast.wa_number_id
                ready_at = _next_at.get(line, 0)
                if ready_at > loop.time():
                    wait = min(wait or 1e9, ready_at - loop.time())
                    continue
                if not in_window(broadcast):
                    wait = min(wait or 1e9, 60)
                    continue
                if broadcast.daily_cap and await sent_last_24h(session, line) >= broadcast.daily_cap:
                    wait = min(wait or 1e9, 300)  # volta a olhar daqui a 5 min
                    continue

                record = (
                    await session.execute(
                        select(BroadcastRecipient)
                        .where(BroadcastRecipient.broadcast_id == broadcast.id, BroadcastRecipient.status == "queued")
                        .order_by(BroadcastRecipient.id)
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if record is None:
                    broadcast.status = "done"
                    broadcast.finished_at = datetime.now(timezone.utc)
                    await session.commit()
                    progressed = True
                    continue

                number = await session.get(WaNumber, line) if line is not None else None
                if number is None:
                    broadcast.status = "paused"
                    broadcast.pause_reason = "A linha da campanha não existe mais."
                    await session.commit()
                    continue

                contact = await session.get(Contact, record.contact_id) if record.contact_id else None
                if contact is not None and contact.opted_out_at is not None:
                    record.status = "skipped"
                    record.error = "Descadastrou (SAIR) antes do envio."
                    await session.commit()
                    progressed = True
                    continue

                cfg = numbers_service.effective_cfg(global_cfg, number)
                await _send_one(session, cfg, number.channel or "evolution", broadcast, record, contact)
                progressed = True

                if record.status == "failed":
                    fails[broadcast.id] = fails.get(broadcast.id, 0) + 1
                    if fails[broadcast.id] >= MAX_CONSECUTIVE_FAILS:
                        broadcast.status = "paused"
                        broadcast.pause_reason = (
                            f"{MAX_CONSECUTIVE_FAILS} falhas seguidas — confira se a linha está conectada. "
                            f"Último erro: {record.error}"
                        )
                        fails[broadcast.id] = 0
                        await session.commit()
                else:
                    fails[broadcast.id] = 0

                delay = max(MIN_THROTTLE_SECONDS, broadcast.throttle_seconds or 0)
                delay += random.uniform(0, max(0, broadcast.jitter_seconds or 0))
                _next_at[line] = loop.time() + delay

        if not progressed:
            await asyncio.sleep(max(1.0, min(wait or 5.0, 300)))


async def _send_one(
    session: AsyncSession,
    cfg: dict,
    channel: str,
    broadcast: Broadcast,
    record: BroadcastRecipient,
    contact: Contact | None,
) -> None:
    """Monta (texto sorteado na hora do envio), grava o request ANTES e envia."""
    try:
        request, body = build_payload(broadcast, channel, record.to, contact)
    except ValueError as exc:
        record.status = "failed"
        record.error = str(exc)
        await session.commit()
        return

    record.request_payload = request
    record.body = body
    await session.flush()
    try:
        status, response, wamid = await send(cfg, channel, request)
        record.http_status = status
        record.response_body = response
        record.wamid = wamid
        record.status = "sent"
        record.sent_at = datetime.now(timezone.utc)
    except Exception as exc:  # noqa: BLE001 — o motivo cru e o que a tela mostra
        record.status = "failed"
        record.error = str(exc)[:2000]
    await session.commit()


async def resume_pending() -> None:
    """Startup: campanha que estava rodando quando o backend caiu volta a andar."""
    async with SessionLocal() as session:
        running = (
            await session.execute(select(func.count(Broadcast.id)).where(Broadcast.status == "running"))
        ).scalar_one()
    if running:
        log.info("retomando %s campanha(s) de disparo", running)
        start_worker()
