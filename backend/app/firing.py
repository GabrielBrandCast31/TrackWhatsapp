"""Criacao e envio de um evento de conversao — caminho unico.

Tres lugares disparam evento: o botao na tela de Leads, a regra de palavra-chave
quando o atendente responde, e o disparo automatico no primeiro contato. Todos
passam por aqui, senao a diferenca entre eles vira bug de tracking silencioso.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Contact, Conversion
from app.services.dispatch import dispatch_conversion, enabled_destinations


async def fire_event(
    session: AsyncSession,
    cfg: dict,
    contact: Contact,
    *,
    event_name: str,
    value: float | None = None,
    currency: str | None = None,
    is_test: bool = False,
    note: str | None = None,
    source: str = "manual",
    rule_id: int | None = None,
    destinations: list[str] | None = None,
) -> Conversion:
    """Grava a conversao e manda pros destinos. Devolve a conversao ja com os envios."""
    conv = Conversion(
        contact_id=contact.id,
        event_name=event_name,
        event_id=f"wa-{contact.id}-{uuid.uuid4().hex[:12]}",
        value=value,
        currency=currency or cfg.get("default_currency") or "BRL",
        note=note,
        is_test=is_test,
        source=source,
        rule_id=rule_id,
    )
    session.add(conv)
    await session.commit()
    await session.refresh(conv)

    await dispatch_conversion(session, cfg, conv, contact, destinations or enabled_destinations(cfg))
    return conv


async def already_fired(session: AsyncSession, contact_id: int, rule_id: int) -> bool:
    """Se essa regra ja disparou para esse contato — sustenta o 'uma vez por contato'."""
    count = (
        await session.execute(
            select(func.count(Conversion.id))
            .where(Conversion.contact_id == contact_id)
            .where(Conversion.rule_id == rule_id)
        )
    ).scalar_one()
    return bool(count)
