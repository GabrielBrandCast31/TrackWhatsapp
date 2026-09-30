"""Formularios de captacao: painel (logado, por linha) e as rotas publicas que a
pagina /f/{slug} consome — no mesmo dominio do painel.
"""

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import access, form_ai, forms, journey
from app.db import get_session
from app.models import Contact, FormResponse, LeadForm, WaNumber
from app.routers.collect import client_ip

router = APIRouter(prefix="/api/forms", tags=["forms"])
public_router = APIRouter(prefix="/api/forms/public", tags=["forms-public"])


async def _form(session: AsyncSession, form_id: int) -> LeadForm:
    form = await session.get(LeadForm, form_id)
    if form is None or not access.can_see(form.wa_number_id):
        raise HTTPException(status_code=404, detail="Formulário não encontrado.")
    return form


async def _number(session: AsyncSession, number_id: int | None) -> WaNumber:
    if number_id is None:
        raise HTTPException(status_code=400, detail="Escolha a linha (cliente) do formulário.")
    access.ensure_number(number_id)
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Linha não encontrada.")
    return number


# ---------------------------------------------------------------------------
# painel
# ---------------------------------------------------------------------------

@router.get("")
async def list_forms(number_id: int | None = Query(default=None), session: AsyncSession = Depends(get_session)):
    stmt = access.scope(select(LeadForm).order_by(desc(LeadForm.id)), LeadForm.wa_number_id, number_id)
    rows = (await session.execute(stmt)).scalars().all()
    counts = await forms.response_counts(session, [f.id for f in rows])
    numbers = {n.id: n for n in (await session.execute(select(WaNumber))).scalars().all()}
    return [forms.serialize(f, counts.get(f.id, 0), numbers.get(f.wa_number_id)) for f in rows]


@router.get("/frameworks")
async def frameworks():
    return {
        "frameworks": form_ai.catalog(),
        "min_questions": form_ai.MIN_Q,
        "max_questions": form_ai.MAX_Q,
        "ai_available": form_ai.is_available(),
    }


class AiIn(BaseModel):
    framework: str = "bant"
    number_id: int | None = None
    business: str = ""
    offer: str = ""
    audience: str = ""
    tone: str = ""
    questions: int = 0
    notes: str = ""


@router.post("/ai-generate")
async def ai_generate(payload: AiIn, session: AsyncSession = Depends(get_session)):
    """Rascunho seguindo o metodo escolhido. Nao grava nada."""
    label = None
    if payload.number_id is not None:
        label = (await _number(session, payload.number_id)).label
    try:
        return await form_ai.generate(payload.model_dump(), label)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("")
async def create_form(payload: dict, session: AsyncSession = Depends(get_session)):
    number = await _number(session, payload.get("wa_number_id"))
    form = LeadForm(
        wa_number_id=number.id,
        slug=forms.slugify(payload.get("title") or ""),
        title=(payload.get("title") or "Novo formulário").strip()[:200],
        thank_you=forms.THANK_YOU,
        fields=[], theme=forms.clean_theme({}), settings=forms.clean_settings({}),
        created_by=(access.current_user().id if access.current_user() else None),
    )
    forms.apply(form, payload)
    session.add(form)
    await session.commit()
    await session.refresh(form)
    return forms.serialize(form, 0, number)


@router.patch("/{form_id}")
async def update_form(form_id: int, payload: dict, session: AsyncSession = Depends(get_session)):
    form = await _form(session, form_id)
    if "wa_number_id" in payload and payload["wa_number_id"] != form.wa_number_id:
        form.wa_number_id = (await _number(session, payload["wa_number_id"])).id
    forms.apply(form, payload)
    await session.commit()
    await session.refresh(form)
    counts = await forms.response_counts(session, [form.id])
    number = await session.get(WaNumber, form.wa_number_id) if form.wa_number_id else None
    return forms.serialize(form, counts.get(form.id, 0), number)


@router.delete("/{form_id}", status_code=204)
async def delete_form(form_id: int, session: AsyncSession = Depends(get_session)):
    form = await _form(session, form_id)
    await session.delete(form)
    await session.commit()


@router.get("/{form_id}/responses")
async def responses(form_id: int, limit: int = Query(default=300, le=2000), session: AsyncSession = Depends(get_session)):
    form = await _form(session, form_id)
    rows = (
        await session.execute(
            select(FormResponse).where(FormResponse.form_id == form.id).order_by(desc(FormResponse.id)).limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": r.id, "answers": r.answers or {}, "contact_id": r.contact_id,
            "transaction_id": r.transaction_id, "created_at": r.created_at,
        }
        for r in rows
    ]


@router.get("/contact/{contact_id}")
async def contact_responses(contact_id: int, session: AsyncSession = Depends(get_session)):
    """Respostas de formulario de uma conversa do CRM."""
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    rows = (
        await session.execute(
            select(FormResponse, LeadForm)
            .join(LeadForm, LeadForm.id == FormResponse.form_id)
            .where(FormResponse.contact_id == contact_id)
            .order_by(desc(FormResponse.id))
        )
    ).all()
    out = []
    for r, f in rows:
        labels = {q["id"]: q["label"] for q in forms.clean_fields(f.fields)}
        out.append({
            "id": r.id, "form_id": f.id, "form_title": f.title, "created_at": r.created_at,
            "answers": [{"label": labels.get(k, k), "value": v} for k, v in (r.answers or {}).items() if v],
        })
    return out


# ---------------------------------------------------------------------------
# publico: o lead abre /f/{slug}
# ---------------------------------------------------------------------------

# trava simples por IP: formulario publico nao pode virar metralhadora de lead falso
_hits: dict[str, deque] = defaultdict(deque)
_WINDOW, _MAX = 600, 12


def _throttle(key: str) -> None:
    now = time.monotonic()
    q = _hits[key]
    while q and now - q[0] > _WINDOW:
        q.popleft()
    if len(q) >= _MAX:
        raise HTTPException(status_code=429, detail="Muitos envios em pouco tempo. Tente de novo em alguns minutos.")
    q.append(now)


async def _public(session: AsyncSession, slug: str) -> LeadForm:
    form = (await session.execute(select(LeadForm).where(LeadForm.slug == slug))).scalars().first()
    if form is None or not form.active:
        raise HTTPException(status_code=404, detail="Formulário não encontrado ou desativado.")
    return form


@public_router.get("/{slug}")
async def public_form(slug: str, preview: bool = Query(default=False), session: AsyncSession = Depends(get_session)):
    form = await _public(session, slug)
    if not preview:
        form.views = (form.views or 0) + 1
        await session.commit()
    number = await session.get(WaNumber, form.wa_number_id) if form.wa_number_id else None
    if number is not None and forms.clean_settings(form.settings)["track_journey"]:
        # linha que nunca abriu "Tag do site" ainda nao tem chave: nasce aqui
        await journey.ensure_site_key(session, number)
    return forms.public_payload(form, number)


@public_router.post("/{slug}/submit")
async def public_submit(slug: str, payload: dict, request: Request, session: AsyncSession = Depends(get_session)):
    payload = payload or {}
    # honeypot: campo invisivel preenchido = robo. Finge sucesso e nao grava.
    if payload.get("website"):
        return {"ok": True, "thank_you": "Obrigado!"}
    ip = client_ip(request) or ""
    _throttle(f"{ip}:{slug}")
    form = await _public(session, slug)
    ctx = {
        "event_id": str(payload.get("event_id") or "")[:64],
        "url": str(payload.get("url") or "")[:500],
        "fbp": str(payload.get("fbp") or "")[:100],
        "fbc": str(payload.get("fbc") or "")[:200],
        "tl": str(payload.get("tl") or "")[:64],
        "ip": ip,
        "ua": (request.headers.get("user-agent") or "")[:500],
        "consent": bool(payload.get("consent")),
    }
    answers = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
    try:
        return await forms.submit(session, form, answers, ctx)
    except forms.SubmitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
