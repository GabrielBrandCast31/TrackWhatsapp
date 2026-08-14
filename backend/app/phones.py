"""Normalizacao de telefone para a prospeccao.

Dois problemas praticos aqui:

1. O Google Maps devolve fixo e celular no mesmo campo. Mandar mensagem pra fixo e
   queimar cota e reputacao do numero, entao classificamos antes.

2. No Brasil o wa_id que a Meta entrega no webhook costuma vir SEM o nono digito
   (5511988887777 -> 551188887777), enquanto o Maps devolve COM. Comparar string
   crua nao casa. `match_key` gera uma chave canonica sem o nono digito, e e por
   ela que o CRM reconhece que quem respondeu foi o prospect que a gente abordou.
"""

import re

BR = "55"
# DDDs validos no Brasil — usados pra decidir se falta DDI no numero.
_BR_DDD = {
    11, 12, 13, 14, 15, 16, 17, 18, 19,
    21, 22, 24, 27, 28,
    31, 32, 33, 34, 35, 37, 38,
    41, 42, 43, 44, 45, 46, 47, 48, 49,
    51, 53, 54, 55,
    61, 62, 63, 64, 65, 66, 67, 68, 69,
    71, 73, 74, 75, 77, 79,
    81, 82, 83, 84, 85, 86, 87, 88, 89,
    91, 92, 93, 94, 95, 96, 97, 98, 99,
}


def digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def to_e164(value: str | None, default_country: str = BR) -> str | None:
    """'+55 11 3229-1681' -> '+551132291681'.

    Numero com 10 ou 11 digitos e DDD valido e tratado como nacional e recebe o DDI.
    """
    num = digits(value)
    if not num:
        return None

    if len(num) in (10, 11) and int(num[:2]) in _BR_DDD:
        num = default_country + num

    # menos de 10 digitos nao e telefone discavel (ramal, numero curto, lixo)
    if len(num) < 10:
        return None
    return f"+{num}"


def classify(e164: str | None) -> str:
    """mobile | landline | unknown — so decide de verdade para numeros brasileiros."""
    num = digits(e164)
    if not num.startswith(BR):
        return "unknown"

    local = num[len(BR):]
    if len(local) < 10:
        return "unknown"

    subscriber = local[2:]  # tira o DDD
    if len(subscriber) == 9 and subscriber[0] == "9":
        return "mobile"
    if len(subscriber) == 8 and subscriber[0] in "2345":
        return "landline"
    if len(subscriber) == 8 and subscriber[0] in "6789":
        return "mobile"  # celular antigo, sem o nono digito
    return "unknown"


def match_key(value: str | None) -> str | None:
    """Chave canonica pra casar numeros que diferem apenas pelo nono digito."""
    num = digits(value)
    if not num:
        return None

    if num.startswith(BR):
        local = num[len(BR):]
        if len(local) == 11 and local[2] == "9":
            local = local[:2] + local[3:]  # derruba o nono digito
        return BR + local
    return num


def to_wa_id(e164: str | None) -> str | None:
    """A Graph API quer o numero sem o '+'."""
    num = digits(e164)
    return num or None
