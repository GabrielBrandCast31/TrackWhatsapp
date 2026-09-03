"""Autenticacao da plataforma: usuario no banco + JWT.

Antes daqui, so a area de admin era protegida, por um token HMAC caseiro, e o
resto do painel ficava aberto pra quem soubesse a URL. Numa VPS isso e a base
inteira exposta. Agora **todo** /api exige um JWT valido; publicos continuam so
o /api/health e os /webhook/* (que a Evolution e a Meta chamam sem passar por
login, e que se autenticam pelo token na URL / assinatura do payload).

Como funciona:

* senha nunca e guardada — vai pro banco como PBKDF2-SHA256 com salt por usuario
  (`pbkdf2_sha256$<iteracoes>$<salt>$<hash>`), verificada em tempo constante;
* o login devolve dois tokens: um **access** curto (o que vai no
  `Authorization: Bearer`) e um **refresh** longo, que so serve pra pegar outro
  access sem pedir a senha de novo;
* o access carrega `role` e `pv` (password version). Trocar a senha muda o `pv`
  e derruba na hora todo token emitido antes — inclusive o de quem roubou.

`JWT_SECRET` assina tudo. Sem ele, o processo sorteia uma chave: seguro, mas as
sessoes caem a cada restart (e nao valem entre workers). Em producao, defina.
"""

import base64
import hashlib
import hmac
import logging
import os
import secrets
import time
from datetime import datetime, timezone

import jwt
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User

log = logging.getLogger(__name__)

ALGORITHM = "HS256"
ACCESS_TTL = int(os.getenv("JWT_ACCESS_MINUTES", "60")) * 60
REFRESH_TTL = int(os.getenv("JWT_REFRESH_DAYS", "7")) * 86400

DEFAULT_PASSWORD = "gabriel123"
BOOTSTRAP_USER = os.getenv("ADMIN_USER", "gabriel")
BOOTSTRAP_PASSWORD = os.getenv("ADMIN_PASSWORD", DEFAULT_PASSWORD)

# ADMIN_SECRET e aceito como fallback pra nao quebrar quem ja tinha .env pronto.
_SECRET = os.getenv("JWT_SECRET") or os.getenv("ADMIN_SECRET") or ""
if not _SECRET:
    _SECRET = secrets.token_urlsafe(48)
    log.warning(
        "JWT_SECRET nao definido: chave sorteada neste processo. Todo mundo cai do login "
        "a cada restart do backend. Gere uma com: "
        'python3 -c "import secrets; print(secrets.token_urlsafe(48))"'
    )

PBKDF2_ROUNDS = 210_000


# --- senha -------------------------------------------------------------------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ROUNDS,
        base64.b64encode(salt).decode(),
        base64.b64encode(digest).decode(),
    )


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, rounds, salt_b64, hash_b64 = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), base64.b64decode(salt_b64), int(rounds)
        )
    except (ValueError, base64.binascii.Error):
        return False
    return hmac.compare_digest(digest, base64.b64decode(hash_b64))


def password_version(password_hash: str) -> str:
    """Marca curta do hash atual: muda junto com a senha e derruba os tokens velhos."""
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def password_problem(password: str) -> str | None:
    """Politica minima. Vale pra cadastro e pra troca de senha."""
    if len(password) < 8:
        return "A senha precisa de pelo menos 8 caracteres."
    if password.strip() != password:
        return "A senha nao pode comecar nem terminar com espaco."
    return None


# --- token -------------------------------------------------------------------

def _encode(user: User, kind: str, ttl: int) -> str:
    now = int(time.time())
    payload = {
        "sub": str(user.id),
        "usr": user.username,
        "role": user.role,
        "pv": password_version(user.password_hash),
        "typ": kind,
        "iat": now,
        "exp": now + ttl,
        "jti": secrets.token_urlsafe(8),
    }
    return jwt.encode(payload, _SECRET, algorithm=ALGORITHM)


def issue_tokens(user: User) -> dict:
    return {
        "access_token": _encode(user, "access", ACCESS_TTL),
        "refresh_token": _encode(user, "refresh", REFRESH_TTL),
        "token_type": "bearer",
        "expires_in": ACCESS_TTL,
    }


def decode_token(token: str, kind: str = "access") -> dict | None:
    """Claims do token, ou None se invalido/expirado/do tipo errado."""
    try:
        claims = jwt.decode(token, _SECRET, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    return claims if claims.get("typ") == kind else None


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def bearer_token(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


async def load_user(session: AsyncSession, claims: dict) -> User:
    """Usuario do token, revalidado contra o banco a cada requisicao.

    O JWT sozinho nao basta: desativar ou apagar alguem tem que valer agora, nao
    quando o token expirar.
    """
    try:
        user_id = int(claims.get("sub", ""))
    except ValueError:
        raise _unauthorized("Sessão inválida. Faça login de novo.")
    user = await session.get(User, user_id)
    if user is None or not user.active:
        raise _unauthorized("Usuário sem acesso. Faça login de novo.")
    if claims.get("pv") != password_version(user.password_hash):
        raise _unauthorized("A senha mudou. Faça login de novo.")
    return user


async def require_user(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> User:
    """Dependencia padrao: qualquer rota de API exige um usuario logado."""
    token = bearer_token(authorization)
    if not token:
        raise _unauthorized("Faça login para usar o painel.")
    claims = decode_token(token)
    if claims is None:
        raise _unauthorized("Sessão expirada. Faça login de novo.")
    return await load_user(session, claims)


async def require_admin(user: User = Depends(require_user)) -> User:
    """Rotas da area de admin: prospeccao, CRM global, Cloud API, destinos, usuarios."""
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Área restrita a administradores.")
    return user


# --- bootstrap ---------------------------------------------------------------

async def ensure_bootstrap_user(session: AsyncSession) -> None:
    """Base sem nenhum usuario ganha o admin do .env — senao ninguem entra."""
    total = (await session.execute(select(func.count(User.id)))).scalar_one()
    if total:
        return
    user = User(
        username=BOOTSTRAP_USER.strip().lower(),
        name=BOOTSTRAP_USER,
        password_hash=hash_password(BOOTSTRAP_PASSWORD),
        role="admin",
    )
    session.add(user)
    await session.commit()
    log.warning(
        "Primeiro acesso: usuario admin '%s' criado com a senha de ADMIN_PASSWORD. "
        "Troque a senha no painel (Admin -> Usuarios) assim que entrar.",
        user.username,
    )
    if BOOTSTRAP_PASSWORD == DEFAULT_PASSWORD:
        log.warning(
            "A senha usada e a PADRAO do repositorio (%s) — publica no README. "
            "Defina ADMIN_PASSWORD no .env antes de expor esta instalacao na internet.",
            DEFAULT_PASSWORD,
        )


# --- forca bruta -------------------------------------------------------------
# Login exposto na internet leva teste de senha em massa. Uma janela por IP+usuario
# na memoria do processo ja corta o volume; nao pretende ser WAF.

_FAILS: dict[str, list[float]] = {}
MAX_FAILS = int(os.getenv("LOGIN_MAX_FAILS", "8"))
FAIL_WINDOW = int(os.getenv("LOGIN_FAIL_WINDOW_SECONDS", "300"))


def _key(request: Request, username: str) -> str:
    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if not ip:
        ip = request.client.host if request.client else "?"
    return f"{ip}|{username.strip().lower()}"


def throttle_check(request: Request, username: str) -> None:
    now = time.time()
    tries = [t for t in _FAILS.get(_key(request, username), []) if now - t < FAIL_WINDOW]
    _FAILS[_key(request, username)] = tries
    if len(tries) >= MAX_FAILS:
        wait = int(FAIL_WINDOW - (now - tries[0])) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Muitas tentativas. Tente de novo em {wait}s.",
        )


def throttle_fail(request: Request, username: str) -> None:
    _FAILS.setdefault(_key(request, username), []).append(time.time())
    if len(_FAILS) > 2000:  # varredura de IPs nao pode virar vazamento de memoria
        now = time.time()
        for key, tries in list(_FAILS.items()):
            if all(now - t >= FAIL_WINDOW for t in tries):
                _FAILS.pop(key, None)


def throttle_reset(request: Request, username: str) -> None:
    _FAILS.pop(_key(request, username), None)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
