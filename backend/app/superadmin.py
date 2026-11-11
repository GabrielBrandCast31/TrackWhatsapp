"""Super admin: visao de todos os clientes e o relatorio no WhatsApp do dono.

Cada linha (`WaNumber`) e um cliente conectado. O dono da plataforma quer saber,
sem abrir o painel, quais estao no ar e quanto cada um esta recebendo. Daqui sai:

* `overview`     — o retrato de todas as linhas (estado, leads, quem tem acesso);
* `build_report` — esse retrato em texto de WhatsApp;
* `send_report`  — manda pro numero configurado, por uma linha da Evolution;
* `watch`        — laco de fundo: relatorio diario na hora marcada e alerta quando
                   uma linha cai ou volta.

A config mora em `settings` sob a chave propria `superadmin` (nao se mistura com a
config da plataforma). O envio sai sempre por linha da Evolution: a Cloud API so
aceita texto livre dentro da janela de 24h, entao nao serve pra aviso espontaneo.
"""

import asyncio
import logging
import os
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import numbers as numbers_service
from app import phones, settings_store
from app.attendance import TZ
from app.db import SessionLocal
from app.models import Contact, Setting, User, UserNumber, WaNumber
from app.services import evolution

log = logging.getLogger(__name__)

SETTINGS_KEY = "superadmin"

DEFAULTS: dict = {
    "report_phone": "",          # so digitos, com DDI: 5511999998888
    "sender_number_id": None,    # linha da Evolution que envia; None = primeira conectada
    "daily_enabled": False,
    "daily_time": "08:00",       # no fuso APP_TIMEZONE
    "alert_on_disconnect": True,
    "last_daily_date": None,     # dia (ISO) do ultimo relatorio diario — nao repete
    "last_sent_at": None,
    "last_error": None,
}
EDITABLE = ("report_phone", "sender_number_id", "daily_enabled", "daily_time", "alert_on_disconnect")

# quanto tempo entre duas olhadas do laco. 0 desliga (util em teste)
INTERVAL_SECONDS = int(os.getenv("SUPER_REPORT_POLL_SECONDS", "60"))
# o monitor de estado zera `evo_state` num unico timeout da Evolution: so avisa
# que caiu depois de tantas olhadas seguidas fora do ar, pra nao alertar soluco.
DOWN_ROUNDS = 3

CONNECTED_STATES = ("open", "connected")


class ReportError(Exception):
    pass


# --- config ------------------------------------------------------------------

async def load_settings(session: AsyncSession) -> dict:
    row = await session.get(Setting, SETTINGS_KEY)
    cfg = dict(DEFAULTS)
    if row and isinstance(row.value, dict):
        cfg.update({k: v for k, v in row.value.items() if k in DEFAULTS})
    return cfg


async def _store(session: AsyncSession, patch: dict) -> dict:
    row = await session.get(Setting, SETTINGS_KEY)
    if row is None:
        row = Setting(key=SETTINGS_KEY, value={})
        session.add(row)
    row.value = {**(row.value or {}), **patch}  # dict novo: o JSON so grava se o objeto mudar
    await session.commit()
    return await load_settings(session)


def normalize_phone(value: str | None) -> str:
    """'(11) 99999-8888' -> '5511999998888'. Vazio continua vazio (desliga o envio)."""
    if not (value or "").strip():
        return ""
    e164 = phones.to_e164(value)
    if e164 is None:
        raise ReportError("Número inválido. Use DDI + DDD + número, ex.: 55 11 99999-8888.")
    return phones.digits(e164)


async def save_settings(session: AsyncSession, patch: dict) -> dict:
    clean: dict = {}
    for key in EDITABLE:
        if key not in patch:
            continue
        value = patch[key]
        if key == "report_phone":
            value = normalize_phone(value)
        elif key == "daily_time":
            if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(value or "")):
                raise ReportError("Horário inválido. Use HH:MM, ex.: 08:00.")
        elif key == "sender_number_id":
            if value is not None:
                number = await session.get(WaNumber, int(value))
                if number is None or number.channel != "evolution":
                    raise ReportError("A linha de envio precisa ser uma linha da Evolution.")
                value = number.id
        else:
            value = bool(value)
        clean[key] = value
    return await _store(session, clean)


# --- visao geral -------------------------------------------------------------

def is_connected(number: WaNumber) -> bool:
    if not number.active:
        return False
    if number.channel == "evolution":
        return (number.evo_state or "").lower() in CONNECTED_STATES
    # Cloud API nao tem sessao que cai: esta no ar se tem token e o ultimo teste passou
    return bool(number.access_token) and not number.last_error


def _phone_of(number: WaNumber) -> str | None:
    if number.display_phone_number:
        return number.display_phone_number
    owner = phones.digits((number.evo_owner_jid or "").split("@")[0].split(":")[0])
    return f"+{owner}" if owner else None


async def _lead_counts(session: AsyncSession, since: datetime | None = None) -> dict[int, int]:
    stmt = select(Contact.wa_number_id, func.count(Contact.id)).group_by(Contact.wa_number_id)
    if since is not None:
        stmt = stmt.where(Contact.created_at >= since)
    return {nid: total for nid, total in (await session.execute(stmt)).all() if nid is not None}


async def overview(session: AsyncSession) -> dict:
    """Todas as linhas da plataforma, sem escopo de usuario — e a visao do dono."""
    now = datetime.now(timezone.utc)
    # meia-noite local, de volta em UTC: o SQLite guarda sem fuso e compara cru
    today_start = (
        now.astimezone(TZ).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    )

    total = await _lead_counts(session)
    today = await _lead_counts(session, today_start)
    week = await _lead_counts(session, today_start - timedelta(days=6))
    last_message = dict(
        (
            await session.execute(
                select(Contact.wa_number_id, func.max(Contact.last_message_at)).group_by(Contact.wa_number_id)
            )
        ).all()
    )
    owners: dict[int, list[str]] = {}
    for number_id, username, name in (
        await session.execute(
            select(UserNumber.wa_number_id, User.username, User.name)
            .join(User, User.id == UserNumber.user_id)
            .where(User.active.is_(True))
            .order_by(User.username)
        )
    ).all():
        owners.setdefault(number_id, []).append(name or username)

    lines = []
    for n in await numbers_service.list_numbers(session):
        lines.append(
            {
                "id": n.id,
                "label": n.label,
                "channel": n.channel,
                "instance": n.evo_instance,
                "phone": _phone_of(n),
                "profile_name": n.verified_name,
                "active": n.active,
                "state": n.evo_state if n.channel == "evolution" else None,
                "connected": is_connected(n),
                "last_error": n.last_error,
                "last_checked_at": n.last_checked_at,
                "users": owners.get(n.id, []),
                "leads_total": total.get(n.id, 0),
                "leads_today": today.get(n.id, 0),
                "leads_7d": week.get(n.id, 0),
                "last_message_at": last_message.get(n.id),
            }
        )
    # quem precisa de atencao primeiro: ativa e fora do ar, depois conectadas, depois pausadas
    lines.sort(key=lambda l: (not l["active"], l["connected"], l["label"].lower()))

    live = [l for l in lines if l["active"]]
    return {
        "generated_at": now,
        "lines": lines,
        "totals": {
            "lines": len(lines),
            "active": len(live),
            "connected": sum(1 for l in live if l["connected"]),
            "disconnected": sum(1 for l in live if not l["connected"]),
            "leads_today": sum(l["leads_today"] for l in lines),
            "leads_7d": sum(l["leads_7d"] for l in lines),
            "leads_total": sum(l["leads_total"] for l in lines),
        },
    }


# --- texto -------------------------------------------------------------------

def _line_text(line: dict) -> str:
    head = f"*{line['label']}*" + (f" ({line['phone']})" if line["phone"] else "")
    leads = f"leads: {line['leads_today']} hoje · {line['leads_7d']} em 7 dias"
    return f"{head}\n   {leads}"


def build_report(data: dict) -> str:
    """O retrato em texto de WhatsApp (negrito com asterisco)."""
    t = data["totals"]
    stamp = data["generated_at"].astimezone(TZ).strftime("%d/%m/%Y %H:%M")
    live = [l for l in data["lines"] if l["active"]]
    down = [l for l in live if not l["connected"]]
    up = [l for l in live if l["connected"]]
    paused = [l for l in data["lines"] if not l["active"]]

    parts = [
        f"📊 *Visão geral dos clientes*\n{stamp}",
        f"🟢 Conectados: {t['connected']} de {t['active']}\n"
        f"🔴 Fora do ar: {t['disconnected']}\n"
        f"👥 Leads: {t['leads_today']} hoje · {t['leads_7d']} em 7 dias",
    ]
    if down:
        rows = []
        for l in down:
            reason = (l["last_error"] or l["state"] or "sem resposta").strip()
            rows.append(f"{_line_text(l)}\n   motivo: {reason[:120]}")
        parts.append("🔴 *FORA DO AR*\n" + "\n".join(rows))
    if up:
        parts.append("🟢 *CONECTADOS*\n" + "\n".join(_line_text(l) for l in up))
    if paused:
        parts.append("⏸ *Pausados:* " + ", ".join(l["label"] for l in paused))
    if not data["lines"]:
        parts.append("Nenhuma linha cadastrada ainda.")
    return "\n\n".join(parts)


def build_alert(went_down: list[str], came_back: list[str]) -> str:
    parts = []
    if went_down:
        parts.append("🔴 *Linha fora do ar*\n" + "\n".join(f"• {label}" for label in went_down))
    if came_back:
        parts.append("🟢 *Linha reconectada*\n" + "\n".join(f"• {label}" for label in came_back))
    return "\n\n".join(parts)


# --- envio -------------------------------------------------------------------

def _can_send(number: WaNumber) -> bool:
    return (
        number.channel == "evolution"
        and number.active
        and bool(number.evo_instance)
        and (number.evo_state or "").lower() in CONNECTED_STATES
    )


async def pick_sender(session: AsyncSession, cfg: dict) -> WaNumber:
    """A linha configurada; sem ela (ou com ela fora do ar), a primeira conectada."""
    preferred = None
    if cfg.get("sender_number_id") is not None:
        preferred = await session.get(WaNumber, cfg["sender_number_id"])
        if preferred is not None and _can_send(preferred):
            return preferred
    for number in await numbers_service.list_numbers(session, only_active=True, channel="evolution"):
        if _can_send(number):
            return number
    raise ReportError("Nenhuma linha da Evolution conectada para enviar o relatório.")


async def send_text(session: AsyncSession, text: str, cfg: dict | None = None) -> dict:
    """Manda `text` pro numero do super admin. Devolve por qual linha saiu."""
    cfg = cfg or await load_settings(session)
    to = cfg.get("report_phone") or ""
    if not to:
        raise ReportError("Cadastre o número que recebe o relatório antes de enviar.")
    sender = await pick_sender(session, cfg)
    line_cfg = numbers_service.effective_cfg(await settings_store.load(session), sender)
    try:
        await evolution.send_text(line_cfg, to, text)
    except Exception as exc:  # noqa: BLE001 — erro da Evolution ou de rede, tanto faz
        raise ReportError(f"A linha {sender.label} não conseguiu enviar: {exc}") from exc
    return {"to": to, "sender_id": sender.id, "sender_label": sender.label}


async def send_report(session: AsyncSession) -> dict:
    """Relatorio agora. Guarda quando saiu — ou por que nao saiu — pra tela mostrar."""
    try:
        result = await send_text(session, build_report(await overview(session)))
    except ReportError as exc:
        await _store(session, {"last_error": str(exc)})
        raise
    await _store(session, {"last_sent_at": datetime.now(timezone.utc).isoformat(), "last_error": None})
    return result


# --- laco de fundo -----------------------------------------------------------

def daily_due(cfg: dict, now_local: datetime) -> bool:
    """Passou da hora marcada e o relatorio de hoje ainda nao saiu?"""
    if not cfg.get("daily_enabled") or not cfg.get("report_phone"):
        return False
    if cfg.get("last_daily_date") == now_local.date().isoformat():
        return False
    return now_local.strftime("%H:%M") >= (cfg.get("daily_time") or "08:00")


class StateTracker:
    """Acha quem caiu e quem voltou entre uma olhada e outra.

    A primeira olhada so tira a foto: linha que ja estava fora do ar quando o
    backend subiu nao vira alerta (ela aparece no relatorio).
    """

    def __init__(self, down_rounds: int = DOWN_ROUNDS):
        self.down_rounds = down_rounds
        self._alerted: dict[int, bool] = {}   # linha -> o dono ja foi avisado de que caiu
        self._misses: dict[int, int] = {}
        self._primed = False

    def update(self, states: dict[int, tuple[str, bool]]) -> tuple[list[str], list[str]]:
        """`states`: linha ativa -> (rotulo, conectada). Devolve (cairam, voltaram)."""
        went_down: list[str] = []
        came_back: list[str] = []
        for number_id, (label, connected) in states.items():
            if not self._primed or number_id not in self._alerted:
                # baseline: assume avisado se ja nasceu caida
                self._alerted[number_id] = not connected
                self._misses[number_id] = 0
                continue
            if connected:
                self._misses[number_id] = 0
                if self._alerted[number_id]:
                    self._alerted[number_id] = False
                    came_back.append(label)
                continue
            self._misses[number_id] += 1
            if not self._alerted[number_id] and self._misses[number_id] >= self.down_rounds:
                self._alerted[number_id] = True
                went_down.append(label)
        # linha apagada ou pausada sai do radar
        for gone in set(self._alerted) - set(states):
            self._alerted.pop(gone, None)
            self._misses.pop(gone, None)
        self._primed = True
        return went_down, came_back


async def tick(tracker: StateTracker) -> None:
    async with SessionLocal() as session:
        cfg = await load_settings(session)
        states = {
            n.id: (n.label, is_connected(n))
            for n in await numbers_service.list_numbers(session, only_active=True)
        }
        went_down, came_back = tracker.update(states)
        if (went_down or came_back) and cfg.get("alert_on_disconnect") and cfg.get("report_phone"):
            try:
                await send_text(session, build_alert(went_down, came_back), cfg)
            except ReportError as exc:
                log.warning("alerta do super admin nao saiu: %s", exc)

        now_local = datetime.now(TZ)
        if daily_due(cfg, now_local):
            # marca o dia ANTES de enviar: se o envio falhar, nao tenta de minuto em minuto
            await _store(session, {"last_daily_date": now_local.date().isoformat()})
            try:
                await send_report(session)
                log.info("relatorio diario do super admin enviado")
            except ReportError as exc:
                log.warning("relatorio diario do super admin nao saiu: %s", exc)


async def watch() -> None:
    """Laco de fundo. Nunca morre por erro de uma rodada — so registra e segue."""
    if INTERVAL_SECONDS <= 0:
        log.info("relatorio do super admin desligado (SUPER_REPORT_POLL_SECONDS=0)")
        return
    tracker = StateTracker()
    # deixa o monitor de estado rodar primeiro: sem ele `evo_state` pode estar velho
    await asyncio.sleep(20)
    while True:
        try:
            await tick(tracker)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("falha na rodada do relatorio do super admin")
        await asyncio.sleep(INTERVAL_SECONDS)
