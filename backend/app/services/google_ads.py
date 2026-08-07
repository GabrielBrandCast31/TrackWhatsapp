"""Upload de conversao offline pro Google Ads (uploadClickConversions via REST).

Requer: developer token, OAuth client (id/secret) + refresh token de uma conta
com acesso ao Ads, o customer id da conta e o id da conversion action.

O que amarra a conversa de WhatsApp ao clique e o gclid/wbraid — que a landing
page precisa ter embutido no link do wa.me (ver app/tracking.py).
"""

from datetime import datetime, timedelta, timezone

import httpx

TOKEN_URL = "https://oauth2.googleapis.com/token"
ADS_HOST = "https://googleads.googleapis.com"


class GoogleAdsError(Exception):
    pass


async def _access_token(cfg: dict) -> str:
    client_id = cfg.get("google_client_id") or ""
    client_secret = cfg.get("google_client_secret") or ""
    refresh_token = cfg.get("google_refresh_token") or ""
    missing = [
        name
        for name, val in (
            ("Client ID", client_id),
            ("Client Secret", client_secret),
            ("Refresh Token", refresh_token),
        )
        if not val
    ]
    if missing:
        raise GoogleAdsError("Credenciais OAuth faltando: " + ", ".join(missing))

    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(TOKEN_URL, data=data)
    body = resp.json() if resp.content else {}
    if resp.status_code != 200 or "access_token" not in body:
        raise GoogleAdsError(f"Falha ao renovar token OAuth: {body.get('error_description') or body}")
    return body["access_token"]


def _conversion_datetime(when: datetime | None, offset_hours: int = -3) -> str:
    """Formato exigido: 'yyyy-mm-dd hh:mm:ss+|-hh:mm' — sempre com offset explicito."""
    tz = timezone(timedelta(hours=offset_hours))
    dt = (when or datetime.now(timezone.utc)).astimezone(tz)
    stamp = dt.strftime("%Y-%m-%d %H:%M:%S")
    off = dt.strftime("%z")
    return f"{stamp}{off[:3]}:{off[3:]}"


def build_payload(
    cfg: dict,
    *,
    gclid: str | None,
    wbraid: str | None = None,
    gbraid: str | None = None,
    value: float | None = None,
    currency: str = "BRL",
    order_id: str | None = None,
    when: datetime | None = None,
) -> dict:
    customer_id = (cfg.get("google_customer_id") or "").replace("-", "")
    action_id = cfg.get("google_conversion_action_id") or ""
    if not customer_id:
        raise GoogleAdsError("Customer ID do Google Ads nao configurado.")
    if not action_id:
        raise GoogleAdsError("Conversion Action ID nao configurado.")
    if not (gclid or wbraid or gbraid):
        raise GoogleAdsError("Contato sem gclid/wbraid/gbraid — nao da pra atribuir no Google.")

    conversion: dict = {
        "conversionAction": f"customers/{customer_id}/conversionActions/{action_id}",
        "conversionDateTime": _conversion_datetime(when),
    }
    if gclid:
        conversion["gclid"] = gclid
    elif wbraid:
        conversion["wbraid"] = wbraid
    else:
        conversion["gbraid"] = gbraid

    if value is not None:
        conversion["conversionValue"] = value
        conversion["currencyCode"] = currency
    if order_id:
        conversion["orderId"] = order_id

    return {"conversions": [conversion], "partialFailure": True}


async def send(cfg: dict, payload: dict) -> tuple[int, dict]:
    customer_id = (cfg.get("google_customer_id") or "").replace("-", "")
    version = cfg.get("google_ads_version") or "v18"
    dev_token = cfg.get("google_developer_token") or ""
    if not dev_token:
        raise GoogleAdsError("Developer token do Google Ads nao configurado.")

    headers = {
        "Authorization": f"Bearer {await _access_token(cfg)}",
        "developer-token": dev_token,
        "Content-Type": "application/json",
    }
    login_cid = (cfg.get("google_login_customer_id") or "").replace("-", "")
    if login_cid:
        headers["login-customer-id"] = login_cid

    url = f"{ADS_HOST}/{version}/customers/{customer_id}:uploadClickConversions"
    async with httpx.AsyncClient(timeout=40) as client:
        resp = await client.post(url, headers=headers, json=payload)

    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text[:2000]}

    if resp.status_code >= 400:
        raise GoogleAdsError(_readable_error(body, resp.status_code))

    # partialFailure devolve 200 com o erro dentro do corpo
    partial = body.get("partialFailureError") if isinstance(body, dict) else None
    if partial:
        raise GoogleAdsError(f"Partial failure: {partial.get('message')}")

    return resp.status_code, body


def _readable_error(body: dict, status: int) -> str:
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        details = err.get("details") or []
        for detail in details:
            for failure in detail.get("errors", []) if isinstance(detail, dict) else []:
                if failure.get("message"):
                    return f"{failure['message']} (HTTP {status})"
        if err.get("message"):
            return f"{err['message']} (HTTP {status})"
    return f"Erro do Google Ads (HTTP {status})."
