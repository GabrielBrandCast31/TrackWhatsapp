"""Linhas de WhatsApp na Evolution API: cadastro, pareamento e Pixel/token.

Cada linha aqui e uma instancia da Evolution + o destino Meta dela (Pixel/Dataset
e token da Conversions API). E o unico cadastro que a tela principal pede.
"""

import logging
import os
import secrets

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import numbers as numbers_service
from app import phones, settings_store
from app.db import get_session
from app.models import Contact, Conversion, KeywordRule, WaNumber
from app.services import evolution
from app.services.dispatch import enabled_destinations

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/evolution", tags=["evolution"])

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8030")

# campos do destino Meta que a linha guarda em `overrides`
META_FIELDS = ("meta_dataset_id", "meta_capi_token", "meta_test_event_code")


def webhook_url_for(number: WaNumber) -> str:
    """URL que vai no webhook da instancia. O token na URL e o que autentica o POST."""
    base = PUBLIC_BASE_URL.rstrip("/")
    return f"{base}/webhook/evolution/{number.id}/{number.webhook_token or ''}"


def serialize(number: WaNumber, counts: dict | None = None, cfg: dict | None = None) -> dict:
    overrides = number.overrides or {}
    token = overrides.get("meta_capi_token") or ""
    return {
        "id": number.id,
        "label": number.label,
        "channel": number.channel,
        "instance": number.evo_instance,
        "base_url": number.evo_base_url,
        "state": number.evo_state,
        "owner_jid": number.evo_owner_jid,
        "display_phone_number": number.display_phone_number,
        "verified_name": number.verified_name,
        "last_checked_at": number.last_checked_at,
        "last_error": number.last_error,
        "active": number.active,
        "is_default": number.is_default,
        "note": number.note,
        "created_at": number.created_at,
        "webhook_url": webhook_url_for(number),
        # segredos nunca voltam em claro — so a marca de que existem
        "api_key__set": bool(number.evo_api_key),
        "api_key__hint": f"...{number.evo_api_key[-4:]}" if (number.evo_api_key or "") else "",
        "meta_dataset_id": overrides.get("meta_dataset_id") or "",
        "meta_test_event_code": overrides.get("meta_test_event_code") or "",
        "meta_capi_token__set": bool(token),
        "meta_capi_token__hint": f"...{token[-4:]}" if len(token) >= 4 else "",
        "enabled_destinations": enabled_destinations(cfg) if cfg else [],
        "counts": counts or {},
    }


class InstanceIn(BaseModel):
    label: str = Field(min_length=1)
    instance: str = Field(min_length=1)
    base_url: str | None = None
    api_key: str | None = None
    meta_dataset_id: str | None = None
    meta_capi_token: str | None = None
    meta_test_event_code: str | None = None
    note: str | None = None
    active: bool = True
    is_default: bool = False
    # cria a instancia na Evolution junto com a linha, em vez de exigir que
    # alguem crie por fora (painel da Evolution, curl) antes de cadastrar aqui
    create_on_evolution: bool = False


class InstancePatch(BaseModel):
    label: str | None = None
    instance: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    meta_dataset_id: str | None = None
    meta_capi_token: str | None = None
    meta_test_event_code: str | None = None
    note: str | None = None
    active: bool | None = None
    is_default: bool | None = None
    rotate_webhook_token: bool = False


def _apply_meta(number: WaNumber, payload: InstanceIn | InstancePatch) -> None:
    """Pixel e token viram override da linha. Token vazio mantem o que estava."""
    overrides = dict(number.overrides or {})
    for field in META_FIELDS:
        value = getattr(payload, field, None)
        if value is None:
            continue
        if field == "meta_capi_token" and value == "":
            continue  # nao apaga segredo por omissao
        overrides[field] = value.strip()
    # com pixel e token na linha, o destino Meta esta ligado pra ela
    if overrides.get("meta_dataset_id") and overrides.get("meta_capi_token"):
        overrides["meta_capi_enabled"] = True
    number.overrides = overrides


async def _counts(session: AsyncSession, number_id: int) -> dict:
    contacts = (
        await session.execute(select(func.count(Contact.id)).where(Contact.wa_number_id == number_id))
    ).scalar_one()
    conversions = (
        await session.execute(
            select(func.count(Conversion.id))
            .join(Contact, Contact.id == Conversion.contact_id)
            .where(Contact.wa_number_id == number_id)
        )
    ).scalar_one()
    rules = (
        await session.execute(
            select(func.count(KeywordRule.id)).where(KeywordRule.wa_number_id == number_id)
        )
    ).scalar_one()
    return {"contacts": contacts, "conversions": conversions, "rules": rules}


async def _require(session: AsyncSession, number_id: int) -> WaNumber:
    number = await session.get(WaNumber, number_id)
    if number is None or number.channel != "evolution":
        raise HTTPException(status_code=404, detail="Instância não encontrada.")
    return number


async def _cfg(session: AsyncSession, number: WaNumber) -> dict:
    return numbers_service.effective_cfg(await settings_store.load(session), number)


@router.get("/instances")
async def list_instances(session: AsyncSession = Depends(get_session)):
    rows = await numbers_service.list_numbers(session, channel="evolution")
    global_cfg = await settings_store.load(session)
    return [
        serialize(n, await _counts(session, n.id), numbers_service.effective_cfg(global_cfg, n))
        for n in rows
    ]


@router.get("/defaults")
async def defaults(session: AsyncSession = Depends(get_session)):
    """URL/apikey globais e catalogo de eventos — pre-enche o formulario."""
    cfg = await settings_store.load(session)
    from app.services.rules import EVENT_CATALOG

    return {
        "base_url": cfg.get("evo_base_url") or "",
        "api_key__set": bool(cfg.get("evo_api_key")),
        "webhook_base": PUBLIC_BASE_URL.rstrip("/"),
        "events": list(EVENT_CATALOG),
        "webhook_events": list(evolution.WEBHOOK_EVENTS),
    }


@router.get("/available")
async def available_instances(
    base_url: str | None = Query(default=None),
    api_key: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    """Instancias que existem na Evolution, pra tela oferecer em vez de texto livre.

    Aceita URL/apikey por query porque o formulario precisa consultar ANTES de a
    linha existir; sem elas, cai nas globais.
    """
    cfg = dict(await settings_store.load(session))
    if base_url:
        cfg["evo_base_url"] = base_url.strip()
    if api_key:
        cfg["evo_api_key"] = api_key.strip()

    taken = {
        n.evo_instance
        for n in await numbers_service.list_numbers(session, channel="evolution")
        if n.evo_instance
    }
    try:
        rows = await evolution.list_instances(cfg)
    except evolution.EvolutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # `registered` deixa a tela separar o que ja tem linha do que esta livre
    return [{**row, "registered": row["name"] in taken} for row in rows]


@router.post("/instances")
async def create_instance(payload: InstanceIn, session: AsyncSession = Depends(get_session)):
    instance = payload.instance.strip()
    if await numbers_service.by_evo_instance(session, instance):
        raise HTTPException(status_code=400, detail=f"A instância '{instance}' já está cadastrada.")

    global_cfg = await settings_store.load(session)
    first_line = not await numbers_service.list_numbers(session)
    number = WaNumber(
        label=payload.label.strip(),
        channel="evolution",
        phone_number_id=numbers_service.evo_routing_key(instance),
        evo_instance=instance,
        evo_base_url=(payload.base_url or global_cfg.get("evo_base_url") or "").strip() or None,
        evo_api_key=(payload.api_key or global_cfg.get("evo_api_key") or "").strip() or None,
        webhook_token=secrets.token_urlsafe(18),
        active=payload.active,
        note=payload.note,
        overrides={},
    )
    _apply_meta(number, payload)

    if payload.create_on_evolution:
        # antes de gravar a linha: se a criacao falhar, nao fica linha apontando
        # pra instancia que nao existe — o estado que dava 404 so no QR.
        await _ensure_on_evolution(numbers_service.effective_cfg(global_cfg, number), instance)

    session.add(number)
    await session.flush()

    # a primeira linha cadastrada vira a padrao: e ela que atende quando nenhuma
    # linha esta selecionada na tela.
    if payload.is_default or first_line:
        await numbers_service.set_default(session, number)
    await session.commit()
    await session.refresh(number)
    return serialize(number, await _counts(session, number.id), await _cfg(session, number))


async def _ensure_on_evolution(cfg: dict, instance: str) -> dict:
    """Cria a instancia se ela ainda nao existir. Idempotente de proposito:
    o botao pode ser clicado duas vezes, e criar de novo daria erro de nome em uso."""
    try:
        existing = {row["name"] for row in await evolution.list_instances(cfg)}
        if instance in existing:
            return {"created": False, "instance": instance}
        created = await evolution.create_instance(cfg, instance)
        log.info("evolution: instancia %s criada", instance)
        return {"created": True, "instance": created.get("name") or instance, "state": created.get("state")}
    except evolution.EvolutionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/instances/{number_id}/provision")
async def provision_instance(number_id: int, session: AsyncSession = Depends(get_session)):
    """Cria na Evolution a instancia que esta linha aponta.

    Resolve a linha que ja foi cadastrada com um nome que nao existe lá — o caso
    que antes so aparecia como `404 The "x" instance does not exist` no QR.
    """
    number = await _require(session, number_id)
    if not number.evo_instance:
        raise HTTPException(status_code=400, detail="Esta linha não tem nome de instância.")
    return await _ensure_on_evolution(await _cfg(session, number), number.evo_instance)


@router.patch("/instances/{number_id}")
async def patch_instance(
    number_id: int, payload: InstancePatch, session: AsyncSession = Depends(get_session)
):
    number = await _require(session, number_id)

    if payload.instance and payload.instance.strip() != number.evo_instance:
        instance = payload.instance.strip()
        clash = await numbers_service.by_evo_instance(session, instance)
        if clash and clash.id != number.id:
            raise HTTPException(status_code=400, detail=f"A instância '{instance}' já está cadastrada.")
        number.evo_instance = instance
        number.phone_number_id = numbers_service.evo_routing_key(instance)

    if payload.label is not None:
        number.label = payload.label.strip() or number.label
    if payload.base_url is not None:
        number.evo_base_url = payload.base_url.strip() or None
    if payload.api_key:  # vazio = mantem a atual
        number.evo_api_key = payload.api_key.strip()
    if payload.note is not None:
        number.note = payload.note
    if payload.active is not None:
        number.active = payload.active
    if payload.rotate_webhook_token:
        number.webhook_token = secrets.token_urlsafe(18)
    _apply_meta(number, payload)

    if payload.is_default:
        await numbers_service.set_default(session, number)

    await session.commit()
    await session.refresh(number)
    return serialize(number, await _counts(session, number.id), await _cfg(session, number))


@router.delete("/instances/{number_id}", status_code=204)
async def delete_instance(
    number_id: int,
    purge: bool = Query(default=False, description="apaga tambem os leads dessa linha"),
    session: AsyncSession = Depends(get_session),
):
    number = await _require(session, number_id)
    contacts = (
        (await session.execute(select(Contact).where(Contact.wa_number_id == number.id))).scalars().all()
    )
    for contact in contacts:
        if purge:
            await session.delete(contact)
        else:
            # base preservada: o lead fica sem dono e continua visivel em "todas as linhas"
            contact.wa_number_id = None
    rules = (
        (await session.execute(select(KeywordRule).where(KeywordRule.wa_number_id == number.id)))
        .scalars()
        .all()
    )
    for rule in rules:
        await session.delete(rule)  # regra e da linha: sem a linha, nao ha o que casar

    was_default = number.is_default
    await session.delete(number)
    await session.commit()

    if was_default:
        remaining = await numbers_service.list_numbers(session, only_active=True)
        if remaining:
            await numbers_service.set_default(session, remaining[0])
            await session.commit()


# ---------------------------------------------------------------------------
# pareamento e webhook
# ---------------------------------------------------------------------------


@router.get("/instances/{number_id}/status")
async def instance_status(number_id: int, session: AsyncSession = Depends(get_session)):
    """Estado real da instancia na Evolution, e guarda o resultado na linha."""
    number = await _require(session, number_id)
    cfg = await _cfg(session, number)

    from datetime import datetime, timezone

    out: dict = {"number_id": number.id, "configured": bool(number.evo_base_url and number.evo_api_key)}
    try:
        info = await evolution.fetch_instance(cfg)
        state = (info.get("state") or "").lower()
        number.evo_state = state or None
        number.evo_owner_jid = info.get("owner_jid")
        number.verified_name = info.get("profile_name") or number.verified_name
        if info.get("owner_jid"):
            digits = "".join(c for c in str(info["owner_jid"]).split("@")[0] if c.isdigit())
            number.display_phone_number = f"+{digits}" if digits else number.display_phone_number
        number.last_error = None
        out.update(
            {
                "connected": state in ("open", "connected"),
                "state": state,
                "owner_jid": info.get("owner_jid"),
                "profile_name": info.get("profile_name"),
                "errors": [],
            }
        )
    except Exception as exc:  # noqa: BLE001 — o erro da Evolution e o produto aqui
        number.last_error = str(exc)
        out.update({"connected": False, "state": None, "errors": [str(exc)]})

    try:
        webhook = await evolution.find_webhook(cfg)
        current = webhook.get("url") if isinstance(webhook, dict) else None
        if isinstance(webhook, dict) and isinstance(webhook.get("webhook"), dict):
            current = webhook["webhook"].get("url")
        out["webhook_configured"] = current
        out["webhook_matches"] = (current or "").rstrip("/") == webhook_url_for(number).rstrip("/")
    except Exception as exc:  # noqa: BLE001
        out["webhook_configured"] = None
        out["webhook_error"] = str(exc)

    number.last_checked_at = datetime.now(timezone.utc)
    await session.commit()
    out["webhook_url"] = webhook_url_for(number)
    return out


@router.post("/instances/{number_id}/connect")
async def instance_connect(number_id: int, session: AsyncSession = Depends(get_session)):
    """QR code / codigo de pareamento para conectar o WhatsApp nessa instancia."""
    number = await _require(session, number_id)
    try:
        return await evolution.connect(await _cfg(session, number))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/instances/{number_id}/webhook")
async def instance_set_webhook(number_id: int, session: AsyncSession = Depends(get_session)):
    """Aponta o webhook da instancia pra ca. Sem isso nada de rastreio chega."""
    number = await _require(session, number_id)
    if not number.webhook_token:
        number.webhook_token = secrets.token_urlsafe(18)
        await session.commit()
    url = webhook_url_for(number)
    try:
        raw = await evolution.set_webhook(await _cfg(session, number), url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"webhook_url": url, "events": list(evolution.WEBHOOK_EVENTS), "response": raw}


class SendTest(BaseModel):
    to: str
    body: str = "Teste de conexão da plataforma de rastreamento."


@router.post("/instances/{number_id}/send-test")
async def instance_send_test(
    number_id: int, payload: SendTest, session: AsyncSession = Depends(get_session)
):
    number = await _require(session, number_id)
    # `to_e164` poe o DDI em numero nacional de 10/11 digitos com DDD valido.
    # Sem isso, digitar "31971319392" (sem o 55) chega na Evolution como um numero
    # que nao existe, e o erro fala de `exists: False` em vez do DDI que faltou.
    e164 = phones.to_e164(payload.to)
    if not e164:
        raise HTTPException(
            status_code=400,
            detail="Número inválido. Use DDI + DDD + número — ex.: 5531971319392.",
        )
    to = phones.digits(e164)
    if not payload.body.strip():
        raise HTTPException(status_code=400, detail="A mensagem não pode ficar vazia.")
    try:
        return await evolution.send_text(await _cfg(session, number), to, payload.body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class SimulateIn(BaseModel):
    wa_id: str = "5511999998888"
    name: str = "Lead de Teste"
    text: str = "Olá! Vim pelo anúncio."
    ctwa_clid: str | None = "ARAySIMULADOclid1234567890"
    ad_id: str | None = "120210000000000000"
    source_url: str | None = "https://fb.me/simulado?utm_source=meta&utm_campaign=teste"
    from_me: bool = False


@router.post("/instances/{number_id}/simulate")
async def instance_simulate(
    number_id: int, payload: SimulateIn, session: AsyncSession = Depends(get_session)
):
    """Injeta um payload identico ao da Evolution — valida o fluxo inteiro sem anuncio no ar."""
    from app.evolution_ingest import build_simulated_payload, ingest_event

    number = await _require(session, number_id)
    fake = build_simulated_payload(
        instance=number.evo_instance or "simulado",
        wa_id="".join(c for c in payload.wa_id if c.isdigit()) or "5511999998888",
        name=payload.name,
        text=payload.text,
        ctwa_clid=payload.ctwa_clid,
        ad_id=payload.ad_id,
        source_url=payload.source_url,
        from_me=payload.from_me,
    )
    result = await ingest_event(session, fake, number)
    return {"simulated": True, **result}
