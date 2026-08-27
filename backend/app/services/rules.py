"""Motor das regras de palavra-chave: casa o texto e resolve o valor do evento.

Funcoes puras de proposito. O disparo automatico (no webhook) e o simulador da
tela usam ESTA logica, sem copia: se o simulador diz que dispara, dispara — e o
contrario tambem. Era o unico jeito de o simulador servir de teste de verdade.

Comparacao ignora acento, maiusculas e pontuacao, porque atendente digitando no
celular escreve "confianca", "Confiança!" e "CONFIANCA" na mesma semana.
"""

import re
import unicodedata

# Eventos oferecidos na tela. `accepts_value` so muda o texto da UI — o Meta
# aceita valor em qualquer evento, mas oferecer valor em "Contact" confunde.
EVENT_CATALOG = (
    {"name": "Lead", "label": "Lead — Conversa iniciada", "accepts_value": True},
    {"name": "Contact", "label": "Contact — Primeiro contato", "accepts_value": False},
    {"name": "Schedule", "label": "Schedule — Agendamento", "accepts_value": True},
    {"name": "SubmitApplication", "label": "SubmitApplication — Proposta enviada", "accepts_value": True},
    {"name": "CompleteRegistration", "label": "CompleteRegistration — Cadastro concluído", "accepts_value": True},
    {"name": "StartTrial", "label": "StartTrial — Início de teste", "accepts_value": True},
    {"name": "InitiateCheckout", "label": "InitiateCheckout — Negociação iniciada", "accepts_value": True},
    {"name": "Purchase", "label": "Purchase — Venda fechada", "accepts_value": True},
)

MATCH_MODES = ("broad", "exact")
DIRECTIONS = ("attendant", "customer", "any")
VALUE_MODES = ("none", "fixed", "extract")

DIRECTION_LABEL = {
    "attendant": "atendente",
    "customer": "cliente",
    "any": "qualquer um dos dois",
}

# "R$ 1.234,56", "r$250", "RS 90,00" — valor anunciado explicitamente.
_MONEY = re.compile(r"(?:r\$|rs)\s*([0-9][0-9.,]*[0-9]|[0-9])", re.IGNORECASE)
# numero solto, usado so quando ninguem escreveu R$
_NUMBER = re.compile(r"(?<![\w.,:])([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)(?![\w:])")
# "as 14h", "dia 12" — numero que e horario ou data, nao dinheiro
_NOT_MONEY_BEFORE = re.compile(r"\b(dia|as|às|as|hora|horas|codigo|código|cpf|numero|número)\s*$", re.IGNORECASE)
_NOT_MONEY_AFTER = re.compile(r"^\s*(h\b|hs\b|horas?\b|:[0-9])", re.IGNORECASE)


def strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def normalize(text: str | None) -> str:
    """Minusculo, sem acento, sem pontuacao, espaco unico. Vazio se nao houver texto."""
    if not text:
        return ""
    flat = strip_accents(str(text)).lower()
    flat = re.sub(r"[^a-z0-9]+", " ", flat)
    return flat.strip()


def parse_number(raw: str) -> float | None:
    """Le numero em formato brasileiro ou americano.

    "1.234,56" -> 1234.56   "1.200" -> 1200.0   "250,00" -> 250.0   "250.5" -> 250.5
    """
    value = raw.strip()
    if not value:
        return None
    if "," in value and "." in value:
        value = value.replace(".", "").replace(",", ".")
    elif "," in value:
        head, _, tail = value.rpartition(",")
        value = f"{head.replace(',', '')}.{tail}" if len(tail) in (1, 2) else value.replace(",", "")
    elif "." in value:
        head, _, tail = value.rpartition(".")
        if len(tail) == 3:  # 1.200 = mil e duzentos, nao 1,2
            value = f"{head.replace('.', '')}{tail}"
        elif len(tail) not in (1, 2):
            value = value.replace(".", "")
    try:
        return float(value)
    except ValueError:
        return None


def extract_money(text: str | None) -> float | None:
    """Valor citado na mensagem. Prioriza o que vem depois de R$."""
    if not text:
        return None

    for match in _MONEY.finditer(text):
        value = parse_number(match.group(1))
        if value is not None:
            return value

    for match in _NUMBER.finditer(text):
        before = text[: match.start()]
        after = text[match.end() :]
        if _NOT_MONEY_BEFORE.search(before) or _NOT_MONEY_AFTER.match(after):
            continue
        value = parse_number(match.group(1))
        if value is not None:
            return value
    return None


def keyword_matches(keyword: str | None, text: str | None, mode: str) -> bool:
    """`exact` = a frase inteira aparece na ordem; `broad` = todas as palavras aparecem."""
    needle = normalize(keyword)
    haystack = normalize(text)
    if not needle or not haystack:
        return False

    if mode == "exact":
        # espaco nas pontas fecha a fronteira de palavra: "pago" nao casa "pagovel"
        return f" {needle} " in f" {haystack} "

    words = haystack.split()
    return all(any(token == word or token in word for word in words) for token in needle.split())


def _as_dict(rule) -> dict:
    """Aceita tanto o modelo do banco quanto o rascunho que a tela manda."""
    if isinstance(rule, dict):
        return rule
    return {
        "event_name": rule.event_name,
        "keyword": rule.keyword,
        "match_mode": rule.match_mode,
        "direction": rule.direction,
        "value_mode": rule.value_mode,
        "value_fixed": rule.value_fixed,
        "currency": rule.currency,
        "active": rule.active,
        "id": rule.id,
    }


def evaluate(rule, text: str | None, direction: str | None = None) -> dict:
    """Diz se a regra dispararia para esse texto, e por que.

    `direction` e quem mandou a mensagem ("attendant" | "customer"). `None` pede
    "considere que veio de quem a regra espera" — e o que o simulador da tela usa,
    porque lá o usuário está justamente digitando a mensagem do atendente.
    """
    data = _as_dict(rule)
    mode = data.get("match_mode") or "broad"
    wanted = data.get("direction") or "attendant"
    event_name = data.get("event_name") or "Lead"
    currency = data.get("currency") or "BRL"

    out: dict = {
        "rule_id": data.get("id"),
        "event_name": event_name,
        "fires": False,
        "matched": False,
        "value": None,
        "currency": currency,
        "reason": "",
        "value_note": "",
        "normalized_text": normalize(text),
        "normalized_keyword": normalize(data.get("keyword")),
    }

    if not (data.get("keyword") or "").strip():
        out["reason"] = "Regra sem palavra-chave: preencha o termo que o atendente vai escrever."
        return out

    if data.get("active") is False:
        out["reason"] = "Regra desativada — não dispara nem no chat real."
        return out

    if direction is not None and wanted != "any" and direction != wanted:
        out["reason"] = (
            f"Mensagem enviada pelo {DIRECTION_LABEL.get(direction, direction)}, "
            f"mas esta regra só olha o que o {DIRECTION_LABEL.get(wanted, wanted)} escreve."
        )
        return out

    if not keyword_matches(data.get("keyword"), text, mode):
        out["reason"] = (
            "A mensagem não contém a frase exata da palavra-chave."
            if mode == "exact"
            else "A mensagem não contém todas as palavras da palavra-chave."
        )
        return out

    out["matched"] = True
    out["fires"] = True

    value_mode = data.get("value_mode") or "none"
    if value_mode == "fixed":
        fixed = data.get("value_fixed")
        out["value"] = float(fixed) if fixed is not None else None
        out["value_note"] = (
            "Valor fixo da regra." if out["value"] is not None else "Valor fixo não preenchido — evento sai sem valor."
        )
    elif value_mode == "extract":
        found = extract_money(text)
        out["value"] = found
        out["value_note"] = (
            "Valor lido da mensagem."
            if found is not None
            else "Nenhum valor encontrado na mensagem — evento sai sem valor."
        )

    out["reason"] = f"Palavra-chave encontrada ({'exata' if mode == 'exact' else 'ampla'})."
    return out


def first_firing(rules, text: str | None, direction: str) -> list[dict]:
    """Todas as regras que disparariam, na ordem em que foram cadastradas."""
    hits = []
    for rule in rules:
        result = evaluate(rule, text, direction)
        if result["fires"]:
            result["rule"] = rule
            hits.append(result)
    return hits
