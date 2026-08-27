"""Configuracao da plataforma: default vem do .env, override vem do banco (UI).

Tudo que o usuario consegue editar na tela de Configuracoes mora aqui.
Campos marcados como secretos nunca voltam em claro pra UI — so um mascarado.
"""

import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Setting

SETTINGS_KEY = "config"

SECRET_FIELDS = {
    "evo_api_key",
    "wa_access_token",
    "wa_app_secret",
    "meta_capi_token",
    "google_client_secret",
    "google_refresh_token",
    "google_developer_token",
    "webhook_secret",
    "apify_token",
}

DEFAULTS: dict = {
    # --- Evolution API (canal padrao) ---
    # Servem de base pra novas linhas: quem usa uma Evolution so nao precisa
    # repetir URL e apikey em cada instancia.
    "evo_base_url": os.getenv("EVOLUTION_BASE_URL", ""),
    "evo_api_key": os.getenv("EVOLUTION_API_KEY", ""),
    # --- WhatsApp Cloud API (canal legado, area de admin) ---
    "wa_access_token": os.getenv("WA_ACCESS_TOKEN", ""),
    "wa_phone_number_id": os.getenv("WA_PHONE_NUMBER_ID", ""),
    "wa_business_account_id": os.getenv("WA_BUSINESS_ACCOUNT_ID", ""),
    "wa_verify_token": os.getenv("WA_VERIFY_TOKEN", "brandcast-verify"),
    "wa_app_secret": os.getenv("WA_APP_SECRET", ""),
    "graph_version": os.getenv("GRAPH_VERSION", "v21.0"),
    # --- Meta Conversions API ---
    "meta_capi_enabled": True,
    "meta_dataset_id": os.getenv("META_DATASET_ID", ""),   # Pixel ID ou Dataset ID
    "meta_capi_token": os.getenv("META_CAPI_TOKEN", ""),
    "meta_test_event_code": os.getenv("META_TEST_EVENT_CODE", ""),
    # --- Google Ads offline conversions ---
    "google_ads_enabled": False,
    "google_customer_id": os.getenv("GOOGLE_CUSTOMER_ID", ""),          # sem tracos
    "google_login_customer_id": os.getenv("GOOGLE_LOGIN_CUSTOMER_ID", ""),  # MCC, opcional
    "google_conversion_action_id": os.getenv("GOOGLE_CONVERSION_ACTION_ID", ""),
    "google_client_id": os.getenv("GOOGLE_CLIENT_ID", ""),
    "google_client_secret": os.getenv("GOOGLE_CLIENT_SECRET", ""),
    "google_refresh_token": os.getenv("GOOGLE_REFRESH_TOKEN", ""),
    "google_developer_token": os.getenv("GOOGLE_DEVELOPER_TOKEN", ""),
    "google_ads_version": os.getenv("GOOGLE_ADS_VERSION", "v18"),
    # --- Webhook generico ---
    "webhook_enabled": False,
    "webhook_url": os.getenv("OUT_WEBHOOK_URL", ""),
    "webhook_secret": os.getenv("OUT_WEBHOOK_SECRET", ""),
    # --- Prospeccao ativa: varredura no Google Maps via Apify ---
    "apify_token": os.getenv("APIFY_TOKEN", ""),
    "apify_actor": os.getenv("APIFY_ACTOR", "compass/crawler-google-places"),
    "prospect_language": os.getenv("PROSPECT_LANGUAGE", "pt-BR"),
    "prospect_default_radius_km": float(os.getenv("PROSPECT_DEFAULT_RADIUS_KM", "5")),
    "prospect_max_per_term": int(os.getenv("PROSPECT_MAX_PER_TERM", "60")),
    # --- Abordagem ativa no WhatsApp ---
    # Desligado por padrao: ninguem dispara pra lista fria por acidente.
    "outreach_enabled": False,
    "outreach_template_name": os.getenv("OUTREACH_TEMPLATE_NAME", ""),
    "outreach_template_language": os.getenv("OUTREACH_TEMPLATE_LANGUAGE", "pt_BR"),
    "outreach_throttle_seconds": int(os.getenv("OUTREACH_THROTTLE_SECONDS", "8")),
    "outreach_daily_cap": int(os.getenv("OUTREACH_DAILY_CAP", "80")),
    "outreach_only_mobile": True,
    # --- Comportamento ---
    "default_event_name": "Lead",
    "default_currency": "BRL",
    # primeiro contato vindo de anuncio dispara um evento leve na hora. O evento
    # de valor real fica com as regras de palavra-chave.
    "auto_fire_on_first_message": False,
    "auto_fire_event_name": "Contact",
}


async def load(session: AsyncSession) -> dict:
    """Config efetiva: DEFAULTS sobrescrito pelo que estiver salvo no banco."""
    row = await session.get(Setting, SETTINGS_KEY)
    cfg = dict(DEFAULTS)
    if row and isinstance(row.value, dict):
        cfg.update({k: v for k, v in row.value.items() if k in DEFAULTS})
    return cfg


async def save(session: AsyncSession, patch: dict) -> dict:
    """Aplica um patch parcial. Campo secreto enviado vazio mantem o valor atual."""
    row = await session.get(Setting, SETTINGS_KEY)
    if row is None:
        row = Setting(key=SETTINGS_KEY, value={})
        session.add(row)

    current = dict(row.value or {})
    for key, val in patch.items():
        if key not in DEFAULTS:
            continue
        if key in SECRET_FIELDS and (val is None or val == ""):
            continue  # nao apaga segredo por omissao
        current[key] = val

    row.value = current
    await session.commit()
    return await load(session)


def mask(cfg: dict) -> dict:
    """Versao segura pra mandar pro frontend."""
    out = dict(cfg)
    for field in SECRET_FIELDS:
        val = out.get(field) or ""
        out[field] = ""
        out[f"{field}__set"] = bool(val)
        out[f"{field}__hint"] = f"...{val[-4:]}" if len(val) >= 4 else ""
    return out


async def get_setting_row(session: AsyncSession) -> Setting | None:
    result = await session.execute(select(Setting).where(Setting.key == SETTINGS_KEY))
    return result.scalar_one_or_none()
