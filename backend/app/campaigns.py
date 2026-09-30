"""De onde o lead veio: anuncio -> campanha -> objetivo -> evento sugerido.

Tres fontes, em ordem de confianca:

1. o anuncio Click to WhatsApp (`source_id` = ad id, `ad_source_app`), resolvido
   para campanha/conjunto/objetivo pela Marketing API e guardado em `ad_campaigns`;
2. os identificadores de clique do Google (`gclid`, `wbraid`, `gbraid`);
3. as UTMs que vieram na url de origem ou no texto pre-preenchido pela landing page.

Sem nada disso, a conversa e organica (ou veio da agenda, no sync).

`lead_source` e funcao pura — e o que a tela do CRM mostra como etiqueta e o que
o disparo "pelo objetivo" usa para escolher o evento. `event_for_contact` e o
unico lugar que transforma o sentinela `OBJECTIVE_EVENT` num nome de evento.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AdCampaign, Contact
from app.services import meta_ads

log = logging.getLogger(__name__)

# erro de consulta (token sem permissao, anuncio apagado) nao e tentado de novo a
# cada tela aberta — so depois dessa janela, ou quando alguem pede de novo.
RETRY_AFTER = timedelta(hours=1)

_META_SOURCES = {"facebook", "fb", "instagram", "ig", "meta", "messenger", "whatsapp"}
_GOOGLE_SOURCES = {"google", "googleads", "google_ads", "adwords", "youtube"}

PLATFORM_LABEL = {"instagram": "Instagram", "facebook": "Facebook", "messenger": "Messenger"}


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def serialize_campaign(row: AdCampaign) -> dict:
    return {
        "ad_id": row.ad_id,
        "ad_name": row.ad_name,
        "adset_id": row.adset_id,
        "adset_name": row.adset_name,
        "campaign_id": row.campaign_id,
        "campaign_name": row.campaign_name,
        "objective": row.objective,
        "objective_label": meta_ads.objective_label(row.objective),
        "optimization_goal": row.optimization_goal,
        "status": row.status,
        "error": row.error,
        "manual": row.manual,
        "fetched_at": row.fetched_at,
    }


def _platform(contact: Contact, utm: dict) -> str | None:
    app = (contact.ad_source_app or "").lower()
    if app in PLATFORM_LABEL:
        return app
    src = (utm.get("utm_source") or "").lower()
    if src in ("ig", "instagram"):
        return "instagram"
    if src in ("fb", "facebook"):
        return "facebook"
    # sem `sourceApp`: o link do anuncio ainda diz em qual app ele rodou
    url = (contact.source_url or "").lower()
    if "instagram.com" in url:
        return "instagram"
    if "facebook.com" in url or "fb.me" in url or "fb.watch" in url:
        return "facebook"
    return None


def lead_source(contact: Contact, campaign: AdCampaign | None, cfg: dict | None = None) -> dict:
    """Etiqueta de origem do lead, com tudo que a tela precisa para explicá-la."""
    cfg = cfg or {}
    utm = dict(contact.utm or {})
    utm_source = (utm.get("utm_source") or "").lower()
    platform = _platform(contact, utm)
    default_event = cfg.get("default_event_name") or "Lead"

    out: dict = {
        "channel": "organic",
        "channel_label": "Orgânico",
        "platform": platform,
        "platform_label": PLATFORM_LABEL.get(platform or ""),
        "ad_id": contact.source_id,
        "ad_name": None,
        "ad_headline": contact.ad_headline,
        "adset_name": None,
        "campaign_id": None,
        "campaign_name": utm.get("utm_campaign"),
        "campaign_from": "utm" if utm.get("utm_campaign") else None,
        "objective": None,
        "objective_label": None,
        "optimization_goal": None,
        "campaign_status": None,
        "campaign_error": None,
        "suggested_event": default_event,
        "suggested_reason": "evento padrão da linha (sem objetivo de campanha conhecido)",
        "utm": utm,
    }

    is_meta_ad = bool(contact.ctwa_clid or contact.source_id or contact.source_type == "ad")
    is_google = bool(contact.gclid or contact.wbraid or contact.gbraid)

    if is_meta_ad:
        out["channel"] = "meta_ads"
        out["channel_label"] = f"{PLATFORM_LABEL[platform]} Ads" if platform in PLATFORM_LABEL else "Meta Ads"
        if campaign is not None:
            out["campaign_status"] = campaign.status
            out["campaign_error"] = campaign.error
            if campaign.campaign_name:
                out["campaign_name"] = campaign.campaign_name
                out["campaign_from"] = "manual" if campaign.manual else "meta"
            out.update(
                {
                    "campaign_id": campaign.campaign_id,
                    "adset_name": campaign.adset_name,
                    "ad_name": campaign.ad_name,
                    "objective": campaign.objective,
                    "objective_label": meta_ads.objective_label(campaign.objective),
                    "optimization_goal": campaign.optimization_goal,
                }
            )
            event = meta_ads.event_for_objective(campaign.objective, cfg)
            if event:
                out["suggested_event"] = event
                out["suggested_reason"] = (
                    f"objetivo da campanha: {meta_ads.objective_label(campaign.objective)}"
                )
        elif contact.source_id:
            out["campaign_status"] = "pending"
    elif is_google or utm_source in _GOOGLE_SOURCES:
        out["channel"] = "google_ads"
        out["channel_label"] = "Google Ads"
    elif utm_source in _META_SOURCES:
        # veio de link com UTM do Meta, mas sem o bloco CTWA: sem ctwa_clid, o
        # Meta nao liga o evento a campanha — por isso nao e "meta_ads".
        out["channel"] = "utm"
        out["channel_label"] = f"{PLATFORM_LABEL.get(platform or '', 'Meta')} (link)"
    elif utm:
        out["channel"] = "utm"
        out["channel_label"] = utm.get("utm_source") or "UTM"
    elif contact.origin == "sync":
        out["channel"] = "agenda"
        out["channel_label"] = "Agenda"
    elif contact.origin == "simulado":
        out["channel"] = "simulado"
        out["channel_label"] = "Simulado"

    # chave estavel para filtrar/agrupar na tela
    if out["channel"] == "meta_ads":
        out["key"] = f"meta:{out['campaign_id'] or out['campaign_name'] or contact.source_id or 'sem-anuncio'}"
    elif out["campaign_name"]:
        out["key"] = f"{out['channel']}:{out['campaign_name']}"
    else:
        out["key"] = out["channel"]
    return out


async def campaigns_for(session: AsyncSession, ad_ids) -> dict[str, AdCampaign]:
    ids = sorted({a for a in ad_ids if a})
    if not ids:
        return {}
    rows = (await session.execute(select(AdCampaign).where(AdCampaign.ad_id.in_(ids)))).scalars().all()
    return {r.ad_id: r for r in rows}


def _stale(row: AdCampaign | None) -> bool:
    """Precisa consultar o Meta? Nunca para o manual; erro so depois de RETRY_AFTER."""
    if row is None:
        return True
    if row.manual or row.status == "resolved":
        return False
    fetched = _as_utc(row.fetched_at)
    return fetched is None or datetime.now(timezone.utc) - fetched > RETRY_AFTER


async def resolve_ad(session: AsyncSession, cfg: dict, ad_id: str, *, force: bool = False) -> AdCampaign | None:
    """Garante o registro do anuncio no cache, consultando o Meta se preciso.

    Sem token de anuncios, nao grava nada: "pendente" diz mais na tela do que um
    erro repetido em cada anuncio.
    """
    row = await session.get(AdCampaign, ad_id)
    if row is not None and row.manual:
        return row
    if not force and not _stale(row):
        return row
    if not meta_ads.ads_token(cfg):
        return row

    if row is None:
        row = AdCampaign(ad_id=ad_id)
        session.add(row)
    row.fetched_at = datetime.now(timezone.utc)
    try:
        data = await meta_ads.fetch_ad(cfg, ad_id)
    except meta_ads.AdsError as exc:
        row.status = "error"
        row.error = str(exc)
        log.info("anuncio %s: campanha nao resolvida (%s)", ad_id, exc)
    else:
        for key, value in data.items():
            setattr(row, key, value)
        row.status = "resolved"
        row.error = None
    await session.commit()
    return row


async def resolve_for_number(
    session: AsyncSession, cfg: dict, number_id: int | None, *, force: bool = False, limit: int = 60
) -> dict:
    """Resolve os anuncios dos leads de uma linha que ainda nao tem campanha."""
    stmt = select(Contact.source_id).where(Contact.source_id.is_not(None)).distinct()
    if number_id is not None:
        stmt = stmt.where(Contact.wa_number_id == number_id)
    ad_ids = [a for a in (await session.execute(stmt)).scalars().all() if a]
    known = await campaigns_for(session, ad_ids)

    todo = [a for a in ad_ids if force or _stale(known.get(a))][:limit]
    result = {"ads": len(ad_ids), "checked": 0, "resolved": 0, "errors": [], "has_token": bool(meta_ads.ads_token(cfg))}
    if not result["has_token"]:
        return result

    for ad_id in todo:
        row = await resolve_ad(session, cfg, ad_id, force=True)
        result["checked"] += 1
        if row is not None and row.status == "resolved":
            result["resolved"] += 1
        elif row is not None and row.error and row.error not in result["errors"]:
            result["errors"].append(row.error)
    return result


async def event_for_contact(session: AsyncSession, cfg: dict, contact: Contact) -> tuple[str, str]:
    """(evento, motivo) que o objetivo da campanha do lead pede.

    Anuncio ainda nao resolvido e consultado aqui mesmo — e a hora em que o
    objetivo realmente importa. Sem objetivo conhecido, vale o evento padrao.
    """
    campaign = None
    if contact.source_id:
        campaign = await resolve_ad(session, cfg, contact.source_id)
    src = lead_source(contact, campaign, cfg)
    return src["suggested_event"], src["suggested_reason"]


# --- resolucao em segundo plano, disparada pelo webhook -----------------------

_inflight: set[str] = set()
_done: set[str] = set()


def schedule_resolve(cfg: dict, ad_ids) -> None:
    """Consulta a campanha de anuncios novos sem segurar o webhook.

    O webhook responde na hora; a consulta a Graph API (ate 8s) roda depois,
    com sessao propria. Sem token de anuncios nao agenda nada.
    """
    if not meta_ads.ads_token(cfg):
        return
    pending = [a for a in set(ad_ids) if a and a not in _inflight and a not in _done]
    if not pending:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    async def run() -> None:
        from app.db import SessionLocal

        try:
            async with SessionLocal() as session:
                for ad_id in pending:
                    row = await resolve_ad(session, cfg, ad_id)
                    if row is not None and row.status in ("resolved", "manual"):
                        _done.add(ad_id)
        except Exception:  # noqa: BLE001 — tarefa de fundo: loga e segue
            log.exception("falha resolvendo campanha dos anuncios %s", pending)
        finally:
            _inflight.difference_update(pending)

    _inflight.update(pending)
    loop.create_task(run())
