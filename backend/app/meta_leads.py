"""Leads dos formularios nativos do Facebook/Instagram (Lead Ads) no CRM da linha.

Chegam por dois caminhos, que terminam no mesmo `ingest`:

* webhook `leadgen` da Pagina (app.routers.meta) — o normal, quase em tempo real;
* `sync` — o botao "Importar leads", que relê os formularios da Pagina. Cobre
  o que chegou antes de conectar e o que o webhook perdeu.

O webhook so traz o `leadgen_id`: as respostas sao buscadas com o token da
Pagina. Cada lead vira (ou completa) uma conversa no CRM pelo telefone, com o
anuncio de origem em `source_id` — o mesmo campo do Click to WhatsApp, entao
campanha e objetivo aparecem sem codigo novo.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import phones
from app import numbers as numbers_service
from app.ingest import upsert_contact
from app.models import MetaConnection, MetaLead, WaNumber
from app.services import meta_oauth

log = logging.getLogger(__name__)

# nomes padrao das perguntas do Lead Ads (o formulario pode ter perguntas proprias)
_NAME = ("full_name", "nome_completo", "nome")
_FIRST = ("first_name",)
_LAST = ("last_name",)
_PHONE = ("phone_number", "telefone", "whatsapp", "celular")
_EMAIL = ("email", "e-mail")

_PLATFORM = {"fb": "facebook", "ig": "instagram", "facebook": "facebook", "instagram": "instagram"}


def answers(field_data: list[dict] | None) -> dict[str, str]:
    """`[{name, values:[...]}]` -> `{name: "v1, v2"}`."""
    out: dict[str, str] = {}
    for item in field_data or []:
        name = str(item.get("name") or "").strip()
        values = [str(v).strip() for v in item.get("values") or [] if str(v).strip()]
        if name and values:
            out[name] = ", ".join(values)
    return out


def _pick(data: dict[str, str], keys: tuple[str, ...]) -> str:
    lowered = {k.lower(): v for k, v in data.items()}
    for key in keys:
        if lowered.get(key):
            return lowered[key]
    return ""


def identity(data: dict[str, str]) -> tuple[str, str, str]:
    """(nome, telefone, e-mail) a partir das respostas."""
    name = _pick(data, _NAME) or " ".join(p for p in (_pick(data, _FIRST), _pick(data, _LAST)) if p)
    return name, _pick(data, _PHONE), _pick(data, _EMAIL)


def _parse_time(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        # a Graph manda "2026-10-07T12:34:56+0000"
        return datetime.strptime(raw, "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        return None


async def ingest(
    session: AsyncSession, conn: MetaConnection, raw: dict, form_name: str | None = None
) -> tuple[MetaLead, bool]:
    """Grava o lead e liga ao CRM. Devolve (lead, novo?). Idempotente por leadgen_id."""
    leadgen_id = str(raw["id"])
    existing = (
        await session.execute(
            select(MetaLead).where(
                MetaLead.leadgen_id == leadgen_id, MetaLead.wa_number_id == conn.wa_number_id
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing, False

    data = answers(raw.get("field_data"))
    created_at = _parse_time(raw.get("created_time")) or datetime.now(timezone.utc)
    platform = _PLATFORM.get(str(raw.get("platform") or "").lower())
    lead = MetaLead(
        leadgen_id=leadgen_id,
        wa_number_id=conn.wa_number_id,
        page_id=conn.page_id,
        form_id=raw.get("form_id"),
        form_name=form_name,
        ad_id=raw.get("ad_id"),
        ad_name=raw.get("ad_name"),
        campaign_id=raw.get("campaign_id"),
        campaign_name=raw.get("campaign_name"),
        platform=platform,
        field_data=data,
        lead_created_at=created_at,
    )
    session.add(lead)

    name, phone, _email = identity(data)
    e164 = phones.to_e164(phone) if phone else None
    wa_id = phones.to_wa_id(e164) if e164 else None
    number = await session.get(WaNumber, conn.wa_number_id)
    if wa_id and number is not None:
        attribution = {"source_id": raw.get("ad_id"), "source_type": "ad", "ad_source_app": platform}
        contact, created = await upsert_contact(
            session, wa_id, name or None, {k: v for k, v in attribution.items() if v},
            numbers_service.evo_routing_key(number.evo_instance or "") if number.evo_instance else None,
            number.id, keep_wa_id=True,
        )
        if created or contact.origin in ("webhook", "sync"):
            contact.origin = "lead_ads"
        await session.flush()
        title = form_name or "Lead Ads"
        header = f"📋 Formulário do Facebook “{title}” — {created_at.astimezone().strftime('%d/%m %H:%M')}"
        resumo = "\n".join(f"{k}: {v}" for k, v in data.items())
        contact.note = f"{header}\n{resumo}" + (f"\n\n{contact.note}" if contact.note else "")
        if not contact.first_message:
            contact.first_message = f"[lead ads] {title}"
        if contact.last_message_at is None:
            contact.last_message_at = created_at
            contact.last_message_body = f"📋 Preencheu o formulário “{title}” no Facebook"
        lead.contact_id = contact.id
    elif not wa_id:
        log.info("lead %s da linha %s sem telefone valido: fica so na lista de leads", leadgen_id, conn.wa_number_id)

    await session.flush()
    return lead, True


async def ingest_by_id(session: AsyncSession, conn: MetaConnection, leadgen_id: str) -> bool:
    """Caminho do webhook: busca as respostas pelo id e grava."""
    if not conn.page_token:
        raise meta_oauth.MetaError("Linha sem Página conectada.")
    raw = await meta_oauth.lead(leadgen_id, conn.page_token)
    _, created = await ingest(session, conn, raw)
    await session.commit()
    return created


async def sync(session: AsyncSession, conn: MetaConnection, per_form: int = 100) -> dict:
    """Relê os formularios da Pagina e grava o que faltar."""
    if not conn.page_id or not conn.page_token:
        raise meta_oauth.MetaError("Escolha uma Página antes de importar os leads.")
    forms = await meta_oauth.lead_forms(conn.page_id, conn.page_token)
    seen = new = 0
    for form in forms:
        for raw in await meta_oauth.form_leads(form["id"], conn.page_token, limit=per_form):
            seen += 1
            _, created = await ingest(session, conn, raw, form_name=form.get("name"))
            new += int(created)
    await session.commit()
    return {"forms": len(forms), "seen": seen, "new": new}
