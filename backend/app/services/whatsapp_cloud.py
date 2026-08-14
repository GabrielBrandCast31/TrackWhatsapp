"""Cliente da WhatsApp Cloud API (Graph API oficial da Meta)."""

import hashlib
import hmac
import re

import httpx

GRAPH = "https://graph.facebook.com"


class CloudAPIError(Exception):
    pass


def _base(cfg: dict) -> str:
    return f"{GRAPH}/{cfg.get('graph_version') or 'v21.0'}"


def _auth(cfg: dict) -> dict:
    token = cfg.get("wa_access_token") or ""
    if not token:
        raise CloudAPIError("Access token da Cloud API nao configurado.")
    return {"Authorization": f"Bearer {token}"}


def verify_signature(cfg: dict, raw_body: bytes, header: str | None) -> bool:
    """Valida o X-Hub-Signature-256. Se nao houver app secret, nao bloqueia."""
    secret = cfg.get("wa_app_secret") or ""
    if not secret:
        return True
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.split("=", 1)[1])


async def phone_number_info(cfg: dict) -> dict:
    """Dados do numero conectado — usado como 'status da conexao'."""
    pnid = cfg.get("wa_phone_number_id") or ""
    if not pnid:
        raise CloudAPIError("Phone Number ID nao configurado.")
    params = {"fields": "id,display_phone_number,verified_name,quality_rating,platform_type"}
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(f"{_base(cfg)}/{pnid}", headers=_auth(cfg), params=params)
    data = _unwrap(resp)
    return data


async def subscribed_apps(cfg: dict) -> dict:
    """Lista os apps assinados no WABA — confirma que o webhook vai chegar."""
    waba = cfg.get("wa_business_account_id") or ""
    if not waba:
        raise CloudAPIError("WhatsApp Business Account ID nao configurado.")
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(f"{_base(cfg)}/{waba}/subscribed_apps", headers=_auth(cfg))
    return _unwrap(resp)


async def subscribe_app(cfg: dict) -> dict:
    """Assina o app nos webhooks do WABA."""
    waba = cfg.get("wa_business_account_id") or ""
    if not waba:
        raise CloudAPIError("WhatsApp Business Account ID nao configurado.")
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(f"{_base(cfg)}/{waba}/subscribed_apps", headers=_auth(cfg))
    return _unwrap(resp)


async def send_text(cfg: dict, to: str, body: str) -> dict:
    """Responde o lead — util pra confirmar que a conexao esta de pe nos dois sentidos."""
    pnid = cfg.get("wa_phone_number_id") or ""
    if not pnid:
        raise CloudAPIError("Phone Number ID nao configurado.")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{_base(cfg)}/{pnid}/messages", headers=_auth(cfg), json=build_text_payload(to, body)
        )
    return _unwrap(resp)


async def message_templates(cfg: dict) -> list[dict]:
    """Templates do WABA.

    Abordagem ativa (fora da janela de 24h) so entrega por template aprovado — e por
    isso que a tela de prospeccao lista daqui em vez de aceitar texto livre.
    """
    waba = cfg.get("wa_business_account_id") or ""
    if not waba:
        raise CloudAPIError("WhatsApp Business Account ID nao configurado.")
    params = {"fields": "name,status,category,language,components", "limit": "200"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{_base(cfg)}/{waba}/message_templates", headers=_auth(cfg), params=params)
    data = _unwrap(resp)
    return data.get("data") or []


def template_body(template: dict) -> str:
    """Texto do componente BODY — o que a UI mostra como previa do template."""
    for comp in template.get("components") or []:
        if (comp.get("type") or "").upper() == "BODY":
            return comp.get("text") or ""
    return ""


def template_placeholders(template: dict) -> int:
    """Quantos {{n}} o corpo do template espera."""
    body = template_body(template)
    found = {int(m) for m in re.findall(r"\{\{(\d+)\}\}", body)}
    return max(found) if found else 0


def render_template(template_text: str, params: list[str]) -> str:
    """Substitui {{1}}, {{2}}... pelos valores enviados — so pra registrar no log."""
    out = template_text
    for i, val in enumerate(params, start=1):
        out = out.replace(f"{{{{{i}}}}}", val)
    return out


def build_template_payload(to: str, name: str, language: str, params: list[str]) -> dict:
    payload: dict = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "template",
        "template": {"name": name, "language": {"code": language}},
    }
    if params:
        payload["template"]["components"] = [
            {"type": "body", "parameters": [{"type": "text", "text": p} for p in params]}
        ]
    return payload


def build_text_payload(to: str, body: str) -> dict:
    return {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "text",
        "text": {"preview_url": False, "body": body},
    }


async def send_message(cfg: dict, payload: dict) -> tuple[int, dict]:
    """Envia um payload ja montado. Devolve (http_status, corpo) pro log de abordagem."""
    pnid = cfg.get("wa_phone_number_id") or ""
    if not pnid:
        raise CloudAPIError("Phone Number ID nao configurado.")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{_base(cfg)}/{pnid}/messages", headers=_auth(cfg), json=payload)
    return resp.status_code, _unwrap(resp)


def first_wamid(response: dict) -> str | None:
    messages = response.get("messages") if isinstance(response, dict) else None
    if isinstance(messages, list) and messages:
        return (messages[0] or {}).get("id")
    return None


def _unwrap(resp: httpx.Response) -> dict:
    try:
        data = resp.json()
    except ValueError:
        raise CloudAPIError(f"Resposta invalida da Graph API (HTTP {resp.status_code}).") from None
    if isinstance(data, dict) and "error" in data:
        err = data["error"]
        msg = err.get("error_user_msg") or err.get("message") or "Erro desconhecido."
        raise CloudAPIError(f"{msg} (code {err.get('code')})")
    return data
