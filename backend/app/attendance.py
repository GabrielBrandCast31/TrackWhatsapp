"""Tempo de resposta do atendimento, calculado das mensagens gravadas.

A unidade e a **espera**: o cliente manda uma ou varias mensagens seguidas e
fica esperando; a espera termina na primeira mensagem do atendente. O tempo de
resposta e o tamanho dessa espera. Mensagens seguidas do cliente nao abrem
esperas novas — quem mandou tres mensagens em um minuto esta esperando desde a
primeira.

A primeira espera da conversa e a **primeira resposta** — o numero que mais pesa
em lead de anuncio, que esfria em minutos.

Mediana vem junto da media de proposito: uma mensagem que chegou de madrugada e
foi respondida de manha puxa a media para horas, e a mediana mostra o normal.
"""

import os
import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.getenv("APP_TIMEZONE", "America/Sao_Paulo"))

# faixas de SLA (segundos) e como a tela chama cada uma
BUCKETS = (
    (5 * 60, "até 5 min"),
    (30 * 60, "5 a 30 min"),
    (2 * 3600, "30 min a 2 h"),
    (24 * 3600, "2 a 24 h"),
    (None, "mais de 24 h"),
)
WEEKDAYS = ("seg", "ter", "qua", "qui", "sex", "sáb", "dom")


def aware(stamp: datetime) -> datetime:
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


@dataclass
class Wait:
    contact_id: int
    started: datetime
    seconds: float | None  # None = ainda sem resposta
    first: bool


def waits_of(contact_id: int, messages) -> list[Wait]:
    """Esperas de UMA conversa. `messages`: (direction, sent_at) em ordem."""
    out: list[Wait] = []
    waiting: datetime | None = None
    answered_before = False
    for direction, sent_at in messages:
        sent_at = aware(sent_at)
        if direction == "in":
            if waiting is None:
                waiting = sent_at
        elif waiting is not None:
            out.append(Wait(contact_id, waiting, max(0.0, (sent_at - waiting).total_seconds()), not answered_before))
            answered_before = True
            waiting = None
        else:
            answered_before = True  # o atendente puxou assunto: nao ha espera a medir
    if waiting is not None:
        out.append(Wait(contact_id, waiting, None, not answered_before))
    return out


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[idx]


def _summary(values: list[float]) -> dict:
    return {
        "count": len(values),
        "avg_seconds": round(statistics.fmean(values), 1) if values else None,
        "median_seconds": round(statistics.median(values), 1) if values else None,
        "p90_seconds": round(_pct(values, 0.9), 1) if values else None,
    }


def stats(waits: list[Wait], since: datetime, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    period = [w for w in waits if w.started >= since]
    answered = [w.seconds for w in period if w.seconds is not None]
    first = [w.seconds for w in period if w.first and w.seconds is not None]

    buckets = []
    for limit, label in BUCKETS:
        lower = buckets[-1]["_limit"] if buckets else 0
        n = sum(1 for s in answered if s >= lower and (limit is None or s < limit))
        buckets.append({"label": label, "count": n, "_limit": limit or float("inf")})
    for b in buckets:
        b["share"] = round(b["count"] / len(answered), 4) if answered else None
        b.pop("_limit")

    by_hour: dict[int, list[float]] = {h: [] for h in range(24)}
    by_weekday: dict[int, list[float]] = {d: [] for d in range(7)}
    by_day: dict[str, list[float]] = {}
    for w in period:
        if w.seconds is None:
            continue
        local = w.started.astimezone(TZ)
        by_hour[local.hour].append(w.seconds)
        by_weekday[local.weekday()].append(w.seconds)
        by_day.setdefault(local.date().isoformat(), []).append(w.seconds)

    # quem esta esperando agora — a lista de "responda ja"
    pending = [w for w in waits if w.seconds is None]
    pending.sort(key=lambda w: w.started)

    return {
        "responses": _summary(answered),
        "first_response": _summary(first),
        "within_5min": round(sum(1 for s in answered if s < 300) / len(answered), 4) if answered else None,
        "unanswered": sum(1 for w in period if w.seconds is None),
        "buckets": buckets,
        "by_hour": [
            {"hour": h, "count": len(v), "median_seconds": round(statistics.median(v), 1) if v else None}
            for h, v in by_hour.items()
        ],
        "by_weekday": [
            {"day": WEEKDAYS[d], "count": len(v), "median_seconds": round(statistics.median(v), 1) if v else None}
            for d, v in by_weekday.items()
        ],
        "by_day": [
            {"day": d, "count": len(v), "median_seconds": round(statistics.median(v), 1), "avg_seconds": round(statistics.fmean(v), 1)}
            for d, v in sorted(by_day.items())
        ],
        "waiting_now": [
            {"contact_id": w.contact_id, "since": w.started, "seconds": round((now - w.started).total_seconds())}
            for w in pending
        ],
        "waiting_now_count": len(pending),
    }


def contact_stats(contact_id: int, messages) -> dict:
    """Tempo de resposta de uma conversa so — o que o painel do contato mostra."""
    waits = waits_of(contact_id, messages)
    answered = [w.seconds for w in waits if w.seconds is not None]
    first = next((w for w in waits if w.first), None)
    pending = next((w for w in waits if w.seconds is None), None)
    return {
        **_summary(answered),
        "first_response_seconds": first.seconds if first else None,
        "waiting_since": pending.started if pending else None,
    }


def window(days: int) -> tuple[datetime, datetime]:
    """Periodo pedido e a folga pra tras: espera que comecou antes do periodo mas
    foi respondida dentro dele precisa da mensagem de abertura."""
    since = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365)))
    return since, since - timedelta(days=3)
