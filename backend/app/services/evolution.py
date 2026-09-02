"""Cliente da Evolution API — o canal de WhatsApp desta plataforma.

Por que Evolution e nao Cloud API: o rastreio de Click to WhatsApp precisa ver a
mensagem crua. A Evolution entrega o payload do Baileys inteiro, e e nele que vem
o `contextInfo.externalAdReply` com o **ctwaClid** — o identificador que amarra a
conversa ao anuncio. De quebra nao ha template obrigatorio nem janela de 24h para
o atendente responder, o que e exatamente o que a regra de palavra-chave precisa.

Compatibilidade v1/v2: a Evolution mudou o formato de algumas rotas entre as duas
versoes maiores. Em vez de pedir a versao na configuracao (que envelhece e o
usuario erra), cada chamada tenta o formato v2 e, se o servidor recusar por
formato, repete no formato v1. Uma chamada, dois dialetos.
"""

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

# Eventos que o webhook precisa. Menos que isso perde rastreio; mais que isso e
# trafego que a gente descarta na entrada.
WEBHOOK_EVENTS = (
    "MESSAGES_UPSERT",    # mensagem recebida (traz o externalAdReply/ctwaClid)
    "SEND_MESSAGE",       # mensagem enviada pela API
    "MESSAGES_UPDATE",    # status de entrega
    "CONNECTION_UPDATE",  # conectou/caiu — mantem o estado da linha correto
)

TIMEOUT = 25


class EvolutionError(Exception):
    pass


def _base(cfg: dict) -> str:
    url = (cfg.get("evo_base_url") or "").strip().rstrip("/")
    if not url:
        raise EvolutionError("URL da Evolution API nao configurada nesta linha.")
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    return url


def _headers(cfg: dict) -> dict:
    key = (cfg.get("evo_api_key") or "").strip()
    if not key:
        raise EvolutionError("apikey da Evolution API nao configurada nesta linha.")
    return {"apikey": key, "Content-Type": "application/json"}


def _instance(cfg: dict) -> str:
    name = (cfg.get("evo_instance") or "").strip()
    if not name:
        raise EvolutionError("Nome da instancia da Evolution API nao configurado nesta linha.")
    return name


def _unwrap(resp: httpx.Response) -> Any:
    """Corpo da resposta, ou EvolutionError com a mensagem que o servidor deu."""
    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text[:2000]}
        # HTML com 200 nao e a Evolution respondendo: e um servidor qualquer no
        # endereco configurado. O caso comum e apontar evo_base_url pra esta
        # propria app — o fallback de SPA do nginx devolve index.html em qualquer
        # caminho, e sem este aviso o erro reaparece la na frente como "faltou o
        # QR", culpando a Evolution por um endereco errado.
        if resp.status_code < 400 and "html" in resp.headers.get("content-type", "").lower():
            raise EvolutionError(
                f"{resp.url} respondeu uma pagina HTML, nao a API da Evolution. "
                "Confira a URL da Evolution API nesta linha — ela deve apontar pro "
                "servidor da Evolution, nao pra esta aplicacao (essa URL vai no "
                "PUBLIC_BASE_URL)."
            )

    if resp.status_code >= 400:
        raise EvolutionError(f"HTTP {resp.status_code}: {_error_text(body)}")
    return body


def _error_text(body: Any) -> str:
    """A Evolution aninha o motivo em lugares diferentes conforme a versao."""
    if isinstance(body, dict):
        response = body.get("response")
        if isinstance(response, dict):
            message = response.get("message")
            if isinstance(message, list):
                return "; ".join(str(m) for m in message)
            if message:
                return str(message)
        for key in ("message", "error", "raw"):
            if body.get(key):
                value = body[key]
                return "; ".join(str(v) for v in value) if isinstance(value, list) else str(value)
    return str(body)[:400]


async def _request(cfg: dict, method: str, path: str, **kwargs) -> Any:
    url = f"{_base(cfg)}{path}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.request(method, url, headers=_headers(cfg), **kwargs)
    except httpx.HTTPError as exc:
        # ConnectError/timeout costumam vir com str() vazia — sem o nome da classe
        # a tela mostraria "erro:" e nada mais.
        detail = str(exc) or type(exc).__name__
        raise EvolutionError(f"Nao consegui falar com a Evolution API em {url}: {detail}") from exc
    return _unwrap(resp)


async def _post_either(cfg: dict, path: str, v2_body: dict, v1_body: dict) -> Any:
    """POST no formato v2; se o servidor recusar o FORMATO, repete no v1.

    So o 400 (payload invalido) justifica a segunda tentativa: 401 e 404 sao
    apikey errada e instancia inexistente, e insistir neles esconderia o motivo.

    Mas nem todo 400 e recusa de formato: "numero nao existe no WhatsApp" e
    "Text is required" tambem sao 400, e nesses o v1 e tentado em vao. Como o
    corpo v1 nao tem `text` no topo, a v2 do servidor responde `instance requires
    property "text"` — um erro de schema que substituia o motivo verdadeiro na
    tela. Por isso o erro do v2 e o que sobe quando as duas tentativas falham.
    """
    try:
        return await _request(cfg, "POST", path, json=v2_body)
    except EvolutionError as exc:
        if "HTTP 400" not in str(exc):
            raise
        log.info("evolution: %s recusou o formato v2, tentando v1", path)
        try:
            return await _request(cfg, "POST", path, json=v1_body)
        except EvolutionError:
            raise exc from None


# ---------------------------------------------------------------------------
# instancia
# ---------------------------------------------------------------------------


async def connection_state(cfg: dict) -> dict:
    """`{"state": "open"|"connecting"|"close"}` — se `open`, a linha esta pareada."""
    body = await _request(cfg, "GET", f"/instance/connectionState/{_instance(cfg)}")
    inner = body.get("instance") if isinstance(body, dict) else None
    state = (inner or {}).get("state") if isinstance(inner, dict) else None
    return {"state": state or (body.get("state") if isinstance(body, dict) else None), "raw": body}


async def fetch_instance(cfg: dict) -> dict:
    """Dados da instancia (numero pareado, nome do perfil, status).

    v2 devolve uma lista de objetos planos; v1, uma lista de `{instance: {...}}`.
    """
    name = _instance(cfg)
    body = await _request(cfg, "GET", "/instance/fetchInstances", params={"instanceName": name})
    rows = body if isinstance(body, list) else [body]

    for row in rows:
        if not isinstance(row, dict):
            continue
        flat = row.get("instance") if isinstance(row.get("instance"), dict) else row
        found = flat.get("name") or flat.get("instanceName")
        if found and str(found) != name:
            continue  # servidor ignorou o filtro e devolveu todas
        return {
            "name": found or name,
            "state": flat.get("connectionStatus") or flat.get("state") or flat.get("status"),
            "owner_jid": flat.get("ownerJid") or flat.get("owner"),
            "profile_name": flat.get("profileName") or flat.get("profileStatus"),
            "raw": flat,
        }
    raise EvolutionError(
        f"A instancia '{name}' nao existe nessa Evolution API. Confira o nome exato em /instance/fetchInstances."
    )


async def connect(cfg: dict) -> dict:
    """QR code / codigo de pareamento para conectar a linha."""
    body = await _request(cfg, "GET", f"/instance/connect/{_instance(cfg)}")
    if not isinstance(body, dict):
        return {"raw": body}
    return {
        "base64": body.get("base64"),          # imagem do QR (data URI)
        "code": body.get("code"),              # conteudo do QR
        "pairing_code": body.get("pairingCode"),
        "state": (body.get("instance") or {}).get("state") if isinstance(body.get("instance"), dict) else None,
        "raw": body,
    }


async def logout(cfg: dict) -> Any:
    return await _request(cfg, "DELETE", f"/instance/logout/{_instance(cfg)}")


# ---------------------------------------------------------------------------
# webhook
# ---------------------------------------------------------------------------


async def set_webhook(cfg: dict, url: str, events: tuple[str, ...] = WEBHOOK_EVENTS) -> Any:
    """Aponta o webhook da instancia para a nossa URL."""
    instance = _instance(cfg)
    return await _post_either(
        cfg,
        f"/webhook/set/{instance}",
        {
            "webhook": {
                "enabled": True,
                "url": url,
                "byEvents": False,   # todos os eventos na mesma URL
                "base64": False,     # nao queremos midia em base64 no payload
                "events": list(events),
            }
        },
        {"url": url, "enabled": True, "webhook_by_events": False, "webhook_base64": False, "events": list(events)},
    )


async def find_webhook(cfg: dict) -> Any:
    return await _request(cfg, "GET", f"/webhook/find/{_instance(cfg)}")


# ---------------------------------------------------------------------------
# contatos e conversas da instancia (alimentam o CRM da linha)
# ---------------------------------------------------------------------------


async def _post_or_get(cfg: dict, path: str, body: dict) -> Any:
    """POST com corpo; se a rota nao aceitar POST, repete como GET.

    As rotas de /chat mudaram de verbo entre versoes da Evolution. 404/405 e
    "verbo errado"; 400 e corpo errado e nao se resolve trocando de verbo.
    """
    try:
        return await _request(cfg, "POST", path, json=body)
    except EvolutionError as exc:
        if not any(code in str(exc) for code in ("HTTP 404", "HTTP 405")):
            raise
        log.info("evolution: %s nao aceita POST, tentando GET", path)
        return await _request(cfg, "GET", path)


def _rows(body: Any) -> list[dict]:
    """Lista de registros, seja a resposta uma lista crua ou paginada.

    v2 pagina em `{"records": [...], "total": n}`; versoes antigas devolvem a
    lista direto; algumas aninham em `messages`/`chats`.
    """
    if isinstance(body, list):
        return [r for r in body if isinstance(r, dict)]
    if isinstance(body, dict):
        for key in ("records", "messages", "chats", "contacts", "data"):
            inner = body.get(key)
            if isinstance(inner, list):
                return [r for r in inner if isinstance(r, dict)]
            if isinstance(inner, dict):
                return _rows(inner)
    return []


def jid_of(row: dict) -> str | None:
    """JID do contato/conversa. O nome do campo varia: `remoteJid`, `id`, `jid`."""
    for key in ("remoteJid", "remote_jid", "jid", "id", "owner"):
        value = row.get(key)
        if isinstance(value, str) and "@" in value:
            return value
    key = row.get("key")
    if isinstance(key, dict):
        return jid_of(key)
    return None


async def find_contacts(cfg: dict) -> list[dict]:
    """Agenda da instancia. `where: {}` = todos."""
    body = await _post_or_get(cfg, f"/chat/findContacts/{_instance(cfg)}", {"where": {}})
    return _rows(body)


async def find_chats(cfg: dict) -> list[dict]:
    """Conversas da instancia, com a ultima mensagem e o nao-lido de cada uma."""
    body = await _post_or_get(cfg, f"/chat/findChats/{_instance(cfg)}", {})
    return _rows(body)


async def find_messages(cfg: dict, remote_jid: str, limit: int = 60) -> list[dict]:
    """Historico de UMA conversa — buscado sob demanda, quando a tela abre o chat."""
    body = await _post_or_get(
        cfg,
        f"/chat/findMessages/{_instance(cfg)}",
        {"where": {"key": {"remoteJid": remote_jid}}, "limit": limit, "page": 1, "offset": limit},
    )
    return _rows(body)


async def profile_picture(cfg: dict, number: str) -> str | None:
    try:
        body = await _request(
            cfg, "POST", f"/chat/fetchProfilePictureUrl/{_instance(cfg)}", json={"number": number}
        )
    except EvolutionError:
        return None  # foto e enfeite: falha aqui nao pode derrubar o sync
    if isinstance(body, dict):
        url = body.get("profilePictureUrl") or body.get("url")
        return str(url) if url else None
    return None


# ---------------------------------------------------------------------------
# envio
# ---------------------------------------------------------------------------


def build_text_payload(to: str, text: str) -> dict:
    """Payload de texto no formato v2 (o `_post_either` cobre o v1)."""
    return {"number": to, "text": text}


async def send_message(cfg: dict, payload: dict) -> tuple[int, dict]:
    """Envia o payload montado por `build_text_payload`. Devolve (status, corpo)."""
    number = payload.get("number") or ""
    text = payload.get("text") or ""
    body = await _post_either(
        cfg,
        f"/message/sendText/{_instance(cfg)}",
        {"number": number, "text": text},
        {"number": number, "textMessage": {"text": text}},
    )
    return 200, body if isinstance(body, dict) else {"data": body}


async def send_text(cfg: dict, to: str, text: str) -> dict:
    _, body = await send_message(cfg, build_text_payload(to, text))
    return body


def first_message_id(body: dict) -> str | None:
    """Id da mensagem enviada — a Evolution devolve no `key.id`."""
    if not isinstance(body, dict):
        return None
    key = body.get("key")
    if isinstance(key, dict) and key.get("id"):
        return str(key["id"])
    data = body.get("data")
    if isinstance(data, dict):
        return first_message_id(data)
    return None
