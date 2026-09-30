"""Atendimento: funil por etapa, tempo de resposta e analise com IA.

Tudo por linha (`number_id`) e por periodo (`days`, pela data de entrada do lead
no funil e pelo inicio de cada espera no tempo de resposta).
"""

import asyncio
import logging
import statistics
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import access, ai_analysis, attendance, auth, campaigns, funnel, journey, settings_store
from app.db import SessionLocal, get_session
from app.models import Contact, ConversationAnalysis, Message

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/attendance", tags=["attendance"])


def _scoped(stmt, model, number_id: int | None):
    return access.scope(stmt, model.wa_number_id, number_id)


def _origin_label(contact: Contact) -> str:
    """Origem do lead para o corte do funil: a jornada do site vem primeiro."""
    last = contact.last_utm or {}
    if contact.transaction_id:
        clicks = {k: getattr(contact, k) for k in ("gclid", "gbraid", "wbraid", "ttclid") if getattr(contact, k)}
        if contact.fbc:
            clicks["fbclid"] = contact.fbc
        return journey.classify(last, clicks)["label"]
    return campaigns.lead_source(contact, None, None)["channel_label"]


def _days_between(a: datetime | None, b: datetime | None) -> float | None:
    if not a or not b:
        return None
    return (attendance.aware(b) - attendance.aware(a)).total_seconds() / 86400


# ---------------------------------------------------------------------------
# funil
# ---------------------------------------------------------------------------

@router.get("/funnel")
async def funnel_view(
    number_id: int | None = Query(default=None),
    days: int = Query(default=30),
    session: AsyncSession = Depends(get_session),
):
    since, _ = attendance.window(days)
    contacts = (
        await session.execute(_scoped(select(Contact).where(Contact.created_at >= since), Contact, number_id))
    ).scalars().all()
    # quem veio so do "Sincronizar" da agenda nao e lead do periodo: e base antiga
    contacts = [c for c in contacts if c.origin != "sync" or c.first_message]

    overall = funnel.funnel_counts(contacts)

    by_origin: dict[str, list[Contact]] = {}
    for c in contacts:
        by_origin.setdefault(_origin_label(c), []).append(c)
    origins = []
    for label, group in by_origin.items():
        counts = funnel.funnel_counts(group)
        origins.append({"label": label, **counts})
    origins.sort(key=lambda o: -o["total"])

    # quanto tempo cada degrau leva, contado da entrada do lead (mediana em dias)
    timing = []
    for stage, column in funnel.MILESTONE.items():
        values = [d for c in contacts if (d := _days_between(c.created_at, getattr(c, column))) is not None and d >= 0]
        timing.append(
            {
                "stage": stage,
                "label": funnel.LABELS[stage],
                "median_days": round(statistics.median(values), 2) if values else None,
                "count": len(values),
            }
        )

    current = {s: 0 for s in (*funnel.ORDER, "perdido")}
    for c in contacts:
        current[c.stage if c.stage in current else "novo"] += 1

    closed = [c for c in contacts if c.closed_at or c.stage == "fechado"]
    return {
        "days": days,
        **overall,
        "current": [{"stage": s, "label": funnel.LABELS[s], "count": n} for s, n in current.items()],
        "lost": current["perdido"],
        "closed_with_value": sum(1 for c in closed if c.deal_value),
        "avg_ticket": round(overall["revenue"] / max(1, sum(1 for c in closed if c.deal_value)), 2)
        if overall["revenue"]
        else None,
        "by_origin": origins,
        "timing": timing,
    }


# ---------------------------------------------------------------------------
# tempo de resposta
# ---------------------------------------------------------------------------

async def _waits(session: AsyncSession, number_id: int | None, since_loaded: datetime):
    stmt = (
        select(Message.contact_id, Message.direction, Message.sent_at)
        .join(Contact, Contact.id == Message.contact_id)
        .where(Message.sent_at >= since_loaded)
        .order_by(Message.contact_id, Message.sent_at, Message.id)
        .limit(300_000)
    )
    stmt = access.scope(stmt, Contact.wa_number_id, number_id)
    rows = (await session.execute(stmt)).all()
    grouped: dict[int, list] = {}
    for contact_id, direction, sent_at in rows:
        grouped.setdefault(contact_id, []).append((direction, sent_at))
    waits = []
    for contact_id, msgs in grouped.items():
        waits.extend(attendance.waits_of(contact_id, msgs))
    return waits


@router.get("/response-times")
async def response_times(
    number_id: int | None = Query(default=None),
    days: int = Query(default=30),
    session: AsyncSession = Depends(get_session),
):
    since, loaded = attendance.window(days)
    waits = await _waits(session, number_id, loaded)
    out = attendance.stats(waits, since)

    ids = [w["contact_id"] for w in out["waiting_now"]]
    names = {}
    if ids:
        names = {
            c.id: c
            for c in (await session.execute(select(Contact).where(Contact.id.in_(ids)))).scalars().all()
        }
    # lead fechado ou perdido que mandou o ultimo "obrigado" nao esta esperando nada
    waiting = []
    for w in out["waiting_now"]:
        c = names.get(w["contact_id"])
        if c is None or c.stage in ("fechado", "perdido"):
            continue
        waiting.append({**w, "name": c.name or c.phone_e164 or c.wa_id, "stage": c.stage})
    out["waiting_now"] = waiting[:15]
    out["waiting_now_count"] = len(waiting)
    return {"days": days, **out}


# ---------------------------------------------------------------------------
# IA: configuracao
# ---------------------------------------------------------------------------

async def _ai_cfg(session: AsyncSession) -> dict:
    return await settings_store.load(session)


@router.get("/ai-config")
async def ai_config(session: AsyncSession = Depends(get_session)):
    cfg = await _ai_cfg(session)
    key = cfg.get("anthropic_api_key") or ""
    which = ai_analysis.provider(key)
    from app import form_ai

    return {
        # Claude quando ha chave da Anthropic; sem ela, o Gemini do .env
        "configured": which is not None,
        "provider": which,
        "anthropic_configured": bool(key),
        "gemini_configured": form_ai.is_available(),
        "key_hint": f"...{key[-4:]}" if len(key) >= 4 else "",
        "model": ai_analysis.MODEL if which == "claude" else form_ai.GEMINI_MODEL if which == "gemini" else None,
        "effort": ai_analysis.EFFORT,
        "auto_apply_stage": bool(cfg.get("ai_auto_apply_stage")),
        "criteria": [{"key": k, "label": v} for k, v in ai_analysis.CRITERIA.items()],
    }


class AiConfigIn(BaseModel):
    anthropic_api_key: str | None = None
    auto_apply_stage: bool | None = None


@router.put("/ai-config", dependencies=[Depends(auth.require_admin)])
async def put_ai_config(payload: AiConfigIn, session: AsyncSession = Depends(get_session)):
    patch: dict = {}
    if payload.anthropic_api_key is not None:
        patch["anthropic_api_key"] = payload.anthropic_api_key.strip()
    if payload.auto_apply_stage is not None:
        patch["ai_auto_apply_stage"] = payload.auto_apply_stage
    await settings_store.save(session, patch)
    return await ai_config(session)


# ---------------------------------------------------------------------------
# IA: uma conversa
# ---------------------------------------------------------------------------

async def _latest(session: AsyncSession, contact_id: int) -> ConversationAnalysis | None:
    return (
        await session.execute(
            select(ConversationAnalysis)
            .where(ConversationAnalysis.contact_id == contact_id)
            .order_by(ConversationAnalysis.id.desc())
            .limit(1)
        )
    ).scalars().first()


@router.get("/contact/{contact_id}")
async def contact_view(contact_id: int, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    msgs = (
        await session.execute(
            select(Message.direction, Message.sent_at)
            .where(Message.contact_id == contact_id)
            .order_by(Message.sent_at, Message.id)
        )
    ).all()
    return {
        "response": attendance.contact_stats(contact_id, msgs),
        "analysis": ai_analysis.serialize(await _latest(session, contact_id), contact),
        "stage": contact.stage,
    }


@router.post("/contact/{contact_id}/analyze")
async def analyze_contact(contact_id: int, session: AsyncSession = Depends(get_session)):
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    cfg = await _ai_cfg(session)
    row = await ai_analysis.analyze(
        session, contact, cfg.get("anthropic_api_key") or "", apply_stage=bool(cfg.get("ai_auto_apply_stage"))
    )
    await session.refresh(contact)
    return {"analysis": ai_analysis.serialize(row, contact), "stage": contact.stage}


class ApplyStageIn(BaseModel):
    stage: str


@router.post("/contact/{contact_id}/apply-stage")
async def apply_stage(contact_id: int, payload: ApplyStageIn, session: AsyncSession = Depends(get_session)):
    """O atendente aceitou a etapa que a IA sugeriu (vale como mudanca manual)."""
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    if payload.stage not in (*funnel.ORDER, "perdido"):
        raise HTTPException(status_code=400, detail="Etapa inválida.")
    funnel.set_manual(contact, payload.stage)
    await session.commit()
    return {"stage": contact.stage}


# ---------------------------------------------------------------------------
# IA: em lote
# ---------------------------------------------------------------------------

_jobs: dict[int, dict] = {}   # por linha; 0 = todas


class BatchIn(BaseModel):
    number_id: int | None = None
    limit: int = Field(default=20, ge=1, le=200)
    # so conversa sem analise ou com mensagem nova depois da ultima analise
    only_stale: bool = True


async def _candidates(session: AsyncSession, number_id: int | None, limit: int, only_stale: bool) -> list[int]:
    latest = (
        select(ConversationAnalysis.contact_id, func.max(ConversationAnalysis.created_at).label("at"))
        .where(ConversationAnalysis.status == "ok")
        .group_by(ConversationAnalysis.contact_id)
        .subquery()
    )
    msg_count = (
        select(Message.contact_id, func.count(Message.id).label("n")).group_by(Message.contact_id).subquery()
    )
    stmt = (
        select(Contact.id)
        .join(msg_count, msg_count.c.contact_id == Contact.id)
        .outerjoin(latest, latest.c.contact_id == Contact.id)
        .where(msg_count.c.n >= ai_analysis.MIN_MESSAGES)
        .order_by(Contact.last_message_at.desc().nulls_last())
        .limit(limit)
    )
    if only_stale:
        stmt = stmt.where((latest.c.at.is_(None)) | (Contact.last_message_at > latest.c.at))
    stmt = _scoped(stmt, Contact, number_id)
    return list((await session.execute(stmt)).scalars().all())


async def _run_batch(key: int, ids: list[int], api_key: str, apply: bool) -> None:
    job = _jobs[key]
    sem = asyncio.Semaphore(3)

    async def one(contact_id: int):
        async with sem:
            async with SessionLocal() as session:
                contact = await session.get(Contact, contact_id)
                if contact is None:
                    return
                row = await ai_analysis.analyze(session, contact, api_key, apply_stage=apply)
                job["done"] += 1
                if row.status != "ok":
                    job["errors"] += 1
                    job["last_error"] = row.error

    try:
        await asyncio.gather(*(one(i) for i in ids))
    finally:
        job["running"] = False
        job["finished_at"] = datetime.now(timezone.utc)


@router.post("/analyze-batch")
async def analyze_batch(payload: BatchIn, session: AsyncSession = Depends(get_session)):
    if payload.number_id is not None:
        access.ensure_number(payload.number_id)
    user = access.current_user()
    # lote "todas as linhas" de um usuario de operacao e dele, nao o do admin
    key = payload.number_id or (-(user.id) if user is not None and access.is_restricted() else 0)
    if _jobs.get(key, {}).get("running"):
        raise HTTPException(status_code=409, detail="Já existe uma análise em lote rodando para essa linha.")
    cfg = await _ai_cfg(session)
    api_key = cfg.get("anthropic_api_key") or ""
    if ai_analysis.provider(api_key) is None:
        raise HTTPException(status_code=400, detail="Nenhuma IA configurada: GEMINI_API_KEY no .env ou a chave da Anthropic.")
    ids = await _candidates(session, payload.number_id, payload.limit, payload.only_stale)
    _jobs[key] = {
        "running": bool(ids),
        "total": len(ids),
        "done": 0,
        "errors": 0,
        "last_error": None,
        "started_at": datetime.now(timezone.utc),
        "finished_at": None if ids else datetime.now(timezone.utc),
    }
    if ids:
        asyncio.create_task(_run_batch(key, ids, api_key, bool(cfg.get("ai_auto_apply_stage"))))
    return _jobs[key]


@router.get("/analyze-batch")
async def batch_status(number_id: int | None = Query(default=None)):
    if number_id is not None:
        access.ensure_number(number_id)
    user = access.current_user()
    key = number_id or (-(user.id) if user is not None and access.is_restricted() else 0)
    return _jobs.get(key) or {"running": False, "total": 0, "done": 0, "errors": 0}


# ---------------------------------------------------------------------------
# IA: visao geral
# ---------------------------------------------------------------------------

@router.get("/ai-overview")
async def ai_overview(
    number_id: int | None = Query(default=None),
    days: int = Query(default=30),
    session: AsyncSession = Depends(get_session),
):
    since, _ = attendance.window(days)
    latest_ids = (
        select(func.max(ConversationAnalysis.id))
        .where(ConversationAnalysis.status == "ok")
        .where(ConversationAnalysis.created_at >= since)
        .group_by(ConversationAnalysis.contact_id)
    )
    latest_ids = _scoped(latest_ids, ConversationAnalysis, number_id)
    rows = (
        await session.execute(select(ConversationAnalysis).where(ConversationAnalysis.id.in_(latest_ids)))
    ).scalars().all()

    contacts = {}
    if rows:
        contacts = {
            c.id: c
            for c in (
                await session.execute(select(Contact).where(Contact.id.in_([r.contact_id for r in rows])))
            ).scalars().all()
        }

    def dist(field: str, values: tuple) -> list[dict]:
        return [{"value": v, "count": sum(1 for r in rows if getattr(r, field) == v)} for v in values]

    criteria = []
    for key, label in ai_analysis.CRITERIA.items():
        vals = [v for r in rows if (v := (r.criteria or {}).get(key)) is not None]
        criteria.append({"key": key, "label": label, "avg": round(statistics.fmean(vals), 1) if vals else None})

    objections: dict[str, int] = {}
    for r in rows:
        for o in r.objections or []:
            objections[o] = objections.get(o, 0) + 1

    improvements: dict[str, int] = {}
    for r in rows:
        for text in r.improvements or []:
            k = text.strip().rstrip(".")
            if k:
                improvements[k] = improvements.get(k, 0) + 1

    scores = [r.score for r in rows if r.score is not None]
    pending = (
        await session.execute(
            _scoped(
                select(func.count(func.distinct(ConversationAnalysis.contact_id))).where(
                    ConversationAnalysis.status == "error"
                ),
                ConversationAnalysis,
                number_id,
            )
        )
    ).scalar_one()

    items = []
    for r in sorted(rows, key=lambda r: (r.score if r.score is not None else 99)):
        c = contacts.get(r.contact_id)
        items.append(
            {
                **ai_analysis.serialize(r, c),
                "name": (c.name or c.phone_e164 or c.wa_id) if c else None,
                "stage": c.stage if c else None,
            }
        )

    return {
        "days": days,
        "analyzed": len(rows),
        "with_errors": pending,
        "avg_score": round(statistics.fmean(scores), 1) if scores else None,
        "mql_rate": round(sum(1 for r in rows if r.is_mql) / len(rows), 4) if rows else None,
        "criteria": criteria,
        "temperature": dist("temperature", ("quente", "morno", "frio")),
        "sentiment": dist("sentiment", ("positivo", "neutro", "negativo")),
        "objections": [
            {"key": k, "label": ai_analysis.OBJECTIONS.get(k, k), "count": n}
            for k, n in sorted(objections.items(), key=lambda x: -x[1])
        ],
        "top_improvements": [
            {"text": t, "count": n} for t, n in sorted(improvements.items(), key=lambda x: -x[1])[:6]
        ],
        "items": items[:100],
    }
