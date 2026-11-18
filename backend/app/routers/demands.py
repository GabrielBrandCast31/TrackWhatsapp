"""Painel de demandas do gestor: cadastro e acompanhamento de tarefas.

Quem ve o que:

* admin (o gestor) -> todas as demandas; cria, edita, distribui e apaga;
* operacao         -> so as que criou ou que foram atribuidas a ele. Edita e
                      apaga as proprias; nas que recebeu, so muda o status.

Demanda de outra pessoa responde 404, como as linhas em app.access: nao
confirma que o id existe.
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import access, auth
from app.db import get_session
from app.models import Demand, User, WaNumber, utcnow

router = APIRouter(prefix="/api/demands", tags=["demands"])

PRIORITIES = ("baixa", "media", "alta", "urgente")
STATUSES = ("aberta", "andamento", "concluida")


class DemandIn(BaseModel):
    title: str
    description: str | None = None
    wa_number_id: int | None = None
    assignee_id: int | None = None
    priority: str = "media"
    status: str = "aberta"
    due_date: date | None = None


class DemandPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    wa_number_id: int | None = None
    assignee_id: int | None = None
    priority: str | None = None
    status: str | None = None
    due_date: date | None = None


def _is_admin(user: User) -> bool:
    return user.role == "admin"


def _can_edit(demand: Demand, user: User) -> bool:
    return _is_admin(user) or demand.created_by == user.id


def _visible(stmt, user: User):
    if _is_admin(user):
        return stmt
    return stmt.where(or_(Demand.created_by == user.id, Demand.assignee_id == user.id))


async def _get(session: AsyncSession, demand_id: int, user: User) -> Demand:
    demand = await session.get(Demand, demand_id)
    if demand is None or not (_can_edit(demand, user) or demand.assignee_id == user.id):
        raise HTTPException(status_code=404, detail="Demanda não encontrada.")
    return demand


async def _clean(session: AsyncSession, user: User, data: dict) -> dict:
    """Valida so os campos que vieram — serve pro cadastro e pra edicao parcial."""
    if "title" in data:
        title = (data["title"] or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Dê um título para a demanda.")
        if len(title) > 200:
            raise HTTPException(status_code=400, detail="O título passa de 200 caracteres.")
        data["title"] = title
    if "description" in data:
        data["description"] = (data["description"] or "").strip() or None
    if "priority" in data and data["priority"] not in PRIORITIES:
        raise HTTPException(status_code=400, detail="Prioridade inválida.")
    if "status" in data and data["status"] not in STATUSES:
        raise HTTPException(status_code=400, detail="Status inválido.")
    if data.get("wa_number_id") is not None:
        access.ensure_number(data["wa_number_id"])
        if await session.get(WaNumber, data["wa_number_id"]) is None:
            raise HTTPException(status_code=404, detail="Linha não encontrada.")
    if data.get("assignee_id") is not None:
        if not _is_admin(user) and data["assignee_id"] != user.id:
            raise HTTPException(
                status_code=403, detail="Só o administrador atribui demandas a outras pessoas."
            )
        assignee = await session.get(User, data["assignee_id"])
        if assignee is None or not assignee.active:
            raise HTTPException(status_code=400, detail="Responsável não encontrado ou inativo.")
    return data


def _apply(demand: Demand, data: dict) -> None:
    previous = demand.status
    for key, value in data.items():
        setattr(demand, key, value)
    if demand.status != previous or demand.id is None:
        demand.completed_at = utcnow() if demand.status == "concluida" else None


async def _serialize(session: AsyncSession, rows: list[Demand], user: User) -> list[dict]:
    user_ids = {i for d in rows for i in (d.assignee_id, d.created_by) if i is not None}
    number_ids = {d.wa_number_id for d in rows if d.wa_number_id is not None}
    names: dict[int, str] = {}
    labels: dict[int, str] = {}
    if user_ids:
        for u in (await session.execute(select(User).where(User.id.in_(user_ids)))).scalars():
            names[u.id] = u.name or u.username
    if number_ids:
        for n in (await session.execute(select(WaNumber).where(WaNumber.id.in_(number_ids)))).scalars():
            labels[n.id] = n.label
    return [
        {
            "id": d.id,
            "title": d.title,
            "description": d.description,
            "wa_number_id": d.wa_number_id,
            "number_label": labels.get(d.wa_number_id) if d.wa_number_id is not None else None,
            "assignee_id": d.assignee_id,
            "assignee_name": names.get(d.assignee_id) if d.assignee_id is not None else None,
            "created_by": d.created_by,
            "creator_name": names.get(d.created_by) if d.created_by is not None else None,
            "priority": d.priority,
            "status": d.status,
            "due_date": d.due_date.isoformat() if d.due_date else None,
            "completed_at": d.completed_at.isoformat() if d.completed_at else None,
            "created_at": d.created_at.isoformat(),
            "updated_at": d.updated_at.isoformat(),
            "can_edit": _can_edit(d, user),
        }
        for d in rows
    ]


@router.get("")
async def list_demands(
    user: User = Depends(auth.require_user), session: AsyncSession = Depends(get_session)
):
    rows = (
        await session.execute(_visible(select(Demand), user).order_by(Demand.created_at.desc()))
    ).scalars().all()
    return await _serialize(session, list(rows), user)


@router.get("/options")
async def options(
    user: User = Depends(auth.require_user), session: AsyncSession = Depends(get_session)
):
    """Quem pode ser responsavel: o admin distribui pra qualquer um; o resto, so pra si."""
    if _is_admin(user):
        users = (
            await session.execute(select(User).where(User.active.is_(True)).order_by(User.name, User.username))
        ).scalars().all()
    else:
        users = [user]
    return {"users": [{"id": u.id, "name": u.name or u.username} for u in users]}


@router.post("")
async def create_demand(
    payload: DemandIn,
    user: User = Depends(auth.require_user),
    session: AsyncSession = Depends(get_session),
):
    data = await _clean(session, user, payload.model_dump())
    demand = Demand(created_by=user.id)
    _apply(demand, data)
    session.add(demand)
    await session.commit()
    await session.refresh(demand)
    return (await _serialize(session, [demand], user))[0]


@router.patch("/{demand_id}")
async def update_demand(
    demand_id: int,
    payload: DemandPatch,
    user: User = Depends(auth.require_user),
    session: AsyncSession = Depends(get_session),
):
    demand = await _get(session, demand_id, user)
    # exclude_unset: `assignee_id: null` enviado de proposito tira o responsavel
    data = payload.model_dump(exclude_unset=True)
    if not _can_edit(demand, user) and set(data) - {"status"}:
        raise HTTPException(
            status_code=403, detail="Nesta demanda você só pode mudar o status."
        )
    for required in ("title", "priority", "status"):
        if required in data and data[required] is None:
            data.pop(required)
    _apply(demand, await _clean(session, user, data))
    await session.commit()
    await session.refresh(demand)
    return (await _serialize(session, [demand], user))[0]


@router.delete("/{demand_id}")
async def delete_demand(
    demand_id: int,
    user: User = Depends(auth.require_user),
    session: AsyncSession = Depends(get_session),
):
    demand = await _get(session, demand_id, user)
    if not _can_edit(demand, user):
        raise HTTPException(status_code=403, detail="Só quem criou ou o administrador apaga a demanda.")
    await session.delete(demand)
    await session.commit()
    return {"ok": True}
