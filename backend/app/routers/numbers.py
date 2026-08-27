"""Gestao dos numeros de WhatsApp da plataforma.

Cada numero e uma linha independente: credenciais proprias da Cloud API, webhook
proprio e, se quiser, destinos de conversao proprios. Tudo que essas rotas fazem
na Graph API usa a config EFETIVA do numero (`numbers.effective_cfg`), nunca a
config global crua.
"""

import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import numbers as numbers_service
from app import settings_store
from app.db import get_session
from app.models import Contact, Conversion, Outreach, Prospect, WaNumber
from app.services import whatsapp_cloud
from app.services.dispatch import enabled_destinations

router = APIRouter(prefix="/api/numbers", tags=["numbers"])

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000")

# credenciais que nunca voltam em claro pra UI
_SECRET_COLUMNS = ("access_token", "app_secret")


def _mask(value: str | None) -> dict:
    val = value or ""
    return {"set": bool(val), "hint": f"...{val[-4:]}" if len(val) >= 4 else ""}


def _mask_overrides(overrides: dict) -> dict:
    out = dict(overrides or {})
    for key in numbers_service.OVERRIDE_SECRETS:
        if key in out:
            val = str(out.get(key) or "")
            out[key] = ""
            out[f"{key}__set"] = bool(val)
            out[f"{key}__hint"] = f"...{val[-4:]}" if len(val) >= 4 else ""
    return out


def serialize_number(n: WaNumber, cfg: dict | None = None, counts: dict | None = None) -> dict:
    out = {
        "id": n.id,
        "label": n.label,
        "channel": n.channel,
        "phone_number_id": n.phone_number_id,
        "business_account_id": n.business_account_id,
        "verify_token": n.verify_token,
        "graph_version": n.graph_version,
        "display_phone_number": n.display_phone_number,
        "verified_name": n.verified_name,
        "quality_rating": n.quality_rating,
        "last_checked_at": n.last_checked_at,
        "last_error": n.last_error,
        "active": n.active,
        "is_default": n.is_default,
        "note": n.note,
        "created_at": n.created_at,
        "overrides": _mask_overrides(n.overrides or {}),
        "access_token__set": _mask(n.access_token)["set"],
        "access_token__hint": _mask(n.access_token)["hint"],
        "app_secret__set": _mask(n.app_secret)["set"],
        "app_secret__hint": _mask(n.app_secret)["hint"],
        # URL dedicada; a compartilhada continua valendo e aparece em /api/config
        "webhook_url": f"{PUBLIC_BASE_URL.rstrip('/')}/webhook/whatsapp/{n.id}",
    }
    if cfg is not None:
        out["enabled_destinations"] = enabled_destinations(cfg)
        out["outreach_enabled"] = bool(cfg.get("outreach_enabled"))
    if counts is not None:
        out["counts"] = counts
    return out


class NumberIn(BaseModel):
    label: str
    phone_number_id: str
    business_account_id: str | None = None
    access_token: str | None = None
    app_secret: str | None = None
    verify_token: str | None = None
    graph_version: str | None = None
    active: bool = True
    is_default: bool = False
    note: str | None = None
    overrides: dict = {}


class NumberPatch(BaseModel):
    label: str | None = None
    phone_number_id: str | None = None
    business_account_id: str | None = None
    access_token: str | None = None
    app_secret: str | None = None
    verify_token: str | None = None
    graph_version: str | None = None
    active: bool | None = None
    is_default: bool | None = None
    note: str | None = None
    overrides: dict | None = None


def _clean_overrides(raw: dict, current: dict | None = None) -> dict:
    """So aceita chaves conhecidas. Segredo em branco mantem o valor atual."""
    current = dict(current or {})
    for key, value in (raw or {}).items():
        if key not in numbers_service.OVERRIDABLE:
            continue
        if key in numbers_service.OVERRIDE_SECRETS and (value is None or value == ""):
            continue
        if value is None or value == "":
            current.pop(key, None)  # apagar o campo = voltar a herdar o global
            continue
        current[key] = value
    return current


async def _counts(session: AsyncSession, number_id: int) -> dict:
    contacts = (
        await session.execute(select(func.count(Contact.id)).where(Contact.wa_number_id == number_id))
    ).scalar_one()
    prospects = (
        await session.execute(select(func.count(Prospect.id)).where(Prospect.wa_number_id == number_id))
    ).scalar_one()
    sent = (
        await session.execute(
            select(func.count(Outreach.id)).where(
                Outreach.wa_number_id == number_id, Outreach.status == "sent"
            )
        )
    ).scalar_one()
    conversions = (
        await session.execute(
            select(func.count(Conversion.id))
            .join(Contact, Contact.id == Conversion.contact_id)
            .where(Contact.wa_number_id == number_id)
        )
    ).scalar_one()
    return {"contacts": contacts, "prospects": prospects, "outreach_sent": sent, "conversions": conversions}


@router.get("")
async def list_numbers(
    with_counts: bool = Query(default=True),
    channel: str | None = Query(default=None, description='"cloud" ou "evolution"; vazio = todas'),
    session: AsyncSession = Depends(get_session),
):
    global_cfg = await settings_store.load(session)
    rows = await numbers_service.list_numbers(session, channel=channel)
    return [
        serialize_number(
            n,
            numbers_service.effective_cfg(global_cfg, n),
            await _counts(session, n.id) if with_counts else None,
        )
        for n in rows
    ]


@router.post("", status_code=201)
async def create_number(payload: NumberIn, session: AsyncSession = Depends(get_session)):
    phone_number_id = (payload.phone_number_id or "").strip()
    if not phone_number_id:
        raise HTTPException(status_code=400, detail="Phone Number ID e obrigatorio.")
    dupe = await numbers_service.by_phone_number_id(session, phone_number_id)
    if dupe is not None:
        raise HTTPException(
            status_code=400, detail=f"Esse Phone Number ID ja esta cadastrado como '{dupe.label}'."
        )

    number = WaNumber(
        label=payload.label.strip() or phone_number_id,
        channel="cloud",  # esta tela e o cadastro da Cloud API
        phone_number_id=phone_number_id,
        business_account_id=(payload.business_account_id or "").strip() or None,
        access_token=payload.access_token or None,
        app_secret=payload.app_secret or None,
        verify_token=payload.verify_token or None,
        graph_version=payload.graph_version or None,
        active=payload.active,
        note=payload.note,
        overrides=_clean_overrides(payload.overrides),
    )
    session.add(number)
    await session.flush()

    existing = await numbers_service.list_numbers(session)
    if payload.is_default or len(existing) == 1:
        await numbers_service.set_default(session, number)

    await session.commit()
    await session.refresh(number)
    global_cfg = await settings_store.load(session)
    return serialize_number(number, numbers_service.effective_cfg(global_cfg, number))


@router.get("/orphans")
async def count_orphans(session: AsyncSession = Depends(get_session)):
    """Quantos registros ainda estao sem linha — o que a visao 'Sem número' mostra."""
    from app.models import ProspectSearch

    out: dict[str, int] = {}
    for model, key in ((Contact, "contacts"), (Prospect, "prospects"), (ProspectSearch, "searches")):
        out[key] = (
            await session.execute(select(func.count(model.id)).where(model.wa_number_id.is_(None)))
        ).scalar_one()
    out["total"] = sum(out.values())
    return out


@router.get("/{number_id}")
async def get_number(number_id: int, session: AsyncSession = Depends(get_session)):
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Numero nao encontrado.")
    global_cfg = await settings_store.load(session)
    return serialize_number(
        number, numbers_service.effective_cfg(global_cfg, number), await _counts(session, number.id)
    )


@router.patch("/{number_id}")
async def patch_number(number_id: int, patch: NumberPatch, session: AsyncSession = Depends(get_session)):
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Numero nao encontrado.")

    data = patch.model_dump(exclude_unset=True)

    if "phone_number_id" in data and data["phone_number_id"]:
        new_pnid = str(data["phone_number_id"]).strip()
        dupe = await numbers_service.by_phone_number_id(session, new_pnid)
        if dupe is not None and dupe.id != number.id:
            raise HTTPException(
                status_code=400, detail=f"Esse Phone Number ID ja esta em '{dupe.label}'."
            )
        number.phone_number_id = new_pnid

    for field in ("label", "business_account_id", "verify_token", "graph_version", "note"):
        if field in data:
            value = data[field]
            setattr(number, field, (value.strip() or None) if isinstance(value, str) else value)

    for field in _SECRET_COLUMNS:
        if field in data and data[field]:
            setattr(number, field, data[field])  # em branco mantem o segredo atual

    if "overrides" in data and data["overrides"] is not None:
        number.overrides = _clean_overrides(data["overrides"], number.overrides)

    if data.get("active") is not None:
        number.active = bool(data["active"])
        if not number.active and number.is_default:
            number.is_default = False

    if data.get("is_default"):
        await numbers_service.set_default(session, number)

    await session.commit()
    await session.refresh(number)
    global_cfg = await settings_store.load(session)
    return serialize_number(
        number, numbers_service.effective_cfg(global_cfg, number), await _counts(session, number.id)
    )


@router.delete("/{number_id}", status_code=204)
async def delete_number(
    number_id: int,
    purge: bool = Query(default=False, description="apaga tambem leads e prospects da linha"),
    session: AsyncSession = Depends(get_session),
):
    """Remove o numero. Por padrao a base dele fica orfa (visivel em 'Sem número').

    `purge=true` apaga leads, prospects e varreduras da linha — irreversivel, e por
    isso a UI pede confirmacao com o nome do numero antes de chamar.
    """
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Numero nao encontrado.")

    from app.models import ProspectSearch, WebhookLog

    owned = (Contact, Prospect, ProspectSearch, Outreach, WebhookLog)
    for model in owned:
        rows = (
            (await session.execute(select(model).where(model.wa_number_id == number_id))).scalars().all()
        )
        for row in rows:
            if purge and model in (Contact, Prospect, ProspectSearch):
                await session.delete(row)
            else:
                # o SQLite so aplica ON DELETE SET NULL com PRAGMA foreign_keys ligado.
                # Zerar na mao evita que um id reciclado entregue a base antiga pra
                # uma linha nova — vazamento entre clientes.
                row.wa_number_id = None
    await session.flush()

    was_default = number.is_default
    await session.delete(number)
    await session.commit()

    if was_default:
        replacement = await numbers_service.get_default(session)
        if replacement is not None:
            await numbers_service.set_default(session, replacement)
            await session.commit()


@router.post("/{number_id}/adopt-orphans")
async def adopt_orphans(number_id: int, session: AsyncSession = Depends(get_session)):
    """Puxa pra esta linha tudo que esta sem dono.

    Base que existia antes do multi-numero (ou que sobrou de um numero removido)
    fica com `wa_number_id` nulo e so aparece na visao 'Todas as linhas'. Isso aqui
    e o botao que adota esses registros.
    """
    from app.models import ProspectSearch

    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Numero nao encontrado.")

    adopted: dict[str, int] = {}
    for model, key in ((Contact, "contacts"), (Prospect, "prospects"), (ProspectSearch, "searches"), (Outreach, "outreaches")):
        rows = (
            (await session.execute(select(model).where(model.wa_number_id.is_(None)))).scalars().all()
        )
        for row in rows:
            row.wa_number_id = number_id
        adopted[key] = len(rows)

    await session.commit()
    return {"number_id": number_id, "adopted": adopted}


@router.get("/{number_id}/status")
async def number_status(number_id: int, session: AsyncSession = Depends(get_session)):
    """Bate na Graph API pra provar que o token e o numero estao valendo."""
    number = await session.get(WaNumber, number_id)
    if number is None:
        raise HTTPException(status_code=404, detail="Numero nao encontrado.")
    global_cfg = await settings_store.load(session)
    cfg = numbers_service.effective_cfg(global_cfg, number)

    out: dict = {
        "number_id": number.id,
        "configured": bool(cfg.get("wa_access_token") and cfg.get("wa_phone_number_id")),
        "connected": False,
        "phone_number": None,
        "subscribed_apps": [],
        "errors": [],
    }
    if not out["configured"]:
        out["errors"].append("Preencha o Access Token e o Phone Number ID deste número.")
        number.last_error = out["errors"][0]
        await session.commit()
        return out

    try:
        info = await whatsapp_cloud.phone_number_info(cfg)
        out["phone_number"] = info
        out["connected"] = True
        number.display_phone_number = info.get("display_phone_number")
        number.verified_name = info.get("verified_name")
        number.quality_rating = info.get("quality_rating")
        number.last_error = None
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"Numero: {exc}")
        number.last_error = str(exc)

    if cfg.get("wa_business_account_id"):
        try:
            subs = await whatsapp_cloud.subscribed_apps(cfg)
            out["subscribed_apps"] = subs.get("data", [])
            if not out["subscribed_apps"]:
                out["errors"].append(
                    "Nenhum app assinado nos webhooks do WABA — clique em 'Assinar webhooks'."
                )
        except Exception as exc:  # noqa: BLE001
            out["errors"].append(f"Webhooks: {exc}")
    else:
        out["errors"].append("WABA ID nao configurado — nao da pra checar a assinatura do webhook.")

    number.last_checked_at = datetime.now(timezone.utc)
    await session.commit()
    return out


@router.post("/{number_id}/subscribe")
async def subscribe(number_id: int, session: AsyncSession = Depends(get_session)):
    _, cfg = await _resolve(session, number_id)
    try:
        return await whatsapp_cloud.subscribe_app(cfg)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class SendTest(BaseModel):
    to: str
    body: str = "Teste de conexao da plataforma de trackeamento."


@router.post("/{number_id}/send-test")
async def send_test(number_id: int, payload: SendTest, session: AsyncSession = Depends(get_session)):
    """Manda uma mensagem de verdade pelo numero — so entrega dentro da janela de 24h."""
    _, cfg = await _resolve(session, number_id)
    try:
        return await whatsapp_cloud.send_text(cfg, payload.to, payload.body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{number_id}/templates")
async def templates(number_id: int, session: AsyncSession = Depends(get_session)):
    """Templates aprovados do WABA deste numero."""
    _, cfg = await _resolve(session, number_id)
    try:
        raw = await whatsapp_cloud.message_templates(cfg)
    except Exception as exc:  # noqa: BLE001
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


async def _resolve(session: AsyncSession, number_id: int | None) -> tuple[WaNumber, dict]:
    try:
        return await numbers_service.resolve_cfg(session, number_id)
    except numbers_service.NumberError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
