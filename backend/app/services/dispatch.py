"""Orquestra o envio de uma conversao para os destinos habilitados.

Cada destino vira um registro em `dispatches` com o payload que saiu e a resposta
que voltou — e isso que a tela de Conversoes mostra pra voce depurar o tracking.
Um destino que falha nao derruba os outros.

`meta_capi_page` e o evento do Meta no formato com `page_id` (sem WABA). Ele nao
e um destino que se liga sozinho: vai junto, em paralelo, sempre que `meta_capi`
sai e a linha tem Page ID — se um dos dois formatos for recusado, o outro ainda
leva a conversao.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AdCampaign, Contact, Conversion, Dispatch
from app.services import generic_webhook, google_ads, meta_capi
from app.tracking import to_e164

ALL_DESTINATIONS = ("meta_capi", "meta_capi_page", "google_ads", "webhook")


def enabled_destinations(cfg: dict) -> list[str]:
    active = []
    if cfg.get("meta_capi_enabled"):
        active.append("meta_capi")
    if cfg.get("google_ads_enabled"):
        active.append("google_ads")
    if cfg.get("webhook_enabled"):
        active.append("webhook")
    return active


def _with_parallel(cfg: dict, targets: list[str]) -> list[str]:
    """Poe `meta_capi_page` logo depois de `meta_capi` quando a linha tem Page ID."""
    if "meta_capi" not in targets or "meta_capi_page" in targets:
        return list(targets)
    if not meta_capi.business_ids(cfg)["page_id"]:
        return list(targets)
    out = list(targets)
    out.insert(out.index("meta_capi") + 1, "meta_capi_page")
    return out


def _sanitize(payload: dict) -> dict:
    """Nunca persiste token no log de request."""
    clean = dict(payload)
    clean.pop("access_token", None)
    return clean


def _build_meta(cfg: dict, contact: Contact, conv: Conversion, campaign: AdCampaign | None = None) -> dict:
    return meta_capi.build_payload(
        event_name=conv.event_name,
        event_id=conv.event_id,
        ctwa_clid=contact.ctwa_clid,
        phone=contact.phone_e164 or to_e164(contact.wa_id),
        **meta_capi.business_ids(cfg),
        value=conv.value,
        currency=conv.currency,
        event_time=int(conv.created_at.timestamp()),
        test_event_code=(cfg.get("meta_test_event_code") or None) if conv.is_test else None,
        extra_custom={"lead_source": "whatsapp", "ad_id": contact.source_id} if contact.source_id else None,
    )


def _check_meta(cfg: dict, payload: dict) -> None:
    """Barra antes de enviar o que o Meta com certeza recusa. `force` pula isso."""
    user_data = payload["data"][0]["user_data"]
    if not user_data.get("ctwa_clid"):
        raise meta_capi.CapiError(
            "Contato sem ctwa_clid — o Meta nao consegue atribuir esse evento a uma campanha. "
            "Use um lead vindo de anuncio Click to WhatsApp (ou o simulador)."
        )
    if not user_data.get("whatsapp_business_account_id"):
        has_page = bool(meta_capi.business_ids(cfg)["page_id"])
        raise meta_capi.CapiError(
            "Linha sem WhatsApp Business Account ID (WABA) — o Meta exige ele em evento do WhatsApp"
            + (" (o Page ID preenchido não serve: ele é do Messenger)" if has_page else "")
            + ". Pegue em Business Manager > Configurações do negócio > Contas > Contas do WhatsApp "
            "e preencha em Rastreamento > Meta."
        )


def ad_custom_data(contact: Contact, campaign: AdCampaign | None) -> dict:
    """Dados do anuncio que o formato `page_id` leva em `custom_data`."""
    ad = {
        "ad_id": contact.source_id,
        "source_id": contact.source_id,
        "source_type": contact.source_type,
        "source_url": contact.source_url,
        "source_app": contact.ad_source_app,
    }
    if campaign is not None:
        ad.update(
            ad_name=campaign.ad_name,
            adset_id=campaign.adset_id,
            adset_name=campaign.adset_name,
            campaign_id=campaign.campaign_id,
            campaign_name=campaign.campaign_name,
        )
    return ad


def _build_meta_page(cfg: dict, contact: Contact, conv: Conversion, campaign: AdCampaign | None = None) -> dict:
    page_id = meta_capi.business_ids(cfg)["page_id"]
    if not page_id:
        raise meta_capi.CapiError("Linha sem Page ID — o formato paralelo do Meta precisa dele (Rastreamento > Meta).")
    if not contact.ctwa_clid:
        raise meta_capi.CapiError(
            "Contato sem ctwa_clid — o Meta nao consegue atribuir esse evento a uma campanha. "
            "Use um lead vindo de anuncio Click to WhatsApp (ou o simulador)."
        )
    return meta_capi.build_page_payload(
        event_name=conv.event_name,
        event_id=conv.event_id,
        ctwa_clid=contact.ctwa_clid,
        phone=contact.phone_e164 or to_e164(contact.wa_id),
        page_id=page_id,
        value=conv.value,
        currency=conv.currency,
        event_time=int(conv.created_at.timestamp()),
        test_event_code=(cfg.get("meta_test_event_code") or None) if conv.is_test else None,
        ad=ad_custom_data(contact, campaign),
    )


def _build_google(cfg: dict, contact: Contact, conv: Conversion, campaign: AdCampaign | None = None) -> dict:
    return google_ads.build_payload(
        cfg,
        gclid=contact.gclid,
        wbraid=contact.wbraid,
        gbraid=contact.gbraid,
        value=conv.value,
        currency=conv.currency,
        order_id=conv.event_id,
        when=conv.created_at,
    )


def _build_webhook(cfg: dict, contact: Contact, conv: Conversion, campaign: AdCampaign | None = None) -> dict:
    return {
        "event_name": conv.event_name,
        "event_id": conv.event_id,
        "event_time": conv.created_at.isoformat(),
        "is_test": conv.is_test,
        "value": conv.value,
        "currency": conv.currency,
        "note": conv.note,
        "contact": {
            "id": contact.id,
            "wa_id": contact.wa_id,
            "phone_e164": contact.phone_e164 or to_e164(contact.wa_id),
            "name": contact.name,
            "first_message": contact.first_message,
        },
        "attribution": {
            "ctwa_clid": contact.ctwa_clid,
            "ad_id": contact.source_id,
            "source_type": contact.source_type,
            "source_url": contact.source_url,
            "gclid": contact.gclid,
            "wbraid": contact.wbraid,
            "gbraid": contact.gbraid,
            "utm": contact.utm or {},
        },
    }


# destino -> (monta o payload, checa antes de enviar, envia o payload)
_RUNNERS = {
    "meta_capi": (_build_meta, _check_meta, meta_capi.send),
    "meta_capi_page": (_build_meta_page, None, meta_capi.send),
    "google_ads": (_build_google, None, google_ads.send),
    "webhook": (_build_webhook, None, generic_webhook.send),
}


async def dispatch_conversion(
    session: AsyncSession,
    cfg: dict,
    conv: Conversion,
    contact: Contact,
    destinations: list[str] | None = None,
    *,
    force: bool = False,
    exact: bool = False,
) -> list[Dispatch]:
    """Envia a conversao. Sem `destinations`, usa os que estao habilitados na config.

    `force` pula as checagens locais e manda mesmo assim, pra ver o que o destino
    responde. `exact` envia so os destinos pedidos, sem puxar o formato paralelo.
    """
    targets = destinations if destinations else enabled_destinations(cfg)
    if not exact:
        targets = _with_parallel(cfg, targets)
    results: list[Dispatch] = []
    # so o cache: consultar a Marketing API aqui atrasaria o envio
    campaign = await session.get(AdCampaign, contact.source_id) if contact.source_id else None

    for dest in targets:
        runner = _RUNNERS.get(dest)
        record = Dispatch(conversion_id=conv.id, destination=dest)
        if runner is None:
            record.status = "skipped"
            record.error = f"Destino desconhecido: {dest}"
        else:
            build, check, send = runner
            try:
                payload = build(cfg, contact, conv, campaign)
                # grava o payload ANTES de enviar: se o destino recusar, voce
                # ainda ve exatamente o que foi montado.
                record.request_payload = _sanitize(payload)
                if check is not None and not force:
                    check(cfg, payload)
                http_status, body = await send(cfg, payload)
                record.http_status = http_status
                record.response_body = body if isinstance(body, dict) else {"data": body}
                record.status = "ok"
            except Exception as exc:  # noqa: BLE001 — o erro do destino e o produto aqui
                record.status = "error"
                record.error = str(exc)
                if getattr(exc, "http_status", None) is not None:
                    record.http_status = exc.http_status
                if getattr(exc, "body", None) is not None:
                    record.response_body = exc.body
        session.add(record)
        results.append(record)

    await session.commit()
    for record in results:
        await session.refresh(record)
    return results
