"""Orquestra o envio de uma conversao para os destinos habilitados.

Cada destino vira um registro em `dispatches` com o payload que saiu e a resposta
que voltou — e isso que a tela de Conversoes mostra pra voce depurar o tracking.
Um destino que falha nao derruba os outros.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Contact, Conversion, Dispatch
from app.services import generic_webhook, google_ads, meta_capi
from app.tracking import to_e164

ALL_DESTINATIONS = ("meta_capi", "google_ads", "webhook")


def enabled_destinations(cfg: dict) -> list[str]:
    active = []
    if cfg.get("meta_capi_enabled"):
        active.append("meta_capi")
    if cfg.get("google_ads_enabled"):
        active.append("google_ads")
    if cfg.get("webhook_enabled"):
        active.append("webhook")
    return active


def _sanitize(payload: dict) -> dict:
    """Nunca persiste token no log de request."""
    clean = dict(payload)
    clean.pop("access_token", None)
    return clean


def _build_meta(cfg: dict, contact: Contact, conv: Conversion) -> dict:
    payload = meta_capi.build_payload(
        event_name=conv.event_name,
        event_id=conv.event_id,
        ctwa_clid=contact.ctwa_clid,
        phone=contact.phone_e164 or to_e164(contact.wa_id),
        value=conv.value,
        currency=conv.currency,
        event_time=int(conv.created_at.timestamp()),
        test_event_code=(cfg.get("meta_test_event_code") or None) if conv.is_test else None,
        extra_custom={"lead_source": "whatsapp", "ad_id": contact.source_id} if contact.source_id else None,
    )
    if not payload["data"][0]["user_data"].get("ctwa_clid"):
        raise meta_capi.CapiError(
            "Contato sem ctwa_clid — o Meta nao consegue atribuir esse evento a uma campanha. "
            "Use um lead vindo de anuncio Click to WhatsApp (ou o simulador)."
        )
    return payload


def _build_google(cfg: dict, contact: Contact, conv: Conversion) -> dict:
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


def _build_webhook(cfg: dict, contact: Contact, conv: Conversion) -> dict:
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


# destino -> (monta o payload, envia o payload)
_RUNNERS = {
    "meta_capi": (_build_meta, meta_capi.send),
    "google_ads": (_build_google, google_ads.send),
    "webhook": (_build_webhook, generic_webhook.send),
}


async def dispatch_conversion(
    session: AsyncSession,
    cfg: dict,
    conv: Conversion,
    contact: Contact,
    destinations: list[str] | None = None,
) -> list[Dispatch]:
    """Envia a conversao. Sem `destinations`, usa os que estao habilitados na config."""
    targets = destinations if destinations else enabled_destinations(cfg)
    results: list[Dispatch] = []

    for dest in targets:
        runner = _RUNNERS.get(dest)
        record = Dispatch(conversion_id=conv.id, destination=dest)
        if runner is None:
            record.status = "skipped"
            record.error = f"Destino desconhecido: {dest}"
        else:
            build, send = runner
            try:
                payload = build(cfg, contact, conv)
                # grava o payload ANTES de enviar: se o destino recusar, voce
                # ainda ve exatamente o que foi montado.
                record.request_payload = _sanitize(payload)
                http_status, body = await send(cfg, payload)
                record.http_status = http_status
                record.response_body = body if isinstance(body, dict) else {"data": body}
                record.status = "ok"
            except Exception as exc:  # noqa: BLE001 — o erro do destino e o produto aqui
                record.status = "error"
                record.error = str(exc)
        session.add(record)
        results.append(record)

    await session.commit()
    for record in results:
        await session.refresh(record)
    return results
