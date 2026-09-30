"""Formularios de captacao (estilo Typeform), publicados em /f/{slug} no mesmo
dominio do painel e usados como destino das campanhas.

Cada formulario pertence a uma linha (o cliente). Uma resposta:

1. fica gravada em `form_responses`;
2. vira conversa no CRM dessa linha (nome, telefone e e-mail saem dos tipos das
   perguntas), com a jornada do site ligada pelo TL_ID quando a pagina tem a tag;
3. avisa a equipe no WhatsApp pela propria instancia da linha;
4. manda o Lead pro Meta (Pixel no navegador + Conversions API aqui, com o mesmo
   event_id para o Meta deduplicar);
5. faz POST num webhook, se configurado (com trava contra rede interna).

Os passos 3 a 5 correm depois de gravar: falha deles nunca perde o lead.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import logging
import os
import re
import secrets
import socket
import time
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit

import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import journey, phones, settings_store
from app import numbers as numbers_service
from app.db import SessionLocal
from app.ingest import upsert_contact
from app.models import Contact, FormResponse, LeadForm, WaNumber

log = logging.getLogger(__name__)

FIELD_TYPES = ("text", "email", "phone", "textarea", "number", "date", "url",
               "choice", "multi", "select", "rating")
OPTION_TYPES = ("choice", "multi", "select")
API_VERSION = os.getenv("META_API_VERSION", "v21.0")

# Aparencia padrao: a mesma paleta do painel (WhatsApp Web escuro)
DEFAULT_THEME = {
    "primary": "#25d366", "bg": "#0b141a", "text": "#e9edef", "button": "Enviar",
    "font": "sans", "radius": "xl", "gradient": True,
}
FONTS = ("sans", "serif", "mono")
RADII = ("none", "md", "xl", "full")

DEFAULT_SETTINGS = {
    "layout": "step",            # step = 1 pergunta por vez | page = tudo numa pagina
    "show_cover": True,
    "cover_button": "Começar",
    "show_progress": True,
    "show_branding": True,
    "branding_text": "Feito com 💚 pela Agência Brandcast",
    "logo_size": 44,
    "consent_enabled": False,
    "consent_text": "Autorizo o contato e o uso dos meus dados conforme a Política de Privacidade.",
    "redirect_url": "",
    "redirect_delay": 3,
    "webhook_url": "",
    # ao terminar, abre o WhatsApp da linha com a mensagem pronta (e o TL_ID da
    # jornada anexado — a conversa que chega ja cai ligada ao formulario)
    "whatsapp_redirect": False,
    "whatsapp_phone": "",        # vazio = o numero da propria linha
    "whatsapp_message": "Olá! Acabei de preencher o formulário e quero falar com vocês.",
    # carrega a tag de jornada da linha na pagina publica (TL_ID, UTMs, click ids)
    "track_journey": True,
}
LAYOUTS = ("step", "page")
PUBLIC_SETTINGS = (
    "layout", "show_cover", "cover_button", "show_progress", "show_branding", "branding_text",
    "logo_size", "consent_enabled", "consent_text", "redirect_url", "redirect_delay",
    "whatsapp_redirect", "track_journey",
)
LOGO_MAX_CHARS = 400_000
THANK_YOU = "Obrigado! Em breve entraremos em contato. 💚"


def slugify(title: str) -> str:
    base = (title or "form").lower()
    base = re.sub(r"[áàâã]", "a", base)
    base = re.sub(r"[éê]", "e", base)
    base = re.sub(r"[í]", "i", base)
    base = re.sub(r"[óôõ]", "o", base)
    base = re.sub(r"[ú]", "u", base)
    base = base.replace("ç", "c")
    s = re.sub(r"[^a-z0-9]+", "-", base).strip("-")[:40] or "form"
    return f"{s}-{secrets.token_hex(3)}"


def clean_fields(fields) -> list[dict]:
    out = []
    for i, f in enumerate(fields or []):
        if not isinstance(f, dict):
            continue
        ftype = f.get("type") if f.get("type") in FIELD_TYPES else "text"
        out.append({
            "id": str(f.get("id") or f"q{i + 1}")[:40],
            "label": (str(f.get("label") or f"Pergunta {i + 1}")).strip()[:200],
            "type": ftype,
            "required": bool(f.get("required", True)),
            "placeholder": (str(f.get("placeholder") or "")).strip()[:120],
            "help": (str(f.get("help") or "")).strip()[:300],
            "options": [str(o).strip()[:100] for o in (f.get("options") or []) if str(o).strip()][:20]
            if ftype in OPTION_TYPES else [],
        })
    # ids repetidos embaralhariam as respostas
    seen: set[str] = set()
    for i, f in enumerate(out):
        if f["id"] in seen:
            f["id"] = f"{f['id']}_{i}"
        seen.add(f["id"])
    return out[:30]


def clean_theme(theme) -> dict:
    out = {**DEFAULT_THEME, **{k: v for k, v in (theme or {}).items() if k in DEFAULT_THEME}}
    for k in ("primary", "bg", "text"):
        v = str(out.get(k) or "").strip()
        out[k] = v if re.fullmatch(r"#[0-9a-fA-F]{6}", v) else DEFAULT_THEME[k]
    out["button"] = (str(out.get("button") or "").strip() or DEFAULT_THEME["button"])[:40]
    out["font"] = out["font"] if out["font"] in FONTS else DEFAULT_THEME["font"]
    out["radius"] = out["radius"] if out["radius"] in RADII else DEFAULT_THEME["radius"]
    out["gradient"] = bool(out["gradient"])
    return out


def clean_settings(settings) -> dict:
    out = dict(DEFAULT_SETTINGS)
    for k, v in (settings or {}).items():
        if k not in DEFAULT_SETTINGS:
            continue
        default = DEFAULT_SETTINGS[k]
        if isinstance(default, bool):
            out[k] = bool(v)
        elif isinstance(default, int):
            try:
                out[k] = int(v)
            except (TypeError, ValueError):
                pass
        else:
            out[k] = str(v or "").strip()[:500]
    if out["layout"] not in LAYOUTS:
        out["layout"] = DEFAULT_SETTINGS["layout"]
    out["logo_size"] = max(20, min(out["logo_size"], 120))
    out["redirect_delay"] = max(0, min(out["redirect_delay"], 30))
    out["cover_button"] = out["cover_button"][:40] or DEFAULT_SETTINGS["cover_button"]
    out["branding_text"] = out["branding_text"][:120]
    out["whatsapp_phone"] = phones.digits(out["whatsapp_phone"])[:15]
    for k in ("redirect_url", "webhook_url"):
        if out[k] and not out[k].startswith(("http://", "https://")):
            out[k] = ""
    return out


def clean_logo(url) -> str:
    v = str(url or "").strip()
    if v.startswith("data:image/") and ";base64," in v:
        return v[:LOGO_MAX_CHARS]
    if v.startswith(("http://", "https://")):
        return v[:500]
    return ""


def apply(form: LeadForm, d: dict) -> None:
    """Aplica um patch vindo do painel, normalizando cada campo."""
    for k in ("title", "headline", "description", "thank_you", "whatsapp_notify"):
        if k in d and d[k] is not None:
            setattr(form, k, str(d[k]).strip()[: 200 if k == "title" else 2000])
    if "pixel_id" in d and d["pixel_id"] is not None:
        form.pixel_id = re.sub(r"\D", "", str(d["pixel_id"]))[:32]
    # o token nao volta pra tela: vazio mantem o atual, `capi_token_clear` apaga
    if str(d.get("capi_token") or "").strip():
        form.capi_token = str(d["capi_token"]).strip()[:400]
    if d.get("capi_token_clear"):
        form.capi_token = ""
    if "fields" in d:
        form.fields = clean_fields(d["fields"])
    if "theme" in d:
        form.theme = clean_theme(d["theme"])
    if "settings" in d:
        form.settings = clean_settings(d["settings"])
    if "logo_url" in d:
        form.logo_url = clean_logo(d["logo_url"])
    for k in ("create_lead", "active"):
        if k in d and d[k] is not None:
            setattr(form, k, bool(d[k]))


def serialize(form: LeadForm, responses: int = 0, number: WaNumber | None = None) -> dict:
    return {
        "id": form.id,
        "slug": form.slug,
        "wa_number_id": form.wa_number_id,
        "number_label": number.label if number else None,
        "title": form.title,
        "headline": form.headline or "",
        "description": form.description or "",
        "fields": clean_fields(form.fields),
        "theme": clean_theme(form.theme),
        "settings": clean_settings(form.settings),
        "thank_you": form.thank_you or THANK_YOU,
        "whatsapp_notify": form.whatsapp_notify or "",
        "create_lead": bool(form.create_lead),
        "active": bool(form.active),
        "views": form.views or 0,
        "responses": responses,
        "pixel_id": form.pixel_id or "",
        # o token nunca volta inteiro: a tela so precisa saber que existe
        "capi_token": "",
        "capi_token__set": bool(form.capi_token),
        "logo_url": form.logo_url or "",
        "created_at": form.created_at,
    }


async def response_counts(session: AsyncSession, ids: list[int]) -> dict[int, int]:
    if not ids:
        return {}
    rows = await session.execute(
        select(FormResponse.form_id, func.count(FormResponse.id))
        .where(FormResponse.form_id.in_(ids))
        .group_by(FormResponse.form_id)
    )
    return dict(rows.all())


def line_phone(number: WaNumber | None) -> str:
    if number is None:
        return ""
    return phones.digits(number.display_phone_number or "") or phones.digits(
        (number.evo_owner_jid or "").split("@")[0].split(":")[0]
    )


def public_payload(form: LeadForm, number: WaNumber | None) -> dict:
    settings = clean_settings(form.settings)
    wa_phone = settings["whatsapp_phone"] or line_phone(number)
    out = {
        "slug": form.slug,
        "headline": form.headline or form.title,
        "description": form.description or "",
        "fields": clean_fields(form.fields),
        "theme": clean_theme(form.theme),
        "thank_you": form.thank_you or THANK_YOU,
        "pixel_id": form.pixel_id or "",
        "logo_url": form.logo_url or "",
        "settings": {k: v for k, v in settings.items() if k in PUBLIC_SETTINGS},
        # so o que a pagina precisa: a chave publica da tag e o destino do WhatsApp
        "site_key": number.site_key if (number and settings["track_journey"]) else None,
        "whatsapp": {"phone": wa_phone, "message": settings["whatsapp_message"]}
        if settings["whatsapp_redirect"] and wa_phone else None,
    }
    return out


# ---------------------------------------------------------------------------
# envio
# ---------------------------------------------------------------------------

class SubmitError(ValueError):
    pass


def normalize_answers(form: LeadForm, answers: dict) -> tuple[dict, dict]:
    clean: dict[str, str] = {}
    labels: dict[str, str] = {}
    for f in clean_fields(form.fields):
        raw = answers.get(f["id"], "")
        if isinstance(raw, (list, tuple)):
            allowed = set(f["options"])
            v = ", ".join(str(x).strip() for x in raw if str(x).strip() and (not allowed or str(x).strip() in allowed))[:1000]
        else:
            v = str(raw or "").strip()[:1000]
        if f["required"] and not v:
            raise SubmitError(f'O campo "{f["label"]}" é obrigatório.')
        if v and f["type"] == "email" and not re.fullmatch(r"\S+@\S+\.\S+", v):
            raise SubmitError(f'"{f["label"]}": e-mail inválido.')
        if v and f["type"] == "phone" and len(phones.digits(v)) < 10:
            raise SubmitError(f'"{f["label"]}": digite o telefone com DDD.')
        if v and f["type"] in ("choice", "select") and f["options"] and v not in f["options"]:
            raise SubmitError(f'"{f["label"]}": escolha uma das opções.')
        clean[f["id"]] = v
        labels[f["id"]] = f["label"]
    return clean, labels


def _first(form: LeadForm, clean: dict, ftype: str) -> str:
    for f in clean_fields(form.fields):
        if f["type"] == ftype and clean.get(f["id"]):
            return clean[f["id"]]
    return ""


def lead_identity(form: LeadForm, clean: dict) -> tuple[str, str, str]:
    """(nome, telefone, e-mail) pelos tipos das perguntas."""
    return _first(form, clean, "text"), _first(form, clean, "phone"), _first(form, clean, "email")


async def submit(session: AsyncSession, form: LeadForm, answers: dict, ctx: dict) -> dict:
    settings = clean_settings(form.settings)
    if settings["consent_enabled"] and not ctx.get("consent"):
        raise SubmitError("É preciso aceitar o termo de consentimento para enviar.")
    clean, labels = normalize_answers(form, answers)
    nome, phone, email = lead_identity(form, clean)
    resumo = "\n".join(f"{labels[k]}: {v}" for k, v in clean.items() if v)

    tl = ctx.get("tl") if journey.TL_ID_SHAPE.match(str(ctx.get("tl") or "")) else None
    number = await session.get(WaNumber, form.wa_number_id) if form.wa_number_id else None
    now = datetime.now(timezone.utc)

    response = FormResponse(
        form_id=form.id, answers=clean, transaction_id=tl,
        ip=(ctx.get("ip") or "")[:64] or None, user_agent=(ctx.get("ua") or "")[:500] or None,
    )
    session.add(response)

    # o envio do formulario e um evento da jornada do visitante
    if tl and number is not None:
        event = journey.build_event(
            number,
            {
                "tl": tl, "event_name": "form_submit", "event_id": ctx.get("event_id"),
                "page_url": ctx.get("url"), "props": {"form": form.slug, "title": form.title},
                "click_ids": {"fbp": ctx.get("fbp"), "fbc": ctx.get("fbc")},
            },
            ctx.get("ip"), ctx.get("ua"),
        )
        if event is not None:
            session.add(event)
    await session.flush()

    contact = None
    e164 = phones.to_e164(phone) if phone else None
    wa_id = phones.to_wa_id(e164) if e164 else None
    if form.create_lead and number is not None and wa_id:
        contact, created = await upsert_contact(
            session, wa_id, nome or None, {}, numbers_service.evo_routing_key(number.evo_instance or ""),
            number.id,
        )
        if created:
            contact.origin = "form"
        await session.flush()
        if nome and not contact.name:
            contact.name = nome
        header = f"📝 Formulário “{form.title}” — {now.astimezone().strftime('%d/%m %H:%M')}"
        contact.note = f"{header}\n{resumo}" + (f"\n\n{contact.note}" if contact.note else "")
        if not contact.first_message:
            contact.first_message = f"[formulário] {form.title}"
        if contact.last_message_at is None:
            contact.last_message_at = now
            contact.last_message_body = f"📝 Respondeu o formulário “{form.title}”"
        if tl:
            await journey.attach_journey(session, contact, f"tl={tl}", now, is_new=created)
        response.contact_id = contact.id

    await session.commit()

    # avisos depois do commit: o lead ja esta salvo, aviso lento nao segura a tela
    asyncio.create_task(_after_submit(form.id, response.id, clean, labels, nome, phone, email, ctx))

    whatsapp = None
    if settings["whatsapp_redirect"]:
        target = settings["whatsapp_phone"] or line_phone(number)
        if target:
            msg = settings["whatsapp_message"]
            if tl:
                msg = f"{msg}\n\ntl={tl}"
            whatsapp = f"https://wa.me/{target}?text={quote(msg)}"
    return {
        "ok": True,
        "id": response.id,
        "thank_you": form.thank_you or THANK_YOU,
        "redirect_url": whatsapp or settings["redirect_url"],
        "redirect_delay": settings["redirect_delay"],
    }


async def _after_submit(form_id, response_id, clean, labels, nome, phone, email, ctx) -> None:
    async with SessionLocal() as session:
        form = await session.get(LeadForm, form_id)
        if form is None:
            return
        number = await session.get(WaNumber, form.wa_number_id) if form.wa_number_id else None
        resumo = "\n".join(f"{labels[k]}: {v}" for k, v in clean.items() if v)

        if form.whatsapp_notify and number is not None:
            try:
                from app.services import evolution

                cfg = numbers_service.effective_cfg(await settings_store.load(session), number)
                to = phones.to_wa_id(phones.to_e164(form.whatsapp_notify)) or phones.digits(form.whatsapp_notify)
                await evolution.send_text(
                    cfg, to, f"🔥 *Novo lead no formulário \"{form.title}\"!*\n\n{resumo}"
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("formulario %s: aviso no WhatsApp falhou: %s", form.id, exc)

        if form.pixel_id and form.capi_token:
            try:
                await send_capi_lead(form, nome, email, phone, ctx)
            except Exception as exc:  # noqa: BLE001
                log.warning("formulario %s: CAPI falhou: %s", form.id, exc)

        url = clean_settings(form.settings)["webhook_url"]
        if url:
            try:
                await send_webhook(form, response_id, clean, labels, url)
            except Exception as exc:  # noqa: BLE001
                log.warning("formulario %s: webhook falhou: %s", form.id, exc)


# ---------------------------------------------------------------------------
# Meta Conversions API (Lead, action_source=website)
# ---------------------------------------------------------------------------

def _h(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def capi_user_data(nome: str, email: str, phone: str, ctx: dict) -> dict:
    data: dict = {}
    if email:
        data["em"] = [_h(email.strip().lower())]
    digits = phones.digits(phones.to_e164(phone) or phone) if phone else ""
    if digits:
        data["ph"] = [_h(digits)]
    first = (nome or "").strip().split(" ")[0].lower()
    if first:
        data["fn"] = [_h(first)]
    if ctx.get("ip"):
        data["client_ip_address"] = ctx["ip"]
    if ctx.get("ua"):
        data["client_user_agent"] = ctx["ua"]
    for k in ("fbp", "fbc"):
        if ctx.get(k):
            data[k] = ctx[k]
    return data


async def send_capi_lead(form: LeadForm, nome: str, email: str, phone: str, ctx: dict) -> None:
    payload = {
        "data": [{
            "event_name": "Lead",
            "event_time": int(time.time()),
            "action_source": "website",
            "event_id": ctx.get("event_id") or secrets.token_hex(16),
            "event_source_url": ctx.get("url") or "",
            "user_data": capi_user_data(nome, email, phone, ctx),
            "custom_data": {"content_name": form.title},
        }],
        # token no corpo, nao na URL (URL com credencial vaza em log)
        "access_token": form.capi_token,
    }
    url = f"https://graph.facebook.com/{API_VERSION}/{form.pixel_id}/events"
    async with httpx.AsyncClient(timeout=8) as client:
        r = await client.post(url, json=payload)
    if r.status_code >= 400:
        raise RuntimeError(f"{r.status_code} {r.text[:300]}")


# ---------------------------------------------------------------------------
# webhook (com trava contra rede interna)
# ---------------------------------------------------------------------------

WEBHOOK_ALLOW_HOSTS = {
    h.strip().lower() for h in os.getenv("FORM_WEBHOOK_ALLOW_HOSTS", "").split(",") if h.strip()
}


def check_webhook_target(url: str) -> str | None:
    """Resolve o host UMA vez e recusa IP privado/loopback/link-local (SSRF).

    Devolve o IP validado — a conexao vai direto nele. Resolver de novo na hora de
    conectar abriria brecha pra DNS rebinding (o nome responde um IP publico na
    checagem e um interno logo depois). None = host liberado em
    FORM_WEBHOOK_ALLOW_HOSTS, que conecta pelo nome normalmente.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ValueError("o webhook precisa usar http ou https")
    host = (parts.hostname or "").lower()
    if not host:
        raise ValueError("o webhook está sem host")
    if host in WEBHOOK_ALLOW_HOSTS:
        return None
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise ValueError(f"o host do webhook não resolve ({exc})") from exc
    ips = []
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise ValueError(f"webhook aponta para endereço interno ({ip}) — bloqueado")
        ips.append(ip)
    if not ips:
        raise ValueError("o host do webhook não resolve")
    return str(ips[0])


def pinned_request(url: str, ip: str | None) -> tuple[str, dict, dict]:
    """(url, headers, extensions) conectando no IP validado.

    O Host vai no header e, em HTTPS, o nome vai como SNI — o certificado continua
    sendo conferido contra o nome do site, nao contra o IP.
    """
    if ip is None:
        return url, {}, {}
    parts = urlsplit(url)
    host = parts.hostname or ""
    literal = f"[{ip}]" if ":" in ip else ip
    netloc = f"{literal}:{parts.port}" if parts.port else literal
    pinned = parts._replace(netloc=netloc).geturl()
    host_header = f"{host}:{parts.port}" if parts.port else host
    extensions = {"sni_hostname": host} if parts.scheme == "https" else {}
    return pinned, {"Host": host_header}, extensions


async def send_webhook(form: LeadForm, response_id: int, clean: dict, labels: dict, url: str) -> None:
    ip = await asyncio.to_thread(check_webhook_target, url)
    target, headers, extensions = pinned_request(url, ip)
    payload = {
        "event": "form.response",
        "form": {"id": form.id, "slug": form.slug, "title": form.title},
        "response_id": response_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "answers": {labels[k]: v for k, v in clean.items()},
        "answers_by_id": clean,
    }
    # sem seguir redirect: um 302 pra rede interna furaria a checagem
    async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
        r = await client.post(target, json=payload, headers=headers, extensions=extensions)
    if r.status_code >= 400:
        raise RuntimeError(f"{r.status_code} {r.text[:200]}")
