"""Campanhas de disparo para os contatos do CRM da linha (veja app.broadcasts).

Qualquer usuario logado usa, mas so nas linhas dele (`access`). A ordem que a
tela segue: audiencia -> teste no proprio numero -> criar -> iniciar.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import access, phones, settings_store
from app import broadcasts as service
from app import numbers as numbers_service
from app.db import get_session
from app.models import Broadcast, BroadcastRecipient, Contact, WaNumber
from app.services import whatsapp_cloud

router = APIRouter(prefix="/api/broadcasts", tags=["broadcasts"])


class AudienceIn(BaseModel):
    stages: list[str] = Field(default_factory=list)
    channels: list[str] = Field(default_factory=list)
    source_keys: list[str] = Field(default_factory=list)
    inactive_days: int = Field(default=0, ge=0, le=3650)
    active_days: int = Field(default=0, ge=0, le=3650)
    exclude_recent_days: int = Field(default=0, ge=0, le=365)
    contact_ids: list[int] = Field(default_factory=list)
    q: str | None = None


class MessageIn(BaseModel):
    kind: str = "text"  # text | template
    text: str | None = None
    opt_out_footer: bool = True
    template_name: str | None = None
    template_language: str | None = None
    template_params: list[str] = Field(default_factory=list)


class TestIn(MessageIn):
    number_id: int
    phone: str = Field(min_length=8)
    sample_name: str | None = None


class BroadcastIn(MessageIn):
    number_id: int
    name: str = Field(min_length=1, max_length=160)
    filters: AudienceIn = Field(default_factory=AudienceIn)
    # abaixo do piso (MIN_THROTTLE_SECONDS) o worker arredonda pra cima
    throttle_seconds: int = Field(default=20, ge=0, le=3600)
    jitter_seconds: int = Field(default=15, ge=0, le=600)
    daily_cap: int = Field(default=200, ge=0, le=5000)
    window_start_hour: int = Field(default=8, ge=0, le=23)
    window_end_hour: int = Field(default=20, ge=0, le=24)
    start: bool = False


async def _line(session: AsyncSession, number_id: int) -> tuple[WaNumber, dict]:
    access.ensure_number(number_id)
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Linha não encontrada.")
    return number, numbers_service.effective_cfg(await settings_store.load(session), number)


def _message_text(payload: MessageIn) -> str | None:
    text = (payload.text or "").strip()
    if text and payload.opt_out_footer and "SAIR" not in text.upper():
        text += service.OPT_OUT_FOOTER
    return text or None


def _check_message(payload: MessageIn, channel: str) -> None:
    if channel == "evolution" or payload.kind == "text":
        if not (payload.text or "").strip():
            raise HTTPException(status_code=400, detail="Escreva a mensagem da campanha.")
    elif not payload.template_name:
        raise HTTPException(
            status_code=400,
            detail="Linha da Cloud API: fora da janela de 24h a Meta só entrega template aprovado.",
        )


def serialize(b: Broadcast, stats: dict | None = None) -> dict:
    return {
        "id": b.id,
        "wa_number_id": b.wa_number_id,
        "name": b.name,
        "kind": b.kind,
        "text": b.text,
        "template_name": b.template_name,
        "template_language": b.template_language,
        "template_params": b.template_params or [],
        "filters": b.filters or {},
        "throttle_seconds": b.throttle_seconds,
        "jitter_seconds": b.jitter_seconds,
        "daily_cap": b.daily_cap,
        "window_start_hour": b.window_start_hour,
        "window_end_hour": b.window_end_hour,
        "status": b.status,
        "pause_reason": b.pause_reason,
        "created_by": b.created_by,
        "created_at": b.created_at,
        "started_at": b.started_at,
        "finished_at": b.finished_at,
        "stats": stats or {},
    }


def _serialize_contact(c: Contact) -> dict:
    return {"id": c.id, "name": c.name, "wa_id": c.wa_id, "phone_e164": c.phone_e164, "stage": c.stage}


@router.post("/audience")
async def preview_audience(
    payload: AudienceIn,
    number_id: int = Query(),
    session: AsyncSession = Depends(get_session),
):
    """Quantos entram com esse filtro, quem fica de fora e por quê, e uma amostra."""
    number, cfg = await _line(session, number_id)
    rows, dropped = await service.audience(session, number, cfg, payload.model_dump())
    return {
        "count": len(rows),
        "dropped": dropped,
        "sample": [_serialize_contact(c) for c in rows[:50]],
        "sent_last_24h": await service.sent_last_24h(session, number.id),
    }


@router.get("/templates")
async def list_templates(number_id: int = Query(), session: AsyncSession = Depends(get_session)):
    """Templates do WABA da linha (só Cloud API). A Evolution manda texto livre."""
    number, cfg = await _line(session, number_id)
    if (number.channel or "evolution") == "evolution":
        return []
    try:
        raw = await whatsapp_cloud.message_templates(cfg)
    except Exception as exc:  # noqa: BLE001 — a UI mostra o motivo cru
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [
        {
            "name": t.get("name"),
            "language": t.get("language"),
            "status": t.get("status"),
            "category": t.get("category"),
            "body": whatsapp_cloud.template_body(t),
            "placeholders": whatsapp_cloud.template_placeholders(t),
            "approved": (t.get("status") or "").upper() == "APPROVED",
        }
        for t in raw
    ]


@router.post("/preview")
async def preview_message(payload: MessageIn, sample_name: str | None = Query(default=None)):
    """Três variações do texto como chegariam, para conferir spintax e variáveis."""
    text = _message_text(payload) or ""
    sample = Contact(wa_id="5511999999999", name=sample_name or "Maria Souza", phone_e164="+5511999999999")
    return {"variations": [service.render(text, sample, None) for _ in range(3)]}


@router.post("/test")
async def send_test(payload: TestIn, session: AsyncSession = Depends(get_session)):
    """Envia AGORA uma mensagem para um número seu, com o texto já preenchido.

    Não grava nada na campanha: é o ensaio antes do disparo de verdade.
    """
    number, cfg = await _line(session, payload.number_id)
    channel = number.channel or "evolution"
    _check_message(payload, channel)
    e164 = phones.to_e164(payload.phone)
    if not e164:
        raise HTTPException(status_code=400, detail="Telefone de teste inválido.")
    to = phones.to_wa_id(e164)

    draft = Broadcast(
        name="teste",
        kind="template" if channel != "evolution" and payload.kind == "template" else "text",
        text=_message_text(payload),
        template_name=payload.template_name,
        template_language=payload.template_language,
        template_params=payload.template_params,
    )
    sample = Contact(wa_id=to, name=payload.sample_name or None, phone_e164=e164)
    try:
        request, body = service.build_payload(draft, channel, to, sample)
        status, response, wamid = await service.send(cfg, channel, request)
    except Exception as exc:  # noqa: BLE001 — a tela mostra o motivo cru
        raise HTTPException(status_code=400, detail=f"Falhou: {exc}") from exc
    return {"sent": True, "to": e164, "body": body, "http_status": status, "wamid": wamid, "response": response}


@router.get("")
async def list_broadcasts(
    number_id: int | None = Query(default=None),
    limit: int = Query(default=100, le=500),
    session: AsyncSession = Depends(get_session),
):
    stmt = access.scope(select(Broadcast), Broadcast.wa_number_id, number_id)
    rows = (await session.execute(stmt.order_by(desc(Broadcast.id)).limit(limit))).scalars().all()
    stats = await service.counts(session, [b.id for b in rows])
    return [serialize(b, stats.get(b.id)) for b in rows]


@router.post("", status_code=201)
async def create_broadcast(payload: BroadcastIn, session: AsyncSession = Depends(get_session)):
    """Cria a campanha e congela a audiência. Com `start`, já entra na fila."""
    number, cfg = await _line(session, payload.number_id)
    channel = number.channel or "evolution"
    _check_message(payload, channel)

    contacts, _ = await service.audience(session, number, cfg, payload.filters.model_dump())
    if not contacts:
        raise HTTPException(status_code=400, detail="Nenhum contato entra nesse filtro.")

    user = access.current_user()
    broadcast = Broadcast(
        wa_number_id=number.id,
        name=payload.name.strip(),
        kind="template" if channel != "evolution" and payload.kind == "template" else "text",
        text=_message_text(payload),
        template_name=payload.template_name,
        template_language=payload.template_language or "pt_BR",
        template_params=payload.template_params,
        filters=payload.filters.model_dump(),
        throttle_seconds=payload.throttle_seconds,
        jitter_seconds=payload.jitter_seconds,
        daily_cap=payload.daily_cap,
        window_start_hour=payload.window_start_hour,
        window_end_hour=payload.window_end_hour,
        created_by=(user.name or user.username) if user else None,
    )
    session.add(broadcast)
    await session.flush()
    for c in contacts:
        session.add(
            BroadcastRecipient(
                broadcast_id=broadcast.id,
                contact_id=c.id,
                wa_number_id=number.id,
                name=c.name,
                to=service.destination(c, channel),
            )
        )
    if payload.start:
        broadcast.status = "running"
        broadcast.started_at = datetime.now(timezone.utc)
    await session.commit()
    if payload.start:
        service.start_worker()
    stats = await service.counts(session, [broadcast.id])
    return serialize(broadcast, stats[broadcast.id])


async def _get(session: AsyncSession, broadcast_id: int) -> Broadcast:
    b = await session.get(Broadcast, broadcast_id)
    if b is None or not access.can_see(b.wa_number_id):
        raise HTTPException(status_code=404, detail="Campanha não encontrada.")
    return b


@router.get("/{broadcast_id}")
async def get_broadcast(
    broadcast_id: int,
    status: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    b = await _get(session, broadcast_id)
    stmt = select(BroadcastRecipient).where(BroadcastRecipient.broadcast_id == b.id)
    if status:
        stmt = stmt.where(BroadcastRecipient.status == status)
    rows = (await session.execute(stmt.order_by(BroadcastRecipient.id).limit(2000))).scalars().all()
    replied = await service.replied_ids(session, b.id)
    stats = await service.counts(session, [b.id])
    return {
        **serialize(b, stats[b.id]),
        "recipients": [
            {
                "id": r.id,
                "contact_id": r.contact_id,
                "name": r.name,
                "to": r.to,
                "status": r.status,
                "body": r.body,
                "error": r.error,
                "http_status": r.http_status,
                "wamid": r.wamid,
                "sent_at": r.sent_at,
                "replied": r.id in replied,
                "request_payload": r.request_payload,
                "response_body": r.response_body,
            }
            for r in rows
        ],
    }


@router.post("/{broadcast_id}/start")
async def start_broadcast(broadcast_id: int, session: AsyncSession = Depends(get_session)):
    """Inicia ou retoma. Retomar continua de onde parou: quem já recebeu não recebe de novo."""
    b = await _get(session, broadcast_id)
    if b.status not in ("draft", "paused"):
        raise HTTPException(status_code=400, detail=f"Campanha {b.status} não pode ser iniciada.")
    b.status = "running"
    b.pause_reason = None
    b.started_at = b.started_at or datetime.now(timezone.utc)
    await session.commit()
    service.start_worker()
    return serialize(b, (await service.counts(session, [b.id]))[b.id])


@router.post("/{broadcast_id}/pause")
async def pause_broadcast(broadcast_id: int, session: AsyncSession = Depends(get_session)):
    b = await _get(session, broadcast_id)
    if b.status != "running":
        raise HTTPException(status_code=400, detail="Só dá pra pausar campanha rodando.")
    b.status = "paused"
    b.pause_reason = "Pausada manualmente."
    await session.commit()
    return serialize(b, (await service.counts(session, [b.id]))[b.id])


@router.post("/{broadcast_id}/cancel")
async def cancel_broadcast(broadcast_id: int, session: AsyncSession = Depends(get_session)):
    """Encerra de vez: quem ainda estava na fila vira `skipped`."""
    b = await _get(session, broadcast_id)
    if b.status in ("done", "canceled"):
        raise HTTPException(status_code=400, detail=f"Campanha já {b.status}.")
    b.status = "canceled"
    b.finished_at = datetime.now(timezone.utc)
    pending = (
        await session.execute(
            select(BroadcastRecipient).where(
                BroadcastRecipient.broadcast_id == b.id, BroadcastRecipient.status == "queued"
            )
        )
    ).scalars().all()
    for r in pending:
        r.status = "skipped"
        r.error = "Campanha cancelada."
    await session.commit()
    return serialize(b, (await service.counts(session, [b.id]))[b.id])


@router.post("/{broadcast_id}/retry-failed")
async def retry_failed(broadcast_id: int, session: AsyncSession = Depends(get_session)):
    """Devolve os que falharam pra fila (ex.: depois de reconectar a linha)."""
    b = await _get(session, broadcast_id)
    failed = (
        await session.execute(
            select(BroadcastRecipient).where(
                BroadcastRecipient.broadcast_id == b.id, BroadcastRecipient.status == "failed"
            )
        )
    ).scalars().all()
    for r in failed:
        r.status = "queued"
        r.error = None
    if failed and b.status == "done":
        b.status = "paused"
        b.finished_at = None
    await session.commit()
    return {"requeued": len(failed), **serialize(b, (await service.counts(session, [b.id]))[b.id])}


@router.delete("/{broadcast_id}", status_code=204)
async def delete_broadcast(broadcast_id: int, session: AsyncSession = Depends(get_session)):
    b = await _get(session, broadcast_id)
    if b.status == "running":
        raise HTTPException(status_code=400, detail="Pause ou cancele antes de apagar.")
    await session.delete(b)
    await session.commit()


@router.post("/contacts/{contact_id}/opt-out")
async def set_opt_out(contact_id: int, opted_out: bool = Query(default=True), session: AsyncSession = Depends(get_session)):
    """Descadastra (ou recadastra) à mão um contato das campanhas."""
    contact = await session.get(Contact, contact_id)
    access.ensure_contact(contact)
    contact.opted_out_at = datetime.now(timezone.utc) if opted_out else None
    await session.commit()
    return {"id": contact.id, "opted_out_at": contact.opted_out_at}
