"""Repassa a conversao pra uma URL qualquer (n8n, Make, GTM server-side).

Assina o corpo com HMAC-SHA256 em X-Signature-256 quando ha secret configurado,
no mesmo formato que a Meta usa — assim o receptor consegue validar a origem.
"""

import hashlib
import hmac
import json

import httpx


class WebhookError(Exception):
    pass


async def send(cfg: dict, payload: dict) -> tuple[int, dict]:
    url = cfg.get("webhook_url") or ""
    if not url:
        raise WebhookError("URL do webhook de saida nao configurada.")

    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    secret = cfg.get("webhook_secret") or ""
    if secret:
        digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        headers["X-Signature-256"] = f"sha256={digest}"

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, content=body, headers=headers)

    try:
        parsed = resp.json()
    except ValueError:
        parsed = {"raw": resp.text[:2000]}

    if resp.status_code >= 400:
        raise WebhookError(f"Destino respondeu HTTP {resp.status_code}: {resp.text[:300]}")

    return resp.status_code, parsed if isinstance(parsed, dict) else {"data": parsed}
