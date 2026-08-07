"""Envio de conversao para a Conversions API do Meta.

Para conversa vinda de Click to WhatsApp o evento tem uma forma especifica:

  action_source     = "business_messaging"
  messaging_channel = "whatsapp"
  user_data.ctwa_clid = <clid que veio no referral do webhook>   # NAO hasheado

O ctwa_clid e o que amarra a conversa de volta ao anuncio. Telefone e email,
quando presentes, vao hasheados em SHA-256 (normalizados antes).
"""

import hashlib
import re
import time

import httpx

GRAPH = "https://graph.facebook.com"


class CapiError(Exception):
    pass


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_phone(phone: str | None) -> str | None:
    """E.164 sem '+' e sem separadores, minusculo, depois SHA-256."""
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    return _sha256(digits) if digits else None


def hash_email(email: str | None) -> str | None:
    if not email:
        return None
    return _sha256(email.strip().lower())


def build_payload(
    *,
    event_name: str,
    event_id: str,
    ctwa_clid: str | None,
    phone: str | None,
    email: str | None = None,
    value: float | None = None,
    currency: str = "BRL",
    event_time: int | None = None,
    test_event_code: str | None = None,
    extra_custom: dict | None = None,
) -> dict:
    user_data: dict = {}
    if ctwa_clid:
        user_data["ctwa_clid"] = ctwa_clid
    hashed_phone = hash_phone(phone)
    if hashed_phone:
        user_data["ph"] = [hashed_phone]
    hashed_email = hash_email(email)
    if hashed_email:
        user_data["em"] = [hashed_email]

    custom_data: dict = dict(extra_custom or {})
    if value is not None:
        custom_data["value"] = value
        custom_data["currency"] = currency

    event: dict = {
        "event_name": event_name,
        "event_time": event_time or int(time.time()),
        "event_id": event_id,
        "action_source": "business_messaging",
        "messaging_channel": "whatsapp",
        "user_data": user_data,
    }
    if custom_data:
        event["custom_data"] = custom_data

    payload: dict = {"data": [event]}
    if test_event_code:
        payload["test_event_code"] = test_event_code
    return payload


async def send(cfg: dict, payload: dict) -> tuple[int, dict]:
    """POST /{dataset_id}/events. Devolve (http_status, corpo)."""
    dataset = cfg.get("meta_dataset_id") or ""
    token = cfg.get("meta_capi_token") or ""
    if not dataset:
        raise CapiError("Dataset/Pixel ID do Meta nao configurado.")
    if not token:
        raise CapiError("Access token da Conversions API nao configurado.")

    version = cfg.get("graph_version") or "v21.0"
    url = f"{GRAPH}/{version}/{dataset}/events"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, params={"access_token": token}, json=payload)

    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text[:2000]}

    if isinstance(body, dict) and "error" in body:
        err = body["error"]
        msg = err.get("error_user_msg") or err.get("message") or "Erro desconhecido."
        raise CapiError(f"{msg} (code {err.get('code')}, subcode {err.get('error_subcode')})")

    return resp.status_code, body
