"""Resolucao de qual numero de WhatsApp esta em jogo e qual config vale pra ele.

A plataforma nasceu com um numero so, guardado no blob global de `settings`.
Agora cada numero e uma linha em `wa_numbers` com credenciais proprias e, se
quiser, destinos de conversao proprios. Este modulo e o unico lugar que sabe
juntar as duas coisas: `effective_cfg` devolve um dict no MESMO formato que o
resto do sistema (whatsapp_cloud, dispatch, apify) sempre consumiu — por isso
nenhum desses modulos precisou saber que multi-numero existe.
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import settings_store
from app.models import Contact, Outreach, Prospect, ProspectSearch, WaNumber

log = logging.getLogger(__name__)

# Credenciais da Cloud API: moram em coluna propria porque sao a identidade do numero.
CREDENTIAL_MAP = {
    "wa_access_token": "access_token",
    "wa_phone_number_id": "phone_number_id",
    "wa_business_account_id": "business_account_id",
    "wa_verify_token": "verify_token",
    "wa_app_secret": "app_secret",
    "graph_version": "graph_version",
}

# O que um numero pode sobrescrever da config global (destinos + abordagem).
OVERRIDABLE = (
    "meta_capi_enabled",
    "meta_dataset_id",
    "meta_capi_token",
    "meta_test_event_code",
    "google_ads_enabled",
    "google_customer_id",
    "google_login_customer_id",
    "google_conversion_action_id",
    "google_ads_version",
    "webhook_enabled",
    "webhook_url",
    "webhook_secret",
    "outreach_enabled",
    "outreach_template_name",
    "outreach_template_language",
    "outreach_throttle_seconds",
    "outreach_daily_cap",
    "outreach_only_mobile",
    "default_event_name",
    "default_currency",
    "auto_fire_on_first_message",
)

OVERRIDE_SECRETS = {"meta_capi_token", "webhook_secret"}


class NumberError(Exception):
    pass


def effective_cfg(global_cfg: dict, number: WaNumber | None) -> dict:
    """Config global + o que o numero sobrescreve. Sem numero, volta o global cru."""
    cfg = dict(global_cfg)
    if number is None:
        return cfg

    for key, value in (number.overrides or {}).items():
        if key not in OVERRIDABLE:
            continue
        if value is None or value == "":
            continue  # vazio significa "herda o global", nao "apaga"
        cfg[key] = value

    for cfg_key, column in CREDENTIAL_MAP.items():
        value = getattr(number, column, None)
        if value:
            cfg[cfg_key] = value

    cfg["wa_number_id"] = number.id
    cfg["wa_number_label"] = number.label
    return cfg


async def list_numbers(session: AsyncSession, only_active: bool = False) -> list[WaNumber]:
    stmt = select(WaNumber).order_by(WaNumber.is_default.desc(), WaNumber.id)
    if only_active:
        stmt = stmt.where(WaNumber.active.is_(True))
    return list((await session.execute(stmt)).scalars().all())


async def get_default(session: AsyncSession) -> WaNumber | None:
    rows = await list_numbers(session, only_active=True)
    for row in rows:
        if row.is_default:
            return row
    return rows[0] if rows else None


async def by_phone_number_id(session: AsyncSession, phone_number_id: str | None) -> WaNumber | None:
    if not phone_number_id:
        return None
    return (
        await session.execute(select(WaNumber).where(WaNumber.phone_number_id == str(phone_number_id)))
    ).scalar_one_or_none()


async def require(session: AsyncSession, number_id: int | None) -> WaNumber:
    """Numero pedido explicitamente, ou o padrao. Levanta se nao houver nenhum."""
    if number_id is not None:
        number = await session.get(WaNumber, number_id)
        if number is None:
            raise NumberError(f"Numero {number_id} nao encontrado.")
        return number

    number = await get_default(session)
    if number is None:
        raise NumberError(
            "Nenhum numero de WhatsApp cadastrado. Adicione um em Números antes de continuar."
        )
    return number


async def resolve_cfg(session: AsyncSession, number_id: int | None) -> tuple[WaNumber, dict]:
    """Atalho usado pelas rotas: (numero, config efetiva dele)."""
    number = await require(session, number_id)
    global_cfg = await settings_store.load(session)
    return number, effective_cfg(global_cfg, number)


async def set_default(session: AsyncSession, number: WaNumber) -> None:
    for row in await list_numbers(session):
        row.is_default = row.id == number.id
    number.is_default = True


async def seed_from_global_settings(session: AsyncSession) -> WaNumber | None:
    """Primeira subida em multi-numero: transforma a config antiga no numero #1.

    Sem isso, quem ja tinha um numero funcionando encontraria a plataforma vazia
    e teria que reconfigurar tudo na mao.
    """
    if await list_numbers(session):
        return None

    cfg = await settings_store.load(session)
    phone_number_id = (cfg.get("wa_phone_number_id") or "").strip()
    if not phone_number_id:
        return None

    number = WaNumber(
        label="Número principal",
        phone_number_id=phone_number_id,
        business_account_id=cfg.get("wa_business_account_id") or None,
        access_token=cfg.get("wa_access_token") or None,
        app_secret=cfg.get("wa_app_secret") or None,
        verify_token=cfg.get("wa_verify_token") or None,
        graph_version=cfg.get("graph_version") or None,
        active=True,
        is_default=True,
        overrides={},
        note="Migrado automaticamente da configuração antiga de número único.",
    )
    session.add(number)
    await session.flush()

    # tudo que existia antes pertencia a esse numero
    for model in (Contact, Prospect, ProspectSearch, Outreach):
        rows = (
            (await session.execute(select(model).where(model.wa_number_id.is_(None)))).scalars().all()
        )
        for row in rows:
            row.wa_number_id = number.id

    await session.commit()
    log.info("numero principal criado a partir da config global (phone_number_id=%s)", phone_number_id)
    return number
