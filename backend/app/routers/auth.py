"""Login do painel e cadastro de usuarios.

Publico: so `POST /api/auth/login` e `POST /api/auth/refresh` (que ja exige um
refresh token valido). O resto pede sessao; o CRUD de usuarios pede admin.

O login sempre responde a mesma mensagem para usuario inexistente, senha errada
e conta desativada — dizer qual dos tres e entregar meia resposta a quem esta
testando senha.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import auth
from app.db import get_session
from app.models import User

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

INVALID = "Usuário ou senha inválidos."


def serialize(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "name": user.name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at,
        "last_login_at": user.last_login_at,
    }


class LoginIn(BaseModel):
    username: str
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


class UserIn(BaseModel):
    username: str
    password: str
    name: str | None = None
    role: str = "user"


class UserPatch(BaseModel):
    name: str | None = None
    role: str | None = None
    active: bool | None = None
    password: str | None = None


async def _by_username(session: AsyncSession, username: str) -> User | None:
    stmt = select(User).where(func.lower(User.username) == username.strip().lower())
    return (await session.execute(stmt)).scalar_one_or_none()


@router.post("/login")
async def login(payload: LoginIn, request: Request, session: AsyncSession = Depends(get_session)):
    auth.throttle_check(request, payload.username)
    user = await _by_username(session, payload.username)
    # verifica a senha mesmo sem usuario: sem isso, o tempo de resposta diz quais
    # nomes existem na base.
    ok = auth.verify_password(payload.password, user.password_hash if user else None)
    if user is None or not ok or not user.active:
        auth.throttle_fail(request, payload.username)
        log.info("login recusado para %r", payload.username.strip()[:40])
        raise HTTPException(status_code=401, detail=INVALID)

    auth.throttle_reset(request, payload.username)
    user.last_login_at = auth.now_utc()
    await session.commit()
    return {**auth.issue_tokens(user), "user": serialize(user)}


@router.post("/refresh")
async def refresh(payload: RefreshIn, session: AsyncSession = Depends(get_session)):
    claims = auth.decode_token(payload.refresh_token, kind="refresh")
    if claims is None:
        raise HTTPException(
            status_code=401, detail="Sessão expirada. Faça login de novo.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = await auth.load_user(session, claims)
    return {**auth.issue_tokens(user), "user": serialize(user)}


@router.get("/me")
async def me(user: User = Depends(auth.require_user)):
    return serialize(user)


@router.post("/password")
async def change_password(
    payload: PasswordIn,
    user: User = Depends(auth.require_user),
    session: AsyncSession = Depends(get_session),
):
    """Troca a propria senha. Derruba as outras sessoes: o `pv` do token muda."""
    if not auth.verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Senha atual incorreta.")
    problem = auth.password_problem(payload.new_password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    fresh = await session.get(User, user.id)
    fresh.password_hash = auth.hash_password(payload.new_password)
    fresh.password_changed_at = auth.now_utc()
    await session.commit()
    # tokens novos pra quem trocou continuar logado nesta aba
    return {**auth.issue_tokens(fresh), "user": serialize(fresh)}


# --- cadastro de usuarios (admin) --------------------------------------------

@router.get("/users")
async def list_users(
    _: User = Depends(auth.require_admin), session: AsyncSession = Depends(get_session)
):
    rows = (await session.execute(select(User).order_by(User.username))).scalars().all()
    return [serialize(u) for u in rows]


@router.post("/users", status_code=201)
async def create_user(
    payload: UserIn,
    _: User = Depends(auth.require_admin),
    session: AsyncSession = Depends(get_session),
):
    username = payload.username.strip().lower()
    if len(username) < 3 or len(username) > 80 or any(c.isspace() for c in username):
        raise HTTPException(
            status_code=400, detail="Usuário: de 3 a 80 caracteres, sem espaços."
        )
    if payload.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="Perfil inválido: use 'admin' ou 'user'.")
    problem = auth.password_problem(payload.password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if await _by_username(session, username):
        raise HTTPException(status_code=409, detail=f"Já existe um usuário '{username}'.")

    user = User(
        username=username,
        name=(payload.name or "").strip() or None,
        password_hash=auth.hash_password(payload.password),
        role=payload.role,
    )
    session.add(user)
    await session.commit()
    return serialize(user)


async def _admins_left(session: AsyncSession, excluding: int) -> int:
    stmt = select(func.count(User.id)).where(
        User.role == "admin", User.active.is_(True), User.id != excluding
    )
    return (await session.execute(stmt)).scalar_one()


@router.patch("/users/{user_id}")
async def patch_user(
    user_id: int,
    payload: UserPatch,
    admin: User = Depends(auth.require_admin),
    session: AsyncSession = Depends(get_session),
):
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")

    data = payload.model_dump(exclude_unset=True)
    if "role" in data and data["role"] not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="Perfil inválido: use 'admin' ou 'user'.")

    # rebaixar/desativar o ultimo admin tranca todo mundo pra fora do cadastro
    loses_admin = (data.get("role") == "user" and user.role == "admin") or data.get("active") is False
    if loses_admin and user.role == "admin" and not await _admins_left(session, user.id):
        raise HTTPException(
            status_code=400, detail="Este é o último administrador ativo — promova outro antes."
        )

    if "password" in data and data["password"]:
        problem = auth.password_problem(data["password"])
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        user.password_hash = auth.hash_password(data.pop("password"))
        user.password_changed_at = auth.now_utc()
    data.pop("password", None)

    if "name" in data:
        user.name = (data["name"] or "").strip() or None
    if "role" in data:
        user.role = data["role"]
    if "active" in data:
        user.active = bool(data["active"])

    await session.commit()
    return serialize(user)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: int,
    admin: User = Depends(auth.require_admin),
    session: AsyncSession = Depends(get_session),
):
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Você não pode apagar a própria conta.")
    if user.role == "admin" and not await _admins_left(session, user.id):
        raise HTTPException(
            status_code=400, detail="Este é o último administrador ativo — promova outro antes."
        )
    await session.delete(user)
    await session.commit()
