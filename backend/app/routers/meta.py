"""Conexao com o Facebook por OAuth: por linha, para vincular conta e para login.

Tres usos do mesmo dialogo do Facebook, separados pelo `state`:

* `connect` — uma linha (cliente) conecta a conta do Facebook. Depois a pessoa
  escolhe conta de anuncios, Pixel e Pagina; Pixel e token viram `overrides` da
  linha (o mesmo lugar que os campos colados a mao em Rastreamento) e a Pagina
  e inscrita no webhook `leadgen` (Lead Ads -> CRM, veja app.meta_leads);
* `link` — o usuario logado vincula o proprio Facebook ao usuario do painel;
* `login` — "Entrar com Facebook". So entra quem vinculou antes: o login nunca
  cria conta nem descobre usuario por e-mail.

O `state` e um JWT curto assinado (app.auth.sign): carrega o proposito, a linha
e quem pediu, e e o que impede CSRF no callback — sem ele valido, nada acontece.

O callback e um GET do navegador vindo do Facebook, sem o nosso Bearer; por isso
fica no router publico e confere tudo pelo `state`. Ele termina num redirect pro
painel com o resultado no fragmento (`#meta=...`), que nao vai pra log de servidor.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import access, auth, meta_leads
from app.db import SessionLocal, get_session
from app.models import MetaConnection, MetaLead, User, WaNumber
from app.routers.auth import serialize as serialize_user
from app.services import meta_oauth
from app.services.meta_oauth import MetaError

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/meta", tags=["meta"])
public_router = APIRouter(tags=["meta"])

STATE_TTL = 600        # tempo pra pessoa autorizar no Facebook
LOGIN_TTL = 60         # o token do fragmento so serve pra ser trocado na hora
_used_logins: dict[str, float] = {}   # jti -> exp: token de login vale UMA troca
_tasks: set[asyncio.Task] = set()     # referencia forte: task solta pode ser coletada no meio


def _require_configured() -> None:
    if not meta_oauth.configured():
        raise HTTPException(
            status_code=503,
            detail="App da Meta não configurado: defina META_APP_ID e META_APP_SECRET no .env do backend.",
        )


def _redirect(**fragment: str) -> RedirectResponse:
    frag = "&".join(f"{k}={quote(str(v))}" for k, v in fragment.items())
    return RedirectResponse(f"{meta_oauth.FRONTEND_URL}/#{frag}", status_code=302)


def _expired(conn: MetaConnection) -> bool:
    exp = conn.expires_at
    if exp is None:
        return False
    if exp.tzinfo is None:  # SQLite devolve sem fuso
        exp = exp.replace(tzinfo=timezone.utc)
    return exp <= datetime.now(timezone.utc)


def serialize(conn: MetaConnection | None, leads: int = 0) -> dict | None:
    if conn is None:
        return None
    return {
        "fb_user_id": conn.fb_user_id,
        "fb_user_name": conn.fb_user_name,
        "expires_at": conn.expires_at,
        "expired": _expired(conn),
        "scopes": conn.scopes or [],
        "missing_scopes": [s for s in meta_oauth.CONNECT_SCOPES if s not in (conn.scopes or [])],
        "ad_account_id": conn.ad_account_id,
        "ad_account_name": conn.ad_account_name,
        "pixel_id": conn.pixel_id,
        "pixel_name": conn.pixel_name,
        "page_id": conn.page_id,
        "page_name": conn.page_name,
        "leads_subscribed": conn.leads_subscribed,
        "last_error": conn.last_error,
        "leads": leads,
        "updated_at": conn.updated_at,
    }


async def _line(session: AsyncSession, number_id: int) -> WaNumber:
    number = await session.get(WaNumber, number_id)
    if number is None or not access.can_see(number.id):
        raise HTTPException(status_code=404, detail="Linha não encontrada.")
    return number


async def _conn(session: AsyncSession, number_id: int) -> MetaConnection | None:
    stmt = select(MetaConnection).where(MetaConnection.wa_number_id == number_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def _require_conn(session: AsyncSession, number_id: int) -> MetaConnection:
    conn = await _conn(session, number_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Esta linha ainda não conectou o Facebook.")
    if _expired(conn):
        raise HTTPException(status_code=400, detail="O acesso ao Facebook expirou. Conecte de novo.")
    return conn


def _meta_error(exc: MetaError) -> HTTPException:
    return HTTPException(status_code=502, detail=f"Meta: {exc}")


# --- tokens da conexao nos overrides da linha ----------------------------------
# A conexao preenche Pixel e token como se tivessem sido colados em Rastreamento.
# So substitui token que estiver vazio ou que tenha vindo da propria conexao: um
# token de usuario do sistema colado a mao (que nao expira) tem precedencia.

_TOKEN_KEYS = ("meta_ads_token", "meta_capi_token")


def _swap_tokens(number: WaNumber, old: str | None, new: str | None, keys=_TOKEN_KEYS) -> list[str]:
    overrides = dict(number.overrides or {})
    changed = []
    for key in keys:
        current = overrides.get(key) or ""
        if new is None:
            if old and current == old:
                overrides.pop(key, None)
                changed.append(key)
        elif not current or current == old:
            overrides[key] = new
            changed.append(key)
    if overrides.get("meta_dataset_id") and overrides.get("meta_capi_token"):
        overrides["meta_capi_enabled"] = True
    number.overrides = overrides
    return changed


# --- painel: status e inicio do OAuth -----------------------------------------

@router.get("/status")
async def status():
    return {
        "configured": meta_oauth.configured(),
        "redirect_uri": meta_oauth.REDIRECT_URI,
        "webhook_url": f"{meta_oauth.PUBLIC_BASE_URL}/webhook/meta",
        "webhook_ready": bool(meta_oauth.WEBHOOK_VERIFY_TOKEN),
        "scopes": list(meta_oauth.CONNECT_SCOPES),
    }


class StartIn(BaseModel):
    purpose: str            # connect | link
    number_id: int | None = None
    rerequest: bool = False


@router.post("/oauth/start")
async def start(
    payload: StartIn,
    user: User = Depends(auth.require_user),
    session: AsyncSession = Depends(get_session),
):
    _require_configured()
    if payload.purpose not in ("connect", "link"):
        raise HTTPException(status_code=400, detail="Propósito inválido.")
    claims = {"p": payload.purpose, "sub": str(user.id), "pv": auth.password_version(user.password_hash)}
    if payload.purpose == "connect":
        if payload.number_id is None:
            raise HTTPException(status_code=400, detail="Escolha a linha a conectar.")
        await _line(session, payload.number_id)
        claims["n"] = payload.number_id
    state = auth.sign(claims, "fb_state", STATE_TTL)
    return {"url": meta_oauth.dialog_url(state, connect=payload.purpose == "connect", rerequest=payload.rerequest)}


@router.delete("/link")
async def unlink(user: User = Depends(auth.require_user), session: AsyncSession = Depends(get_session)):
    fresh = await session.get(User, user.id)
    fresh.facebook_id = None
    await session.commit()
    return serialize_user(fresh)


# --- painel: conexao da linha ---------------------------------------------------

async def _lead_count(session: AsyncSession, number_id: int) -> int:
    stmt = select(func.count(MetaLead.id)).where(MetaLead.wa_number_id == number_id)
    return (await session.execute(stmt)).scalar_one()


@router.get("/lines/{number_id}")
async def line_status(number_id: int, session: AsyncSession = Depends(get_session)):
    await _line(session, number_id)
    conn = await _conn(session, number_id)
    return {"connection": serialize(conn, await _lead_count(session, number_id) if conn else 0)}


@router.get("/lines/{number_id}/assets")
async def assets(number_id: int, session: AsyncSession = Depends(get_session)):
    """Contas de anuncios e Paginas que a conta conectada enxerga."""
    await _line(session, number_id)
    conn = await _require_conn(session, number_id)
    try:
        accounts = await meta_oauth.ad_accounts(conn.access_token)
        page_rows = await meta_oauth.pages(conn.access_token)
    except MetaError as exc:
        raise _meta_error(exc)
    return {
        "ad_accounts": accounts,
        # o token de cada Pagina fica no backend
        "pages": [{"id": p["id"], "name": p["name"], "tasks": p["tasks"]} for p in page_rows],
    }


@router.get("/lines/{number_id}/pixels")
async def list_pixels(
    number_id: int, ad_account_id: str = Query(...), session: AsyncSession = Depends(get_session)
):
    await _line(session, number_id)
    conn = await _require_conn(session, number_id)
    try:
        return {"pixels": await meta_oauth.pixels(conn.access_token, ad_account_id)}
    except MetaError as exc:
        raise _meta_error(exc)


class SelectIn(BaseModel):
    ad_account_id: str | None = None
    pixel_id: str | None = None
    page_id: str | None = None


@router.post("/lines/{number_id}/select")
async def select_assets(number_id: int, payload: SelectIn, session: AsyncSession = Depends(get_session)):
    """Grava o que foi escolhido. Campo ausente/vazio nao mexe no que estava."""
    number = await _line(session, number_id)
    conn = await _require_conn(session, number_id)
    token = conn.access_token
    applied: list[str] = []

    try:
        if payload.ad_account_id:
            accounts = {a["id"]: a for a in await meta_oauth.ad_accounts(token)}
            account = accounts.get(payload.ad_account_id)
            if account is None:
                raise HTTPException(status_code=400, detail="Conta de anúncios fora do alcance desta conexão.")
            conn.ad_account_id, conn.ad_account_name = account["id"], account["name"]
            applied += _swap_tokens(number, None, token, keys=("meta_ads_token",))

        if payload.pixel_id:
            if not conn.ad_account_id:
                raise HTTPException(status_code=400, detail="Escolha a conta de anúncios antes do Pixel.")
            found = {p["id"]: p for p in await meta_oauth.pixels(token, conn.ad_account_id)}
            pixel = found.get(payload.pixel_id)
            if pixel is None:
                raise HTTPException(status_code=400, detail="Pixel não pertence à conta de anúncios escolhida.")
            conn.pixel_id, conn.pixel_name = pixel["id"], pixel["name"]
            overrides = dict(number.overrides or {})
            overrides["meta_dataset_id"] = pixel["id"]
            number.overrides = overrides
            applied.append("meta_dataset_id")
            applied += _swap_tokens(number, None, token, keys=("meta_capi_token",))

        if payload.page_id and payload.page_id != conn.page_id:
            page = next((p for p in await meta_oauth.pages(token) if p["id"] == payload.page_id), None)
            if page is None or not page.get("access_token"):
                raise HTTPException(status_code=400, detail="Página fora do alcance desta conexão.")
            await _release_page(session, conn)
            conn.page_id, conn.page_name, conn.page_token = page["id"], page["name"], page["access_token"]
            conn.leads_subscribed = False
            try:
                await meta_oauth.subscribe_leadgen(page["id"], page["access_token"])
                conn.leads_subscribed = True
                conn.last_error = None
            except MetaError as exc:
                # a Pagina fica escolhida: "Importar leads" funciona mesmo sem webhook
                conn.last_error = f"Inscrição no webhook de leads falhou: {exc}"
    except MetaError as exc:
        raise _meta_error(exc)

    await session.commit()
    return {"connection": serialize(conn, await _lead_count(session, number_id)), "applied": applied}


async def _release_page(session: AsyncSession, conn: MetaConnection) -> None:
    """Tira a inscricao do app da Pagina antiga, se nenhuma outra linha usa ela."""
    if not conn.page_id or not conn.page_token or not conn.leads_subscribed:
        return
    others = (
        await session.execute(
            select(func.count(MetaConnection.id)).where(
                MetaConnection.page_id == conn.page_id, MetaConnection.id != conn.id
            )
        )
    ).scalar_one()
    if others:
        return
    try:
        await meta_oauth.unsubscribe(conn.page_id, conn.page_token)
    except MetaError as exc:
        log.info("nao consegui desinscrever a pagina %s: %s", conn.page_id, exc)


@router.delete("/lines/{number_id}")
async def disconnect(number_id: int, session: AsyncSession = Depends(get_session)):
    number = await _line(session, number_id)
    conn = await _conn(session, number_id)
    if conn is None:
        return {"connection": None}
    await _release_page(session, conn)
    _swap_tokens(number, conn.access_token, None)
    await session.delete(conn)
    await session.commit()
    return {"connection": None}


@router.post("/lines/{number_id}/leads/sync")
async def sync_leads(number_id: int, session: AsyncSession = Depends(get_session)):
    await _line(session, number_id)
    conn = await _require_conn(session, number_id)
    try:
        return await meta_leads.sync(session, conn)
    except MetaError as exc:
        raise _meta_error(exc)


@router.get("/lines/{number_id}/leads")
async def list_leads(
    number_id: int, limit: int = Query(default=50, le=200), session: AsyncSession = Depends(get_session)
):
    await _line(session, number_id)
    rows = (
        await session.execute(
            select(MetaLead)
            .where(MetaLead.wa_number_id == number_id)
            .order_by(MetaLead.lead_created_at.desc().nullslast(), MetaLead.id.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "leadgen_id": r.leadgen_id,
            "form_name": r.form_name,
            "ad_name": r.ad_name,
            "campaign_name": r.campaign_name,
            "platform": r.platform,
            "answers": r.field_data or {},
            "contact_id": r.contact_id,
            "created_at": r.lead_created_at or r.created_at,
        }
        for r in rows
    ]


# --- publico: callback do OAuth -----------------------------------------------

@public_router.get("/api/meta/oauth/callback")
async def callback(
    state: str = Query(default=""),
    code: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
):
    claims = auth.decode_token(state, kind="fb_state")
    if claims is None:
        return _redirect(meta_error="O pedido ao Facebook expirou ou é inválido. Tente de novo.")
    purpose = claims.get("p")
    # cada tela le a sua chave: login, menu da conta (vinculo) ou o card da linha
    fail_key = {"login": "fb_error", "link": "link_error"}.get(purpose, "meta_error")

    if error or not code:
        msg = "Você cancelou a autorização no Facebook." if error == "access_denied" else (
            error_description or "O Facebook não devolveu o código de autorização."
        )
        return _redirect(**{fail_key: msg})

    try:
        granted = await meta_oauth.exchange_code(code)
    except MetaError as exc:
        log.warning("oauth meta (%s): troca do code falhou: %s", purpose, exc)
        return _redirect(**{fail_key: f"Falha ao validar com o Facebook: {exc}"})

    if purpose == "login":
        return await _finish_login(session, granted)

    try:
        user = await auth.load_user(session, claims)
    except HTTPException:
        return _redirect(**{fail_key: "Sua sessão no painel caiu durante a autorização. Entre e tente de novo."})

    if purpose == "link":
        return await _finish_link(session, user, granted)
    if purpose == "connect":
        return await _finish_connect(session, user, int(claims.get("n") or 0), granted)
    return _redirect(meta_error="Propósito desconhecido.")


async def _finish_link(session: AsyncSession, user: User, granted: dict) -> RedirectResponse:
    owner = (
        await session.execute(select(User).where(User.facebook_id == granted["fb_user_id"]))
    ).scalar_one_or_none()
    if owner is not None and owner.id != user.id:
        return _redirect(link_error="Este Facebook já está vinculado a outro usuário do painel.")
    fresh = await session.get(User, user.id)
    fresh.facebook_id = granted["fb_user_id"]
    await session.commit()
    return _redirect(fb_linked=granted.get("fb_user_name") or "ok")


async def _finish_connect(session: AsyncSession, user: User, number_id: int, granted: dict) -> RedirectResponse:
    await access.load(session, user)
    number = await session.get(WaNumber, number_id)
    if number is None or not access.can_see(number.id):
        return _redirect(meta_error="Linha não encontrada ou sem acesso.")

    conn = await _conn(session, number_id)
    old_token = conn.access_token if conn else None
    if conn is None:
        conn = MetaConnection(wa_number_id=number_id)
        session.add(conn)
    elif conn.fb_user_id != granted["fb_user_id"]:
        # outra pessoa conectou: o que foi escolhido com a conta anterior nao vale
        await _release_page(session, conn)
        for field in ("ad_account_id", "ad_account_name", "pixel_id", "pixel_name",
                      "page_id", "page_name", "page_token"):
            setattr(conn, field, None)
        conn.leads_subscribed = False

    conn.fb_user_id = granted["fb_user_id"]
    conn.fb_user_name = granted["fb_user_name"]
    conn.access_token = granted["access_token"]
    conn.expires_at = granted["expires_at"]
    conn.scopes = granted["scopes"]
    conn.connected_by = user.id
    conn.last_error = None
    # reconexao: onde estava o token antigo da conexao entra o novo
    if old_token:
        _swap_tokens(number, old_token, granted["access_token"])
    await session.commit()
    return _redirect(meta="connected", number=str(number_id))


async def _finish_login(session: AsyncSession, granted: dict) -> RedirectResponse:
    user = (
        await session.execute(select(User).where(User.facebook_id == granted["fb_user_id"]))
    ).scalar_one_or_none()
    if user is None or not user.active:
        log.info("login com facebook recusado: id %s sem usuario vinculado", granted["fb_user_id"])
        return _redirect(
            fb_error="Este Facebook não está vinculado a nenhum usuário ativo. Entre com usuário e senha "
            "e vincule em Minha conta → Vincular Facebook."
        )
    token = auth.sign(
        {"sub": str(user.id), "pv": auth.password_version(user.password_hash)}, "fb_login", LOGIN_TTL
    )
    return _redirect(fb_login=token)


# --- publico: login com Facebook ----------------------------------------------

@public_router.post("/api/meta/login/start")
async def login_start():
    _require_configured()
    return {"url": meta_oauth.dialog_url(auth.sign({"p": "login"}, "fb_state", STATE_TTL), connect=False)}


class ExchangeIn(BaseModel):
    token: str


@public_router.post("/api/meta/login/exchange")
async def login_exchange(payload: ExchangeIn, session: AsyncSession = Depends(get_session)):
    """Troca o token curto do fragmento pelo par access/refresh normal do painel."""
    claims = auth.decode_token(payload.token, kind="fb_login")
    now = time.time()
    for jti, exp in list(_used_logins.items()):
        if exp < now:
            _used_logins.pop(jti, None)
    if claims is None or claims.get("jti") in _used_logins:
        raise HTTPException(status_code=401, detail="Login com Facebook expirou. Tente de novo.")
    _used_logins[claims["jti"]] = float(claims.get("exp") or now + LOGIN_TTL)
    user = await auth.load_user(session, claims)
    user.last_login_at = auth.now_utc()
    await session.commit()
    return {**auth.issue_tokens(user), "user": serialize_user(user)}


# --- publico: webhook de Lead Ads ---------------------------------------------

@public_router.get("/webhook/meta")
async def webhook_verify(
    mode: str = Query(default="", alias="hub.mode"),
    token: str = Query(default="", alias="hub.verify_token"),
    challenge: str = Query(default="", alias="hub.challenge"),
):
    """Verificacao do painel do app: devolve o challenge se o token bater."""
    if mode == "subscribe" and meta_oauth.WEBHOOK_VERIFY_TOKEN and token == meta_oauth.WEBHOOK_VERIFY_TOKEN:
        return PlainTextResponse(challenge)
    raise HTTPException(status_code=403, detail="verify token inválido")


@public_router.post("/webhook/meta")
async def webhook_receive(request: Request):
    body = await request.body()
    if not meta_oauth.valid_signature(body, request.headers.get("x-hub-signature-256")):
        raise HTTPException(status_code=401, detail="assinatura inválida")
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="JSON inválido")

    events = []
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            if change.get("field") != "leadgen":
                continue
            value = change.get("value") or {}
            page_id = str(value.get("page_id") or entry.get("id") or "")
            leadgen_id = str(value.get("leadgen_id") or "")
            if page_id and leadgen_id:
                events.append((page_id, leadgen_id))
    if events:
        # responde ja: a Meta reenvia se o 200 demora, e buscar o lead e outra chamada
        task = asyncio.create_task(_process_leads(events))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
    return {"ok": True, "leads": len(events)}


async def _process_leads(events: list[tuple[str, str]]) -> None:
    for page_id, leadgen_id in events:
        async with SessionLocal() as session:
            conns = (
                await session.execute(
                    select(MetaConnection).where(
                        MetaConnection.page_id == page_id, MetaConnection.page_token.is_not(None)
                    )
                )
            ).scalars().all()
            if not conns:
                log.info("lead %s da pagina %s sem linha conectada", leadgen_id, page_id)
            for conn in conns:
                try:
                    await meta_leads.ingest_by_id(session, conn, leadgen_id)
                except Exception as exc:  # um lead ruim nao derruba os outros
                    await session.rollback()
                    log.warning("lead %s (linha %s) nao gravado: %s", leadgen_id, conn.wa_number_id, exc)
