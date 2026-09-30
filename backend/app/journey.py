"""Jornada do lead: navegacao no site (TL_ID) -> clique no WhatsApp -> conversa -> lead.

Implementa o Framework de Rastreamento Web -> WhatsApp:

* a tag do site (`/t/tl.js`) gera ou recupera o **TL_ID** do visitante e manda
  cada evento relevante (page_view, click_whatsapp, form_submit...) pro coletor,
  que grava em `tracking_events` com `transaction_id = TL_ID`;
* no clique no WhatsApp a tag anexa `tl=<TL_ID>` (ou um protocolo curto) na
  mensagem pre-preenchida;
* quando a conversa chega pela Evolution, `attach_journey` extrai o TL_ID,
  consulta a jornada e grava no lead a origem recuperada — com metodo e score.

Estrategia de identificacao, do mais confiavel pro menos:

  1. transaction_id  TL_ID na mensagem                          score 1.00
  2. protocol        protocolo curto anexado ao clique          score 0.95
  3. temporal        um unico click_whatsapp na janela de tempo score 0.75
  4. probabilistic   varios cliques na janela: o mais proximo   score <= 0.50

3 e 4 so valem para conversa NOVA: uma conversa antiga que manda mensagem nao
pode herdar o clique de outra pessoa que acabou de chegar no site.

Regra de atribuicao: uma visita posterior sem informacao (direct / none) nunca
apaga uma atribuicao valida. Por isso first touch e last touch sao separados, e
o last touch so anda quando o evento traz UTM ou click id de verdade.
"""

import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Contact, TrackingEvent, WaNumber

log = logging.getLogger(__name__)

# janela do match temporal: clique no WhatsApp ate a primeira mensagem
MATCH_WINDOW = timedelta(seconds=int(os.getenv("JOURNEY_MATCH_WINDOW_SECONDS", "900")))
# a mensagem pode chegar alguns segundos "antes" do clique por diferenca de relogio
CLOCK_SKEW = timedelta(seconds=60)

EVENT_NAMES = (
    "page_view",
    "view_service",
    "click_phone",
    "click_email",
    "click_instagram",
    "click_whatsapp",
    "form_start",
    "form_submit",
)
EVENT_LABELS = {
    "page_view": "Visualizou página",
    "view_service": "Viu serviço",
    "click_phone": "Clicou no telefone",
    "click_email": "Clicou no e-mail",
    "click_instagram": "Clicou no Instagram",
    "click_whatsapp": "Clicou no WhatsApp",
    "form_start": "Começou formulário",
    "form_submit": "Enviou formulário",
}

UTM_FIELDS = ("source", "medium", "campaign", "content", "term")
CLICK_FIELDS = ("fbclid", "fbp", "fbc", "gclid", "gbraid", "wbraid", "gad_source", "ttclid", "ttp")
PAGE_FIELDS = ("page_url", "page_path", "page_title", "page_referrer", "landing_page", "hostname")
GA_FIELDS = ("ga_client_id", "ga_session_id", "ga_session_number")

MATCH_LABELS = {
    "transaction_id": "TL_ID na conversa",
    "protocol": "Protocolo do clique",
    "temporal": "Janela temporal",
    "probabilistic": "Probabilístico",
    "manual": "Ligado à mão",
}

# `tl=1790195601229_17901956838213` dentro do texto da conversa. O `\b` evita
# pegar "html=" ou "utl="; o valor aceita o formato da tag e ids de outras tags.
TL_PATTERN = re.compile(r"(?<![A-Za-z0-9_])tl\s*[=:]\s*([A-Za-z0-9][A-Za-z0-9_\-]{7,63})", re.IGNORECASE)
PROTOCOL_PATTERN = re.compile(r"\bTL-([A-Z0-9]{6})\b")
TL_ID_SHAPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{7,63}$")

_MAX = {"short": 255, "long": 2048}


def new_site_key() -> str:
    return secrets.token_urlsafe(12).replace("-", "x").replace("_", "y")


async def ensure_site_key(session: AsyncSession, number: WaNumber) -> str:
    """Linha antiga nao tem chave da tag: nasce na primeira vez que alguem pede."""
    if not number.site_key:
        number.site_key = new_site_key()
        await session.commit()
    return number.site_key


def find_reference(text: str | None) -> tuple[str | None, str | None]:
    """(tl, protocolo) anexados ao clique, se a mensagem trouxer."""
    if not text:
        return None, None
    tl = TL_PATTERN.search(text)
    protocol = PROTOCOL_PATTERN.search(text)
    return (tl.group(1) if tl else None, f"TL-{protocol.group(1)}" if protocol else None)


def strip_reference(text: str | None) -> str | None:
    """Texto da conversa sem a referencia tecnica — ela so serve pra identificacao."""
    if not text:
        return text
    cleaned = TL_PATTERN.sub("", text)
    cleaned = re.sub(r"\(?\s*(?:protocolo\s*:?\s*)?\bTL-[A-Z0-9]{6}\b\s*\)?", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[ \t]*\[\s*\]", "", cleaned)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


# ---------------------------------------------------------------------------
# entrada: o coletor
# ---------------------------------------------------------------------------

def _clip(value, kind: str = "short") -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text[: _MAX[kind]] or None


def _parse_time(value) -> datetime:
    now = datetime.now(timezone.utc)
    try:
        if isinstance(value, (int, float)):
            stamp = datetime.fromtimestamp(value / 1000 if value > 1e11 else value, tz=timezone.utc)
        elif isinstance(value, str) and value:
            stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
        else:
            return now
    except (ValueError, OverflowError, OSError):
        return now
    # relogio do visitante nao manda no banco: evento "do futuro" ou de anos atras
    # vira o horario de chegada
    if abs((stamp - now).total_seconds()) > 86400:
        return now
    return stamp


def _utm_block(data: dict, block_key: str, prefix: str) -> dict:
    """UTMs de um bloco (`{"source": ...}`) ou das chaves planas (`first_utm_source`)."""
    block = data.get(block_key)
    out = {}
    for field in UTM_FIELDS:
        value = None
        if isinstance(block, dict):
            value = block.get(field) or block.get(f"utm_{field}")
        value = value or data.get(f"{prefix}utm_{field}")
        if value:
            out[field] = _clip(value)
    return out


def build_event(number: WaNumber | None, data: dict, ip: str | None, user_agent: str | None) -> TrackingEvent | None:
    """Evento cru da tag -> linha de `tracking_events`. None = descartado."""
    tl = _clip(data.get("tl") or data.get("transaction_id"))
    if not tl or not TL_ID_SHAPE.match(tl):
        return None
    name = _clip(data.get("event_name") or data.get("event") or "page_view")
    if not name or not re.match(r"^[a-z][a-z0-9_]{1,47}$", name):
        return None

    current = _utm_block(data, "utm", "")
    first = _utm_block(data, "first_touch", "first_")
    last = _utm_block(data, "last_touch", "last_")
    clicks = data.get("click_ids") if isinstance(data.get("click_ids"), dict) else {}
    ga = data.get("ga") if isinstance(data.get("ga"), dict) else {}
    props = data.get("props") if isinstance(data.get("props"), dict) else {}

    url = _clip(data.get("page_url"), "long")
    parsed = urlparse(url) if url else None

    event = TrackingEvent(
        wa_number_id=number.id if number else None,
        transaction_id=tl,
        visitor_id=_clip(data.get("visitor_id"), "short"),
        session_id=_clip(data.get("session_id")),
        event_id=_clip(data.get("event_id")) or secrets.token_hex(12),
        protocol=_clip(data.get("protocol")),
        event_name=name,
        event_time=_parse_time(data.get("event_time")),
        props={k: v for k, v in list(props.items())[:30] if isinstance(k, str)},
        page_url=url,
        page_path=_clip(data.get("page_path") or (parsed.path if parsed else None), "long"),
        page_title=_clip(data.get("page_title"), "long"),
        page_referrer=_clip(data.get("page_referrer"), "long"),
        landing_page=_clip(data.get("landing_page"), "long"),
        hostname=_clip(data.get("hostname") or (parsed.hostname if parsed else None)),
        ip=_clip(ip, "short"),
        user_agent=_clip(user_agent or data.get("user_agent"), "long"),
    )
    for field in UTM_FIELDS:
        setattr(event, f"utm_{field}", current.get(field))
        setattr(event, f"first_utm_{field}", first.get(field))
        setattr(event, f"last_utm_{field}", last.get(field))
    for field in CLICK_FIELDS:
        setattr(event, field, _clip(clicks.get(field) or data.get(field)))
    # _fbc so existe quando existiu um fbclid real: nunca inventar identificador
    if event.fbc and not event.fbclid and not str(event.fbc).startswith("fb."):
        event.fbc = None
    for field in GA_FIELDS:
        setattr(event, field, _clip(ga.get(field.removeprefix("ga_")) or data.get(field)))
    return event


def aware(stamp: datetime) -> datetime:
    """SQLite devolve datetime sem fuso; o evento recem-criado tem fuso. Iguala os dois."""
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# leitura: a jornada reconstruida
# ---------------------------------------------------------------------------

def _touch_of(event: TrackingEvent, prefix: str) -> dict:
    return {f: getattr(event, f"{prefix}utm_{f}") for f in UTM_FIELDS if getattr(event, f"{prefix}utm_{f}")}


_URL_CLICK_IDS = ("gclid", "gbraid", "wbraid", "fbclid", "ttclid")


def url_click_ids(page_url: str | None) -> set[str]:
    """Click ids presentes na URL DAQUELA pagina.

    A tag reenvia em todo evento os click ids que ja guardou; so o que esta na
    URL prova que a pessoa chegou por um clique agora — senao toda pagina
    seguinte pareceria uma nova origem e o last touch perderia a campanha.
    """
    if not page_url or "?" not in page_url:
        return set()
    try:
        query = parse_qs(urlparse(page_url).query)
    except ValueError:
        return set()
    return {k for k in _URL_CLICK_IDS if query.get(k)}


def has_signal(utm_source: str | None, page_url: str | None) -> bool:
    """O evento trouxe origem de verdade? (UTM ou click id na URL da pagina)"""
    return bool(utm_source) or bool(url_click_ids(page_url))


def _has_signal(event: TrackingEvent) -> bool:
    return has_signal(event.utm_source, event.page_url)


def signal_touch(utm: dict, page_url: str | None) -> dict:
    touch = dict(utm)
    if not touch.get("source"):
        ids = url_click_ids(page_url)
        if ids & {"gclid", "gbraid", "wbraid"}:
            touch.update(source="google", medium="cpc")
        elif "fbclid" in ids:
            touch.update(source="facebook", medium="paid")
        elif "ttclid" in ids:
            touch.update(source="tiktok", medium="paid")
    return touch


def _signal_touch(event: TrackingEvent) -> dict:
    return signal_touch(_touch_of(event, ""), event.page_url)


def _referrer_touch(events: list[TrackingEvent]) -> dict:
    """Sem UTM nem click id: a origem sai do referrer da primeira pagina."""
    for event in events:
        ref = event.page_referrer
        if not ref:
            continue
        host = (urlparse(ref).hostname or "").lower()
        if host and host != (event.hostname or "").lower():
            source = host.removeprefix("www.").removeprefix("m.").removeprefix("l.").removeprefix("lm.")
            return {"source": source, "medium": "referral" if not _is_search(source) else "organic"}
        break
    return {}


def _is_search(host: str) -> bool:
    return any(s in host for s in ("google.", "bing.", "yahoo.", "duckduckgo.", "ecosia."))


def classify(touch: dict, clicks: dict) -> dict:
    """Canal legivel da origem: Google Ads, Meta Ads, TikTok Ads, orgânico, direto..."""
    source = (touch.get("source") or "").lower()
    medium = (touch.get("medium") or "").lower()
    paid = medium in ("cpc", "ppc", "paid", "ads", "paid_social", "paidsocial", "display", "cpm") or "paid" in medium
    if clicks.get("gclid") or clicks.get("gbraid") or clicks.get("wbraid") or (source == "google" and paid):
        return {"channel": "google_ads", "label": "Google Ads"}
    meta_sources = ("facebook", "instagram", "fb", "ig", "meta", "an", "msg")
    if clicks.get("fbclid") or (source in meta_sources and paid):
        return {"channel": "meta_ads", "label": "Meta Ads"}
    if clicks.get("ttclid") or (source == "tiktok" and paid):
        return {"channel": "tiktok_ads", "label": "TikTok Ads"}
    if not source:
        return {"channel": "direct", "label": "Direto"}
    if medium == "organic" or _is_search(source):
        return {"channel": "organic", "label": f"Orgânico · {source}"}
    if source in meta_sources or source in ("tiktok", "youtube", "linkedin", "twitter", "x"):
        return {"channel": "social", "label": f"Social · {source}"}
    if medium == "referral":
        return {"channel": "referral", "label": f"Referência · {source}"}
    return {"channel": "utm", "label": f"{source} / {medium or 'none'}"}


def summarize(events: list[TrackingEvent]) -> dict:
    """As sete perguntas do framework, respondidas a partir dos eventos da jornada."""
    events = sorted(events, key=lambda e: (aware(e.event_time), e.id or 0))
    if not events:
        return {}
    first_event = events[0]

    # first touch: o que a tag guardou como aquisicao; sem isso, o primeiro sinal real
    first_touch = next((_touch_of(e, "first_") for e in events if e.first_utm_source), {})
    signals = [e for e in events if _has_signal(e)]
    if not first_touch and signals:
        first_touch = _signal_touch(signals[0])
    if not first_touch:
        first_touch = _referrer_touch(events)

    # last touch: o sinal mais recente. Visita direta NAO substitui origem valida.
    last_touch = _signal_touch(signals[-1]) if signals else {}
    if not last_touch:
        last_touch = next((_touch_of(e, "last_") for e in reversed(events) if e.last_utm_source), {}) or dict(first_touch)

    clicks: dict = {}
    for event in events:  # o valor mais recente de cada id, sem apagar com vazio
        for field in CLICK_FIELDS:
            if getattr(event, field):
                clicks[field] = getattr(event, field)
    ga = {}
    for event in events:
        for field in GA_FIELDS:
            if getattr(event, field):
                ga[field] = getattr(event, field)

    pages = []
    for event in events:
        if event.event_name == "page_view" and event.page_path and (not pages or pages[-1] != event.page_path):
            pages.append(event.page_path)

    wa_clicks = [e for e in events if e.event_name == "click_whatsapp"]
    last = events[-1]
    landing = next((e.landing_page for e in events if e.landing_page), None) or first_event.page_path
    return {
        "transaction_id": first_event.transaction_id,
        "visitor_id": next((e.visitor_id for e in events if e.visitor_id), None),
        "session_ids": sorted({e.session_id for e in events if e.session_id}),
        "wa_number_id": first_event.wa_number_id,
        "started_at": first_event.event_time,
        "last_event_at": last.event_time,
        "events": len(events),
        "page_views": sum(1 for e in events if e.event_name == "page_view"),
        "landing_page": landing,
        "hostname": first_event.hostname,
        "pages": pages,
        "first_touch": first_touch,
        "last_touch": last_touch,
        "origin": classify(last_touch, clicks),
        "first_origin": classify(first_touch, clicks if not first_touch else {}),
        "click_ids": clicks,
        "ga": ga,
        "clicked_whatsapp_at": wa_clicks[0].event_time if wa_clicks else None,
        "whatsapp_clicks": len(wa_clicks),
        "protocol": next((e.protocol for e in reversed(events) if e.protocol), None),
        "ip": last.ip,
        "user_agent": last.user_agent,
    }


def serialize_event(event: TrackingEvent) -> dict:
    return {
        "id": event.id,
        "event_id": event.event_id,
        "event_name": event.event_name,
        "label": EVENT_LABELS.get(event.event_name, event.event_name),
        "event_time": event.event_time,
        "session_id": event.session_id,
        "page_url": event.page_url,
        "page_path": event.page_path,
        "page_title": event.page_title,
        "page_referrer": event.page_referrer,
        "utm": _touch_of(event, ""),
        "click_ids": {f: getattr(event, f) for f in CLICK_FIELDS if getattr(event, f)},
        "props": event.props or {},
        "protocol": event.protocol,
    }


async def events_for(session: AsyncSession, tl: str, number_id: int | None = None) -> list[TrackingEvent]:
    stmt = select(TrackingEvent).where(TrackingEvent.transaction_id == tl)
    if number_id is not None:
        stmt = stmt.where(TrackingEvent.wa_number_id == number_id)
    stmt = stmt.order_by(TrackingEvent.event_time, TrackingEvent.id).limit(1000)
    return list((await session.execute(stmt)).scalars().all())


# ---------------------------------------------------------------------------
# a conversa chega: acha a jornada e grava a origem no lead
# ---------------------------------------------------------------------------

async def _claimed(session: AsyncSession, number_id: int | None, tls: set[str], exclude: int | None) -> set[str]:
    if not tls:
        return set()
    stmt = select(Contact.transaction_id).where(Contact.transaction_id.in_(tls))
    if number_id is not None:
        stmt = stmt.where(Contact.wa_number_id == number_id)
    if exclude is not None:
        stmt = stmt.where(Contact.id != exclude)
    return {tl for tl in (await session.execute(stmt)).scalars().all() if tl}


async def _temporal_candidates(
    session: AsyncSession, contact: Contact, arrived_at: datetime
) -> list[tuple[str, float]]:
    """Cliques no WhatsApp da mesma linha na janela, que ainda nao viraram lead."""
    stmt = (
        select(TrackingEvent.transaction_id, TrackingEvent.event_time)
        .where(TrackingEvent.event_name == "click_whatsapp")
        .where(TrackingEvent.event_time >= arrived_at - MATCH_WINDOW)
        .where(TrackingEvent.event_time <= arrived_at + CLOCK_SKEW)
    )
    if contact.wa_number_id is not None:
        stmt = stmt.where(TrackingEvent.wa_number_id == contact.wa_number_id)
    rows = (await session.execute(stmt)).all()
    nearest: dict[str, float] = {}
    for tl, stamp in rows:
        stamp = stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
        gap = abs((arrived_at - stamp).total_seconds())
        nearest[tl] = min(gap, nearest.get(tl, gap))
    taken = await _claimed(session, contact.wa_number_id, set(nearest), contact.id)
    return sorted(((tl, gap) for tl, gap in nearest.items() if tl not in taken), key=lambda x: x[1])


def apply_journey(contact: Contact, summary: dict, method: str, score: float, arrived_at: datetime | None) -> None:
    """Grava no lead a referencia da jornada e a origem recuperada dela.

    Nao duplica a jornada: o lead leva o TL_ID, first/last touch e os click ids —
    o resto e consultado em `tracking_events` pelo transaction_id. Atribuicao que
    o lead ja tinha (ctwa_clid do anuncio, gclid de outro caminho) nao e apagada.
    """
    contact.transaction_id = summary.get("transaction_id") or contact.transaction_id
    contact.visitor_id = summary.get("visitor_id") or contact.visitor_id
    sessions = summary.get("session_ids") or []
    contact.session_id = sessions[-1] if sessions else contact.session_id
    contact.first_utm = summary.get("first_touch") or contact.first_utm or {}
    contact.last_utm = summary.get("last_touch") or contact.last_utm or {}
    clicks = summary.get("click_ids") or {}
    for field in ("gclid", "gbraid", "wbraid", "fbp", "fbc", "ttclid"):
        if clicks.get(field) and not getattr(contact, field):
            setattr(contact, field, clicks[field])
    contact.landing_page = summary.get("landing_page") or contact.landing_page
    contact.page_url = contact.page_url or summary.get("last_page_url")
    contact.match_method = method
    contact.match_score = score
    contact.whatsapp_arrived_at = contact.whatsapp_arrived_at or arrived_at
    # a etiqueta de origem do CRM le `utm`: o last touch da jornada entra la
    last = contact.last_utm or {}
    if last and not (contact.utm or {}).get("utm_source"):
        contact.utm = {**(contact.utm or {}), **{f"utm_{k}": v for k, v in last.items()}}


async def attach_journey(
    session: AsyncSession,
    contact: Contact,
    text: str | None,
    arrived_at: datetime,
    *,
    is_new: bool,
) -> dict | None:
    """Liga a conversa a jornada do site. Devolve o match feito, ou None."""
    if contact.transaction_id:
        return None
    arrived_at = arrived_at if arrived_at.tzinfo else arrived_at.replace(tzinfo=timezone.utc)
    tl, protocol = find_reference(text)

    events: list[TrackingEvent] = []
    method, score = None, 0.0
    if tl:
        # 1. TL_ID: a associacao mais confiavel. Vale mesmo sem eventos gravados
        #    (tag de outro dominio, evento bloqueado): o id em si e deterministico.
        events = await events_for(session, tl, contact.wa_number_id)
        method, score = "transaction_id", 1.0
    elif protocol:
        # 2. protocolo curto anexado ao clique
        stmt = select(TrackingEvent.transaction_id).where(TrackingEvent.protocol == protocol)
        if contact.wa_number_id is not None:
            stmt = stmt.where(TrackingEvent.wa_number_id == contact.wa_number_id)
        found = (await session.execute(stmt.order_by(TrackingEvent.event_time.desc()).limit(1))).scalar()
        if found:
            tl = found
            events = await events_for(session, tl, contact.wa_number_id)
            method, score = "protocol", 0.95
    elif is_new:
        # 3/4. sem identificador: o clique no WhatsApp mais proximo da chegada
        candidates = await _temporal_candidates(session, contact, arrived_at)
        if candidates:
            tl = candidates[0][0]
            events = await events_for(session, tl, contact.wa_number_id)
            if len(candidates) == 1:
                method, score = "temporal", 0.75
            else:
                method, score = "probabilistic", round(max(0.2, 0.5 / (len(candidates) - 1)), 2)

    if not method or not tl:
        return None

    summary = summarize(events) if events else {"transaction_id": tl}
    last_page = next((e.page_url for e in reversed(events) if e.page_url), None)
    summary["last_page_url"] = last_page
    apply_journey(contact, summary, method, score, arrived_at)
    log.info("contato %s ligado a jornada %s (%s, %.2f)", contact.id, tl, method, score)
    return {"transaction_id": tl, "match_method": method, "match_score": score, "events": len(events)}


async def link_manually(session: AsyncSession, contact: Contact, tl: str) -> dict:
    events = await events_for(session, tl, contact.wa_number_id)
    summary = summarize(events) if events else {"transaction_id": tl}
    summary["last_page_url"] = next((e.page_url for e in reversed(events) if e.page_url), None)
    contact.transaction_id = None  # troca de jornada: a nova vale inteira
    apply_journey(contact, summary, "manual", 1.0, contact.whatsapp_arrived_at or contact.created_at)
    return summary


def contact_journey_fields(contact: Contact) -> dict:
    """O que o lead carrega da jornada — a parte leve que viaja na lista do CRM."""
    return {
        "transaction_id": contact.transaction_id,
        "visitor_id": contact.visitor_id,
        "session_id": contact.session_id,
        "first_utm": contact.first_utm or {},
        "last_utm": contact.last_utm or {},
        "fbp": contact.fbp,
        "fbc": contact.fbc,
        "ttclid": contact.ttclid,
        "landing_page": contact.landing_page,
        "page_url": contact.page_url,
        "match_method": contact.match_method,
        "match_label": MATCH_LABELS.get(contact.match_method or "", None),
        "match_score": contact.match_score,
        "whatsapp_arrived_at": contact.whatsapp_arrived_at,
    }
