"""Qualificacao de lead por formulario.

Cada formulario guarda os criterios em `LeadForm.qualification`: regras sobre as
respostas ("orcamento e um de: R$ 5 mil+, R$ 10 mil+", "nota >= 4"...) e como
combina-las:

- `all`: qualifica quando TODAS as regras batem;
- `any`: qualifica quando QUALQUER uma bate;
- `score`: soma os pontos das regras que bateram e qualifica a partir de
  `min_score`.

O resultado fica em `FormResponse.qualified` (True/False; None = formulario sem
criterio). A equipe pode corrigir na mao (`qualified_source = "manual"`). Quando
qualifica e `send_event` esta ligado, o formulario manda o evento
`event_name` (padrao QualifiedLead) pro Meta — ver `forms.send_qualified_event`.
"""

from __future__ import annotations

import re
import secrets

OPS = ("is_any", "is_none", "contains", "not_contains", "gte", "lte", "filled", "empty")
MODES = ("all", "any", "score")
EVENT_NAME_SHAPE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,49}")
DEFAULT_EVENT = "QualifiedLead"
# eventos padrao do Meta: no navegador vao por fbq('track'); o resto por trackCustom
STANDARD_EVENTS = {
    "Lead", "CompleteRegistration", "Contact", "Schedule", "SubmitApplication",
    "Subscribe", "StartTrial", "Purchase", "ViewContent", "FindLocation",
}

DEFAULT_CONFIG = {
    "enabled": False,
    "mode": "all",
    "min_score": 1,
    "rules": [],
    # manda o evento pro Meta (CAPI e Pixel) quando o lead qualifica
    "send_event": True,
    "event_name": DEFAULT_EVENT,
    # leva o card do CRM para MQL quando qualifica
    "move_to_mql": True,
    # aviso no WhatsApp da equipe so para lead qualificado
    "notify_only_qualified": False,
}
MAX_RULES = 30


def _num(v) -> float | None:
    s = str(v if v is not None else "").strip().replace(" ", "")
    if not s:
        return None
    # "1.500,50" -> 1500.50 ; "3,5" -> 3.5 ; "R$ 2000" -> 2000
    s = re.sub(r"[^0-9,.\-]", "", s)
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"-?\d{1,3}(\.\d{3})+", s):
        s = s.replace(".", "")  # "2.000" e milhar, nao 2
    try:
        return float(s)
    except ValueError:
        return None


def clean_rule(r, i: int) -> dict | None:
    if not isinstance(r, dict):
        return None
    field_id = str(r.get("field_id") or "").strip()[:40]
    op = r.get("op") if r.get("op") in OPS else None
    if not field_id or op is None:
        return None
    values = [str(v).strip()[:100] for v in (r.get("values") or []) if str(v).strip()][:20]
    try:
        points = int(r.get("points", 1))
    except (TypeError, ValueError):
        points = 1
    return {
        "id": str(r.get("id") or f"r{i + 1}")[:40] or secrets.token_hex(3),
        "field_id": field_id,
        "op": op,
        "values": values,
        "value": str(r.get("value") or "").strip()[:100],
        "points": max(-100, min(points, 100)),
    }


def clean_config(cfg) -> dict:
    cfg = cfg if isinstance(cfg, dict) else {}
    out = dict(DEFAULT_CONFIG)
    for k in ("enabled", "send_event", "move_to_mql", "notify_only_qualified"):
        if k in cfg:
            out[k] = bool(cfg[k])
    out["mode"] = cfg.get("mode") if cfg.get("mode") in MODES else DEFAULT_CONFIG["mode"]
    try:
        out["min_score"] = max(-1000, min(int(cfg.get("min_score", out["min_score"])), 1000))
    except (TypeError, ValueError):
        pass
    name = str(cfg.get("event_name") or "").strip()
    out["event_name"] = name if EVENT_NAME_SHAPE.fullmatch(name) else DEFAULT_EVENT
    rules = []
    for i, r in enumerate((cfg.get("rules") or [])[:MAX_RULES]):
        c = clean_rule(r, i)
        if c is not None:
            rules.append(c)
    seen: set[str] = set()
    for i, r in enumerate(rules):
        if r["id"] in seen:
            r["id"] = f"{r['id']}_{i}"
        seen.add(r["id"])
    out["rules"] = rules
    return out


def _selected(answer: str, field: dict | None) -> set[str]:
    """Opcoes marcadas. Resposta de multipla escolha chega como "A, B": quando o
    campo tem opcoes, casa pelas opcoes conhecidas (uma opcao pode ter virgula)."""
    a = (answer or "").strip()
    if not a:
        return set()
    options = (field or {}).get("options") or []
    if field and field.get("type") == "multi" and options:
        parts = {p.strip() for p in a.split(", ")}
        return {o for o in options if o in parts or o == a}
    return {a}


def rule_matches(rule: dict, answer: str, field: dict | None) -> bool:
    op = rule["op"]
    a = (answer or "").strip()
    if op == "filled":
        return bool(a)
    if op == "empty":
        return not a
    if op in ("is_any", "is_none"):
        wanted = {v.lower() for v in rule["values"]}
        hit = any(s.lower() in wanted for s in _selected(a, field))
        return hit if op == "is_any" else (not hit)
    if op in ("contains", "not_contains"):
        terms = [t.lower() for t in (rule["values"] or [rule["value"]]) if t]
        if not terms:
            return op == "not_contains"
        hit = any(t in a.lower() for t in terms)
        return hit if op == "contains" else (not hit)
    if op in ("gte", "lte"):
        n, ref = _num(a), _num(rule["value"])
        if n is None or ref is None:
            return False
        return n >= ref if op == "gte" else n <= ref
    return False


def evaluate(cfg: dict, fields: list[dict], answers: dict) -> dict:
    """Aplica os criterios as respostas.

    Devolve {"qualified": bool | None, "score": int, "matched": [ids], "failed": [ids]}.
    `qualified` e None quando o formulario nao tem criterio ligado — a resposta
    fica "sem classificacao", nao "nao qualificada".
    """
    cfg = clean_config(cfg)
    by_id = {f["id"]: f for f in fields or []}
    rules = [r for r in cfg["rules"] if r["field_id"] in by_id]
    if not cfg["enabled"] or not rules:
        return {"qualified": None, "score": 0, "matched": [], "failed": []}
    matched, failed, score = [], [], 0
    for r in rules:
        if rule_matches(r, str((answers or {}).get(r["field_id"]) or ""), by_id.get(r["field_id"])):
            matched.append(r["id"])
            score += r["points"]
        else:
            failed.append(r["id"])
    if cfg["mode"] == "all":
        qualified = not failed
    elif cfg["mode"] == "any":
        qualified = bool(matched)
    else:
        qualified = score >= cfg["min_score"]
    return {"qualified": qualified, "score": score, "matched": matched, "failed": failed}


def describe_rule(rule: dict, field: dict | None) -> str:
    """Texto curto da regra, para o aviso e a tela ("Orçamento é um de: A, B")."""
    label = (field or {}).get("label") or rule["field_id"]
    vals = ", ".join(rule["values"]) or rule["value"]
    return {
        "is_any": f"{label} é um de: {vals}",
        "is_none": f"{label} não é: {vals}",
        "contains": f"{label} contém: {vals}",
        "not_contains": f"{label} não contém: {vals}",
        "gte": f"{label} ≥ {rule['value']}",
        "lte": f"{label} ≤ {rule['value']}",
        "filled": f"{label} respondida",
        "empty": f"{label} em branco",
    }.get(rule["op"], label)


def simulate(cfg: dict, fields: list[dict], rows: list[dict]) -> dict:
    """Roda os criterios sobre respostas ja recebidas, para ajustar antes de ligar.

    `rows` sao dicts de respostas. Devolve o total que qualificaria, quanto cada
    regra bate e, nas perguntas de opcao, a distribuicao de respostas com a taxa
    de qualificacao de cada opcao — e ai que se ve qual pergunta separa o lead
    bom do ruim.
    """
    cfg = clean_config({**(cfg or {}), "enabled": True})
    by_id = {f["id"]: f for f in fields or []}
    results = [evaluate(cfg, fields, a) for a in rows]
    has_rules = any(r["field_id"] in by_id for r in cfg["rules"])
    qualified = sum(1 for r in results if r["qualified"])
    per_rule = []
    for rule in cfg["rules"]:
        if rule["field_id"] not in by_id:
            continue
        hits = sum(1 for r in results if rule["id"] in r["matched"])
        per_rule.append({"id": rule["id"], "matched": hits, "text": describe_rule(rule, by_id[rule["field_id"]])})

    breakdown = []
    for f in fields or []:
        if f.get("type") not in ("choice", "select", "multi", "rating"):
            continue
        counts: dict[str, list[int]] = {}
        order = list(f.get("options") or []) or [str(n) for n in range(1, 6)]
        for o in order:
            counts[o] = [0, 0]
        answered = 0
        for a, res in zip(rows, results):
            chosen = _selected(str(a.get(f["id"]) or ""), f)
            if chosen:
                answered += 1
            for c in chosen:
                bucket = counts.setdefault(c, [0, 0])
                bucket[0] += 1
                if res["qualified"]:
                    bucket[1] += 1
        breakdown.append({
            "field_id": f["id"], "label": f.get("label") or f["id"], "answered": answered,
            "options": [{"value": k, "count": v[0], "qualified": v[1]} for k, v in counts.items()],
        })
    return {
        "total": len(rows),
        "qualified": qualified if has_rules else 0,
        "has_rules": has_rules,
        "rules": per_rule,
        "fields": breakdown,
    }
