"""Extracao dos identificadores de clique a partir do que o WhatsApp entrega.

Duas fontes:

1. `referral` do webhook da Cloud API — presente quando a pessoa veio de um
   anuncio Click to WhatsApp. Traz `ctwa_clid`, o id do anuncio e a url de origem.
   Esse e o caminho oficial de atribuicao do Meta.

2. O texto da primeira mensagem. Google Ads nao injeta gclid no WhatsApp, entao
   o padrao de mercado e a landing page montar o link wa.me com o clique embutido
   no texto pre-preenchido (ex.: "Ola! [ref: gclid=Cj0KC...]"). Aqui a gente varre
   tanto a url quanto o texto atras desses tokens.

O `ctwa_clid` participa das DUAS fontes. A oficial e a primeira; quando ela nao
traz o clid — anuncio que manda `sourceUrl` sem `ctwaClid`, ou link wa.me montado
pela propria landing page — o clid costuma estar na query string da url de origem
ou no texto pre-preenchido, e o fallback resgata a atribuicao que se perderia.
"""

import logging
import re
from urllib.parse import parse_qs, urlparse

log = logging.getLogger(__name__)

CLICK_IDS = ("gclid", "wbraid", "gbraid", "fbclid", "ttclid", "msclkid")
UTM_KEYS = ("utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id")
CTWA_KEY = "ctwa_clid"

# quem monta o link costuma copiar o nome do campo do WhatsApp (`ctwaClid`); a
# busca e case-insensitive, entao basta mapear a forma sem underscore.
_ALIASES = {"ctwaclid": CTWA_KEY}

_TRACKED_KEYS = CLICK_IDS + UTM_KEYS + (CTWA_KEY,) + tuple(_ALIASES)

# pega "gclid=VALOR" / "gclid: VALOR" dentro de texto livre — e tambem dentro de
# uma url colada no texto, que e como a LP costuma repassar o clid.
_INLINE = re.compile(
    r"\b(" + "|".join(_TRACKED_KEYS) + r")\b\s*[:=]\s*([A-Za-z0-9._~\-]+)",
    re.IGNORECASE,
)


def _canonical(key: str) -> str | None:
    """Nome interno do parametro, ou None se nao for um parametro rastreado."""
    low = key.lower()
    low = _ALIASES.get(low, low)
    return low if low in CLICK_IDS or low in UTM_KEYS or low == CTWA_KEY else None


def _from_url(url: str | None) -> dict[str, str]:
    if not url:
        return {}
    try:
        qs = parse_qs(urlparse(url).query)
    except ValueError:
        return {}
    found = {}
    for key, values in qs.items():
        name = _canonical(key)
        if name and values and values[0]:
            found[name] = values[0]
    return found


def _from_text(text: str | None) -> dict[str, str]:
    if not text:
        return {}
    found = {}
    for match in _INLINE.finditer(text):
        name = _canonical(match.group(1))
        if name:
            found[name] = match.group(2)
    return found


def extract(referral: dict | None, message_text: str | None) -> dict:
    """Retorna os campos de atribuicao normalizados.

    Precedencia: query string da url de origem > texto da mensagem. Para o
    `ctwa_clid`, o valor oficial do `referral` vem antes dos dois.
    """
    referral = referral or {}
    found: dict[str, str] = {}
    found.update(_from_text(message_text))
    found.update(_from_url(referral.get("source_url")))

    utm = {k: v for k, v in found.items() if k in UTM_KEYS}

    ctwa_clid = referral.get(CTWA_KEY)
    if not ctwa_clid and found.get(CTWA_KEY):
        ctwa_clid = found[CTWA_KEY]
        # nao e o caminho oficial: vale aparecer no log pra depurar atribuicao
        log.info("ctwa_clid recuperado do fallback (url/texto), nao veio no referral")

    return {
        "ctwa_clid": ctwa_clid,
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
