"""Funil de atendimento: Lead -> MQL -> Continuou a conversa -> Agendamento
confirmado -> Compareceu na clinica -> Fechamento.

A etapa atual do lead mora em `contacts.stage`, e o momento em que ele ALCANCOU
cada etapa mora numa coluna propria (`mql_at`, `conversation_at`...). O funil
conta pelos marcos, nao pela etapa atual — quem fechou tambem passou por todas as
etapas anteriores, e quem foi perdido continua contando ate onde chegou.

Quem move o lead:

* manual   — o atendente, no CRM (pode voltar etapa: e correcao);
* auto     — o proprio sistema: o cliente voltou a falar depois da resposta do
             atendente = "continuou a conversa" (so vale pra quem ja e MQL);
* rule     — regra de palavra-chave com "mover etapa" ("Seu horario esta
             confirmado" -> agendado);
* ai       — a analise da IA sugere a etapa (MQL, agendado...).

Tudo que nao e manual so AVANCA: automatico nunca rebaixa o que alguem moveu.
"""

from datetime import datetime, timezone

from app.models import Contact

# ordem do funil. `perdido` fica fora da ordem: e saida, nao degrau.
ORDER = ("novo", "mql", "conversando", "agendado", "compareceu", "fechado")
RANK = {stage: i for i, stage in enumerate(ORDER)}

LABELS = {
    "novo": "Novo lead",
    "mql": "MQL",
    "conversando": "Continuou a conversa",
    "agendado": "Agendamento confirmado",
    "compareceu": "Compareceu na clínica",
    "fechado": "Fechamento",
    "perdido": "Perdido",
}
SHORT_LABELS = {
    "novo": "Novo",
    "mql": "MQL",
    "conversando": "Conversando",
    "agendado": "Agendado",
    "compareceu": "Compareceu",
    "fechado": "Fechado",
    "perdido": "Perdido",
}

# etapa -> coluna do marco
MILESTONE = {
    "mql": "mql_at",
    "conversando": "conversation_at",
    "agendado": "scheduled_at",
    "compareceu": "attended_at",
    "fechado": "closed_at",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def reached_rank(contact: Contact) -> int:
    """O degrau mais alto que o lead ja alcancou (pelos marcos e pela etapa atual)."""
    best = RANK.get(contact.stage, 0)
    for stage, column in MILESTONE.items():
        if getattr(contact, column):
            best = max(best, RANK[stage])
    return best


def _stamp_up_to(contact: Contact, stage: str, when: datetime) -> None:
    """Marca a etapa e as anteriores que ainda nao tinham marco."""
    for s in ORDER[1 : RANK[stage] + 1]:
        column = MILESTONE[s]
        if getattr(contact, column) is None:
            setattr(contact, column, when)


def advance(contact: Contact, stage: str, source: str, when: datetime | None = None) -> bool:
    """Avanca o lead ate `stage` se ele ainda nao passou dela. Nunca rebaixa.

    Devolve True se a etapa mudou. Lead perdido nao e reaberto por automatico —
    se ele voltou de verdade, alguem move na mao.
    """
    if stage not in RANK or stage == "novo":
        return False
    if contact.stage == "perdido" and source != "manual":
        return False
    when = when or _now()
    if RANK.get(contact.stage, 0) >= RANK[stage]:
        _stamp_up_to(contact, stage, when)  # etapa ja alcancada: so completa marco que faltava
        return False
    _stamp_up_to(contact, stage, when)
    contact.stage = stage
    contact.stage_changed_at = when
    contact.stage_source = source
    # virou MQL e ja tinha conversa em andamento: sobe junto
    if stage == "mql" and contact.customer_replied_at:
        _stamp_up_to(contact, "conversando", when)
        contact.stage = "conversando"
    return True


def set_manual(contact: Contact, stage: str, deal_value: float | None = None) -> None:
    """Mudanca feita pelo atendente. Pode voltar etapa (correcao): os marcos
    depois da nova etapa sao apagados, os anteriores sao completados."""
    now = _now()
    if stage == "perdido":
        contact.lost_at = contact.lost_at or now
    else:
        contact.lost_at = None
        if stage in RANK and stage != "novo":
            _stamp_up_to(contact, stage, now)
        if stage in RANK:
            for s in ORDER[RANK[stage] + 1 :]:
                setattr(contact, MILESTONE[s], None)
    if stage == "fechado" and deal_value is not None:
        contact.deal_value = deal_value
    contact.stage = stage
    contact.stage_changed_at = now
    contact.stage_source = "manual"


def on_attendant_message(contact: Contact, at: datetime) -> None:
    if contact.first_response_at is None:
        contact.first_response_at = at


def on_customer_message(contact: Contact, at: datetime) -> bool:
    """O cliente falou. Se o atendente ja tinha respondido, ele continuou a conversa."""
    if contact.first_response_at is None:
        return False
    first = contact.first_response_at
    first = first if first.tzinfo else first.replace(tzinfo=timezone.utc)
    at = at if at.tzinfo else at.replace(tzinfo=timezone.utc)
    if at <= first:
        return False
    if contact.customer_replied_at is None:
        contact.customer_replied_at = at
    # "continuou a conversa" e um degrau depois do MQL: lead nao qualificado que
    # responde nao pula etapa — o sinal fica guardado e vale quando virar MQL
    if contact.stage == "mql":
        return advance(contact, "conversando", "auto", at)
    return False


def funnel_counts(contacts) -> dict:
    """Quantos leads alcancaram cada etapa, com conversao etapa a etapa.

    `lost_by_stage` diz em qual degrau os perdidos pararam.
    """
    reached = {s: 0 for s in ORDER}
    lost_by_stage = {s: 0 for s in ORDER}
    revenue = 0.0
    for c in contacts:
        rank = reached_rank(c)
        for s in ORDER[: rank + 1]:
            reached[s] += 1
        if c.stage == "perdido":
            lost_by_stage[ORDER[rank]] += 1
        if c.closed_at or c.stage == "fechado":
            revenue += c.deal_value or 0.0
    total = reached["novo"]
    steps = []
    prev = None
    for s in ORDER:
        n = reached[s]
        steps.append(
            {
                "stage": s,
                "label": LABELS[s] if s != "novo" else "Leads",
                "count": n,
                "from_start": round(n / total, 4) if total else None,
                "from_previous": round(n / prev, 4) if prev else None,
                "lost_here": lost_by_stage[s],
            }
        )
        prev = n
    return {"total": total, "steps": steps, "revenue": revenue}


async def backfill(session) -> int:
    """Base que ja existia antes do funil: tira os sinais de atendimento (primeira
    resposta e o cliente voltando a falar) das mensagens gravadas. Roda uma vez."""
    from sqlalchemy import select

    from app.models import Message, Setting

    marker = await session.get(Setting, "funnel_backfill_v1")
    if marker is not None:
        return 0
    rows = (
        await session.execute(
            select(Message.contact_id, Message.direction, Message.sent_at).order_by(
                Message.contact_id, Message.sent_at, Message.id
            )
        )
    ).all()
    by_contact: dict[int, list] = {}
    for contact_id, direction, sent_at in rows:
        by_contact.setdefault(contact_id, []).append((direction, sent_at))
    touched = 0
    for contact_id, msgs in by_contact.items():
        contact = await session.get(Contact, contact_id)
        if contact is None or contact.first_response_at is not None:
            continue
        for direction, sent_at in msgs:
            if direction == "out":
                on_attendant_message(contact, sent_at)
            else:
                on_customer_message(contact, sent_at)
        touched += 1
    session.add(Setting(key="funnel_backfill_v1", value={"contacts": touched}))
    await session.commit()
    return touched
