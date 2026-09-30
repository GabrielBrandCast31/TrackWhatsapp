"""Quem ve o que: cada usuario so enxerga as linhas (clientes) que sao dele.

* admin      -> todas as linhas;
* operacao   -> so as linhas ligadas a ele em `user_numbers` (o admin distribui
                em Admin -> Usuarios; quem cadastra uma linha nova ja fica dono dela).

O usuario da requisicao e as linhas dele ficam num ContextVar preenchido por
`auth.require_user` — a mesma dependencia que ja protege todo /api. Assim as
rotas nao precisam receber o usuario por parametro: chamam `scope(...)` para
filtrar consulta e `ensure_*` para barrar acesso direto por id.

Linha de outro usuario responde 404, nao 403: nao confirma que o id existe.
"""

from contextvars import ContextVar

from fastapi import HTTPException
from sqlalchemy import false, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserNumber

# (usuario, linhas permitidas). None nas linhas = sem restricao (admin).
_current: ContextVar[tuple[User | None, frozenset[int] | None]] = ContextVar(
    "access_current", default=(None, None)
)


async def load(session: AsyncSession, user: User) -> None:
    """Chamado a cada requisicao autenticada."""
    if user.role == "admin":
        _current.set((user, None))
        return
    ids = (
        await session.execute(select(UserNumber.wa_number_id).where(UserNumber.user_id == user.id))
    ).scalars().all()
    _current.set((user, frozenset(ids)))


def current_user() -> User | None:
    return _current.get()[0]


def allowed() -> frozenset[int] | None:
    """Linhas que o usuario pode ver. None = todas."""
    return _current.get()[1]


def is_restricted() -> bool:
    return allowed() is not None


def can_see(number_id: int | None) -> bool:
    ids = allowed()
    if ids is None:
        return True
    return number_id is not None and number_id in ids


def ensure_number(number_id: int | None) -> None:
    if not can_see(number_id):
        raise HTTPException(status_code=404, detail="Linha não encontrada.")


def ensure_contact(contact) -> None:
    if contact is None or not can_see(contact.wa_number_id):
        raise HTTPException(status_code=404, detail="Conversa não encontrada.")


def scope(stmt, column, number_id: int | None = None):
    """Filtra a consulta pela linha pedida — ou pelas linhas do usuario, sem pedido."""
    if number_id is not None:
        ensure_number(number_id)
        return stmt.where(column == number_id)
    ids = allowed()
    if ids is None:
        return stmt
    return stmt.where(column.in_(ids)) if ids else stmt.where(false())


def number_ids_or_all(number_id: int | None) -> list[int] | None:
    """Para rotinas que rodam por linha: a pedida, as do usuario, ou None (todas)."""
    if number_id is not None:
        ensure_number(number_id)
        return [number_id]
    ids = allowed()
    return None if ids is None else sorted(ids)


async def grant(session: AsyncSession, user_id: int, number_id: int) -> None:
    exists = await session.get(UserNumber, (user_id, number_id))
    if exists is None:
        session.add(UserNumber(user_id=user_id, wa_number_id=number_id))


async def numbers_of(session: AsyncSession, user_id: int) -> list[int]:
    return list(
        (
            await session.execute(select(UserNumber.wa_number_id).where(UserNumber.user_id == user_id))
        ).scalars().all()
    )


async def set_numbers(session: AsyncSession, user_id: int, number_ids: list[int]) -> None:
    current = set(await numbers_of(session, user_id))
    wanted = set(number_ids)
    for nid in current - wanted:
        row = await session.get(UserNumber, (user_id, nid))
        if row is not None:
            await session.delete(row)
    for nid in wanted - current:
        session.add(UserNumber(user_id=user_id, wa_number_id=nid))
