"""Regras de palavra-chave e o simulador da tela.

O simulador chama a MESMA funcao que o webhook usa (`services.rules.evaluate`).
Se ele diz que dispara, dispara de verdade — nao ha uma segunda implementacao
"aproximada" no frontend pra divergir depois.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import KeywordRule, WaNumber
from app.services import rules as engine

router = APIRouter(prefix="/api/rules", tags=["rules"])


def serialize(rule: KeywordRule) -> dict:
    return {
        "id": rule.id,
        "wa_number_id": rule.wa_number_id,
        "event_name": rule.event_name,
        "keyword": rule.keyword,
        "match_mode": rule.match_mode,
        "direction": rule.direction,
        "value_mode": rule.value_mode,
        "value_fixed": rule.value_fixed,
        "currency": rule.currency,
        "require_attribution": rule.require_attribution,
        "once_per_contact": rule.once_per_contact,
        "is_test": rule.is_test,
        "active": rule.active,
        "hits": rule.hits,
        "last_fired_at": rule.last_fired_at,
        "created_at": rule.created_at,
    }


class RuleIn(BaseModel):
    wa_number_id: int | None = None
    event_name: str = "Lead"
    keyword: str = Field(default="", max_length=240)
    match_mode: str = "broad"
    direction: str = "attendant"
    value_mode: str = "none"
    value_fixed: float | None = None
    currency: str = "BRL"
    require_attribution: bool = True
    once_per_contact: bool = True
    is_test: bool = False
    active: bool = True


class RulePatch(BaseModel):
    event_name: str | None = None
    keyword: str | None = None
    match_mode: str | None = None
    direction: str | None = None
    value_mode: str | None = None
    value_fixed: float | None = None
    currency: str | None = None
    require_attribution: bool | None = None
    once_per_contact: bool | None = None
    is_test: bool | None = None
    active: bool | None = None
    wa_number_id: int | None = None


def _validate(data: RuleIn | RulePatch) -> None:
    if data.match_mode is not None and data.match_mode not in engine.MATCH_MODES:
        raise HTTPException(status_code=400, detail=f"match_mode inválido: {data.match_mode}")
    if data.direction is not None and data.direction not in engine.DIRECTIONS:
        raise HTTPException(status_code=400, detail=f"direction inválida: {data.direction}")
    if data.value_mode is not None and data.value_mode not in engine.VALUE_MODES:
        raise HTTPException(status_code=400, detail=f"value_mode inválido: {data.value_mode}")


async def _check_number(session: AsyncSession, number_id: int | None) -> None:
    if number_id is None:
        return
    if await session.get(WaNumber, number_id) is None:
        raise HTTPException(status_code=404, detail="Linha não encontrada.")


@router.get("/catalog")
async def catalog():
    """Eventos, modos e textos de ajuda que a tela usa — um lugar so define isso."""
    return {
        "events": list(engine.EVENT_CATALOG),
        "match_modes": [
            {
                "value": "broad",
                "label": "Ampla",
                "help": "Dispara se a mensagem contiver todas as palavras da palavra-chave, "
                "em qualquer ordem. Ignora acentos, maiúsculas e pontuação.",
            },
            {
                "value": "exact",
                "label": "Exata",
                "help": "Dispara só se a frase inteira aparecer na mensagem, na mesma ordem. "
                "Ignora acentos, maiúsculas e pontuação.",
            },
        ],
        "value_modes": [
            {"value": "none", "label": "Sem valor", "help": "Evento vai sem valor monetário."},
            {"value": "fixed", "label": "Valor fixo", "help": "Todo disparo dessa regra usa o mesmo valor."},
            {
                "value": "extract",
                "label": "Extrair da mensagem",
                "help": "Lê o valor escrito na própria mensagem (ex.: “fechado por R$ 1.250,00”). "
                "Prioriza o número depois de R$.",
            },
        ],
        "directions": [
            {"value": "attendant", "label": "O atendente", "help": "Mensagem que saiu do seu número."},
            {"value": "customer", "label": "O cliente", "help": "Mensagem que o cliente enviou."},
            {"value": "any", "label": "Qualquer um", "help": "Vale nos dois sentidos da conversa."},
        ],
    }


@router.get("")
async def list_rules(
    number_id: int | None = Query(default=None),
    include_global: bool = Query(default=True),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(KeywordRule).order_by(KeywordRule.id)
    if number_id is not None:
        stmt = (
            stmt.where(KeywordRule.wa_number_id.is_(None) | (KeywordRule.wa_number_id == number_id))
            if include_global
            else stmt.where(KeywordRule.wa_number_id == number_id)
        )
    rows = (await session.execute(stmt)).scalars().all()
    return [serialize(r) for r in rows]


@router.post("")
async def create_rule(payload: RuleIn, session: AsyncSession = Depends(get_session)):
    _validate(payload)
    await _check_number(session, payload.wa_number_id)
    rule = KeywordRule(**payload.model_dump())
    session.add(rule)
    await session.commit()
    await session.refresh(rule)
    return serialize(rule)


@router.patch("/{rule_id}")
async def patch_rule(rule_id: int, payload: RulePatch, session: AsyncSession = Depends(get_session)):
    rule = await session.get(KeywordRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Regra não encontrada.")
    _validate(payload)

    patch = payload.model_dump(exclude_unset=True)
    if "wa_number_id" in patch:
        await _check_number(session, patch["wa_number_id"])
    for key, value in patch.items():
        setattr(rule, key, value)

    await session.commit()
    await session.refresh(rule)
    return serialize(rule)


@router.delete("/{rule_id}", status_code=204)
async def delete_rule(rule_id: int, session: AsyncSession = Depends(get_session)):
    rule = await session.get(KeywordRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Regra não encontrada.")
    await session.delete(rule)
    await session.commit()


class SimulateIn(BaseModel):
    """Regra em rascunho + a mensagem que o atendente escreveria."""

    text: str = ""
    direction: str | None = None  # None = "veio de quem a regra espera"
    event_name: str = "Lead"
    keyword: str = ""
    match_mode: str = "broad"
    rule_direction: str = "attendant"
    value_mode: str = "none"
    value_fixed: float | None = None
    currency: str = "BRL"
    active: bool = True


@router.post("/simulate")
async def simulate(payload: SimulateIn):
    """Diz se essa regra dispararia para essa mensagem, e por que — sem gravar nada."""
    draft = {
        "event_name": payload.event_name,
        "keyword": payload.keyword,
        "match_mode": payload.match_mode,
        "direction": payload.rule_direction,
        "value_mode": payload.value_mode,
        "value_fixed": payload.value_fixed,
        "currency": payload.currency,
        "active": payload.active,
    }
    result = engine.evaluate(draft, payload.text, payload.direction)
    result["direction_label"] = engine.DIRECTION_LABEL.get(payload.rule_direction, payload.rule_direction)
    return result
