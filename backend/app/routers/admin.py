"""Area de admin: o que nao faz parte do rastreio do dia a dia.

Prospeccao no mapa (Apify), CRM, abordagem ativa, Cloud API e os destinos extras
(Google Ads, webhook generico) continuam inteiros — mas atras de login. A tela
principal fica com o que o cliente usa: conectar a Evolution, pixel + token e as
regras de palavra-chave.

O token e um HMAC assinado com validade — nao ha sessao guardada no servidor, e
roubar o token nao da mais tempo do que a validade dele.

Credenciais e chave de assinatura vem do ambiente (`ADMIN_USER`, `ADMIN_PASSWORD`,
`ADMIN_SECRET`). Os defaults existem para a instalacao local subir sem configurar
nada; em producao, troque a senha e defina ADMIN_SECRET.
"""

import base64
import hashlib
import hmac
import logging
import os
import secrets
import time

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin", tags=["admin"])

DEFAULT_PASSWORD = "gabriel123"

ADMIN_USER = os.getenv("ADMIN_USER", "gabriel")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", DEFAULT_PASSWORD)
TTL_SECONDS = int(os.getenv("ADMIN_SESSION_HOURS", "12")) * 3600

# Chave que assina o token de sessao. NUNCA derivada da senha: rotacionar senha e
# rotacionar chave sao problemas separados, e sha256 de "usuario:senha" tem a
# entropia da senha, nao de uma chave. Sem ADMIN_SECRET, e aleatoria por processo —
# fecha o buraco por padrao, ao custo de a sessao cair no restart (e de o token de
# um worker nao valer no outro, se algum dia isso rodar com --workers).
_SECRET = (os.getenv("ADMIN_SECRET") or "").encode() or secrets.token_bytes(32)

if ADMIN_PASSWORD == DEFAULT_PASSWORD:
    log.warning(
        "Area de admin com a SENHA PADRAO (%s). Defina ADMIN_PASSWORD no .env antes de "
        "expor esta instalacao na internet — a senha padrao esta no README.",
        DEFAULT_PASSWORD,
    )
if not os.getenv("ADMIN_SECRET"):
    log.info("ADMIN_SECRET nao definido: a sessao de admin cai a cada restart do backend.")


def _sign(data: str) -> str:
    return hmac.new(_SECRET, data.encode(), hashlib.sha256).hexdigest()


def issue_token(user: str) -> tuple[str, int]:
    expires = int(time.time()) + TTL_SECONDS
    body = f"{user}:{expires}"
    raw = f"{body}:{_sign(body)}".encode()
    return base64.urlsafe_b64encode(raw).decode(), expires


def check_token(token: str | None) -> str | None:
    """Usuario do token, ou None se invalido/expirado."""
    if not token:
        return None
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        user, expires, signature = raw.rsplit(":", 2)
    except (ValueError, UnicodeDecodeError, base64.binascii.Error):
        return None
    if not hmac.compare_digest(_sign(f"{user}:{expires}"), signature):
        return None
    try:
        if int(expires) < int(time.time()):
            return None
    except ValueError:
        return None
    return user


async def require_admin(x_admin_token: str | None = Header(default=None)) -> str:
    """Dependencia das rotas escondidas. 401 = precisa logar de novo."""
    user = check_token(x_admin_token)
    if user is None:
        raise HTTPException(status_code=401, detail="Área restrita: faça login como administrador.")
    return user


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(payload: LoginIn):
    # bytes em vez de str: compare_digest recusa str com caractere fora do ASCII
    ok_user = hmac.compare_digest(payload.username.strip().encode(), ADMIN_USER.encode())
    ok_pass = hmac.compare_digest(payload.password.encode(), ADMIN_PASSWORD.encode())
    if not (ok_user and ok_pass):
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")
    token, expires = issue_token(ADMIN_USER)
    return {"token": token, "expires_at": expires, "user": ADMIN_USER}


@router.get("/session")
async def session_info(user: str = Depends(require_admin)):
    return {"user": user, "ok": True}
