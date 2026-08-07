"""Extracao dos identificadores de clique a partir do que o WhatsApp entrega.

Duas fontes:

1. `referral` do webhook da Cloud API — presente quando a pessoa veio de um
   anuncio Click to WhatsApp. Traz `ctwa_clid`, o id do anuncio e a url de origem.
   Esse e o caminho oficial de atribuicao do Meta.

2. O texto da primeira mensagem. Google Ads nao injeta gclid no WhatsApp, entao
   o padrao de mercado e a landing page montar o link wa.me com o clique embutido
   no texto pre-preenchido (ex.: "Ola! [ref: gclid=Cj0KC...]"). Aqui a gente varre
   tanto a url quanto o texto atras desses tokens.
"""

import re
from urllib.parse import parse_qs, urlparse

CLICK_IDS = ("gclid", "wbraid", "gbraid", "fbclid", "ttclid", "msclkid")
UTM_KEYS = ("utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id")

# pega "gclid=VALOR" / "gclid: VALOR" / "gclid VALOR" dentro de texto livre
_INLINE = re.compile(
    r"\b(" + "|".join(CLICK_IDS + UTM_KEYS) + r")\b\s*[:=]\s*([A-Za-z0-9._~\-]+)",
    re.IGNORECASE,
)


def _from_url(url: str | None) -> dict[str, str]:
    if not url:
        return {}
    try:
        qs = parse_qs(urlparse(url).query)
    except ValueError:
        return {}
    found = {}
    for key, values in qs.items():
        low = key.lower()
        if low in CLICK_IDS or low in UTM_KEYS:
            if values and values[0]:
                found[low] = values[0]
    return found


def _from_text(text: str | None) -> dict[str, str]:
    if not text:
        return {}
    return {m.group(1).lower(): m.group(2) for m in _INLINE.finditer(text)}


def extract(referral: dict | None, message_text: str | None) -> dict:
    """Retorna os campos de atribuicao normalizados.

    Precedencia: query string da url de origem > texto da mensagem.
    """
    referral = referral or {}
    found: dict[str, str] = {}
    found.update(_from_text(message_text))
    found.update(_from_url(referral.get("source_url")))

    utm = {k: v for k, v in found.items() if k in UTM_KEYS}

    return {
        "ctwa_clid": referral.get("ctwa_clid") or found.get("ctwa_clid"),
        "source_id": referral.get("source_id"),
        "source_type": referral.get("source_type"),
        "source_url": referral.get("source_url"),
        "ad_headline": referral.get("headline"),
        "ad_body": referral.get("body"),
        "gclid": found.get("gclid"),
        "wbraid": found.get("wbraid"),
        "gbraid": found.get("gbraid"),
        "utm": utm,
    }


def to_e164(wa_id: str | None) -> str | None:
    """wa_id vem sem '+' (ex.: 5511999998888). O CAPI aceita assim; o Google quer E.164."""
    if not wa_id:
        return None
    digits = re.sub(r"\D", "", wa_id)
    return f"+{digits}" if digits else None
