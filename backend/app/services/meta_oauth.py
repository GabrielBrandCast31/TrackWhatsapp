"""Login do Facebook (OAuth 2.0) e as chamadas da Graph API que vem depois dele.

O fluxo e o "manual" da Meta, todo pelo servidor:

1. o painel pede a URL do dialogo (`dialog_url`) e manda o navegador pra la;
2. a pessoa autoriza; o Facebook volta em `REDIRECT_URI` com `code` + `state`;
3. `exchange_code` troca o code por token curto e o curto pelo de longa duracao
   (~60 dias) — e o que fica guardado.

O App Secret nunca sai do backend. Credenciais do app vem do .env:

    META_APP_ID, META_APP_SECRET            obrigatorios
    META_LOGIN_CONFIG_ID                     opcional: "Login do Facebook para Empresas"
                                             usa uma configuracao no lugar de `scope`
    META_WEBHOOK_VERIFY_TOKEN               o que o painel do app manda no GET do webhook
"""

import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx

GRAPH = "https://graph.facebook.com"
VERSION = os.getenv("GRAPH_VERSION") or "v21.0"

APP_ID = os.getenv("META_APP_ID", "").strip()
APP_SECRET = os.getenv("META_APP_SECRET", "").strip()
LOGIN_CONFIG_ID = os.getenv("META_LOGIN_CONFIG_ID", "").strip()
WEBHOOK_VERIFY_TOKEN = os.getenv("META_WEBHOOK_VERIFY_TOKEN", "").strip()

PUBLIC_BASE_URL = (os.getenv("PUBLIC_BASE_URL") or "http://localhost:3031").rstrip("/")
# Tem que ser IDENTICA a cadastrada em "URIs de redirecionamento do OAuth validos"
REDIRECT_URI = f"{PUBLIC_BASE_URL}/api/meta/oauth/callback"
# para onde o navegador volta depois do callback (o painel). No compose e o mesmo host.
# `or`, nao default do getenv: o env_file do compose define a chave vazia
FRONTEND_URL = (os.getenv("FRONTEND_URL") or PUBLIC_BASE_URL).rstrip("/")

# Conectar uma linha: anuncios + Pixel (CAPI) + Paginas com Lead Ads.
CONNECT_SCOPES = (
    "ads_read",
    "ads_management",          # o token de usuario so envia evento pro Pixel com ele
    "business_management",
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_metadata",   # inscrever o app no webhook `leadgen` da Pagina
    "pages_manage_ads",
    "leads_retrieval",
)
# Login no painel / vincular conta: so o id da pessoa.
LOGIN_SCOPES = ("public_profile",)


class MetaError(Exception):
    pass


def configured() -> bool:
    return bool(APP_ID and APP_SECRET)


def dialog_url(state: str, connect: bool, rerequest: bool = False) -> str:
    """URL do dialogo. `connect`: permissoes de anuncios/Paginas; senao, so o perfil."""
    params = {
        "client_id": APP_ID,
        "redirect_uri": REDIRECT_URI,
        "state": state,
        "response_type": "code",
    }
    if connect and LOGIN_CONFIG_ID:
        params["config_id"] = LOGIN_CONFIG_ID
    else:
        params["scope"] = ",".join(CONNECT_SCOPES if connect else LOGIN_SCOPES)
    if rerequest:
        # quem negou uma permissao antes so ve o pedido de novo com isto
        params["auth_type"] = "rerequest"
    return f"https://www.facebook.com/{VERSION}/dialog/oauth?{urlencode(params)}"


def _raise_for(body, status: int) -> None:
    if isinstance(body, dict) and "error" in body:
        err = body["error"] or {}
        msg = err.get("error_user_msg") or err.get("message") or "Erro desconhecido."
        raise MetaError(f"{msg} (code {err.get('code')})")
    if status >= 400:
        raise MetaError(f"Graph API respondeu HTTP {status}.")


async def graph(method: str, path: str, token: str | None = None, **params) -> dict:
    """Uma chamada a Graph API. Erro do Meta vira MetaError com a mensagem dele."""
    if token:
        params["access_token"] = token
    url = f"{GRAPH}/{VERSION}/{path.lstrip('/')}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            if method == "GET":
                resp = await client.get(url, params=params)
            else:
                # token no corpo: URL com credencial vaza em log de proxy
                resp = await client.request(method, url, data=params)
    except httpx.HTTPError as exc:
        raise MetaError(f"Não consegui falar com a Graph API: {exc}") from exc
    try:
        body = resp.json()
    except ValueError as exc:
        raise MetaError(f"Resposta inválida da Graph API (HTTP {resp.status_code}).") from exc
    _raise_for(body, resp.status_code)
    return body if isinstance(body, dict) else {"data": body}


async def paged(path: str, token: str, limit: int = 500, **params) -> list[dict]:
    """Lista inteira de uma edge paginada, ate `limit` itens."""
    out: list[dict] = []
    params.setdefault("limit", 100)
    body = await graph("GET", path, token, **params)
    while True:
        out.extend(body.get("data") or [])
        nxt = (body.get("paging") or {}).get("next")
        if not nxt or len(out) >= limit:
            return out[:limit]
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(nxt)
            body = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise MetaError(f"Falha ao paginar {path}: {exc}") from exc
        _raise_for(body, resp.status_code)


async def exchange_code(code: str) -> dict:
    """code -> token de longa duracao, com id/nome da pessoa e as permissoes dadas."""
    short = await graph(
        "GET", "oauth/access_token",
        client_id=APP_ID, client_secret=APP_SECRET, redirect_uri=REDIRECT_URI, code=code,
    )
    long = await graph(
        "GET", "oauth/access_token",
        grant_type="fb_exchange_token", client_id=APP_ID, client_secret=APP_SECRET,
        fb_exchange_token=short["access_token"],
    )
    token = long["access_token"]
    expires_in = long.get("expires_in")
    me = await graph("GET", "me", token, fields="id,name")
    perms = await graph("GET", "me/permissions", token)
    granted = [p["permission"] for p in perms.get("data") or [] if p.get("status") == "granted"]
    return {
        "access_token": token,
        "expires_at": (
            datetime.now(timezone.utc) + timedelta(seconds=int(expires_in)) if expires_in else None
        ),
        "fb_user_id": str(me["id"]),
        "fb_user_name": me.get("name"),
        "scopes": granted,
    }


# --- ativos da conta conectada -----------------------------------------------

async def ad_accounts(token: str) -> list[dict]:
    rows = await paged("me/adaccounts", token, fields="id,account_id,name,account_status,business{name}")
    return [
        {
            "id": r["id"],                       # act_123
            "name": r.get("name") or r["id"],
            "business": (r.get("business") or {}).get("name"),
            "active": r.get("account_status") == 1,
        }
        for r in rows
    ]


async def pixels(token: str, ad_account_id: str) -> list[dict]:
    rows = await paged(f"{ad_account_id}/adspixels", token, fields="id,name,last_fired_time")
    return [
        {"id": r["id"], "name": r.get("name") or r["id"], "last_fired_time": r.get("last_fired_time")}
        for r in rows
    ]


async def pages(token: str) -> list[dict]:
    """Paginas que a pessoa administra, COM o token de cada uma (nao vai pra tela)."""
    rows = await paged("me/accounts", token, fields="id,name,access_token,tasks")
    return [
        {"id": r["id"], "name": r.get("name") or r["id"], "access_token": r.get("access_token"),
         "tasks": r.get("tasks") or []}
        for r in rows
    ]


async def subscribe_leadgen(page_id: str, page_token: str) -> None:
    await graph("POST", f"{page_id}/subscribed_apps", page_token, subscribed_fields="leadgen")


async def unsubscribe(page_id: str, page_token: str) -> None:
    await graph("DELETE", f"{page_id}/subscribed_apps", page_token)


LEAD_FIELDS = "id,created_time,field_data,ad_id,ad_name,adset_id,campaign_id,campaign_name,form_id,platform"


async def lead(leadgen_id: str, page_token: str) -> dict:
    return await graph("GET", leadgen_id, page_token, fields=LEAD_FIELDS)


async def lead_forms(page_id: str, page_token: str) -> list[dict]:
    return await paged(f"{page_id}/leadgen_forms", page_token, fields="id,name,status")


async def form_leads(form_id: str, page_token: str, limit: int = 100) -> list[dict]:
    return await paged(f"{form_id}/leads", page_token, limit=limit, fields=LEAD_FIELDS)


# --- webhook -----------------------------------------------------------------

def valid_signature(body: bytes, header: str | None) -> bool:
    """`X-Hub-Signature-256: sha256=<hmac do corpo cru com o App Secret>`."""
    if not APP_SECRET or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(APP_SECRET.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[7:])
