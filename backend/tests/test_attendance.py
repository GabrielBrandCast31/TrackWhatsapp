"""Funil de atendimento, tempo de resposta e analise com IA.

A API da Anthropic e trocada por um dublê (`ai_analysis.client_factory`): o
teste nao sai para a rede. Roda num SQLite temporario:

    cd backend && ./.venv/bin/python tests/test_attendance.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import asyncio, json, os, pathlib, sys, tempfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'attendance.db'}"

from httpx import ASGITransport, AsyncClient

from app import ai_analysis, attendance, auth, funnel
from app.db import SessionLocal, init_db
from app.evolution_ingest import build_simulated_payload, ingest_event
from app.main import app
from app.models import Contact, KeywordRule, WaNumber

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


T0 = datetime(2026, 9, 29, 14, 0, tzinfo=timezone.utc)


def at(minutes):
    return T0 + timedelta(minutes=minutes)


# --- dublê da API da Anthropic ---------------------------------------------
sent: list[dict] = []
REPLY = {
    "summary": "Lead pediu preço de implante e agendou avaliação para quinta às 15h.",
    "sentiment": "positivo",
    "temperature": "quente",
    "is_mql": True,
    "mql_reason": "Interesse concreto em implante e pediu horário.",
    "suggested_stage": "agendado",
    "stage_reason": "Horário confirmado pelo lead.",
    "score": 12,  # fora da escala: tem que ser limitado a 10
    "criteria": {k: 8 for k in ai_analysis.CRITERIA},
    "strengths": ["Respondeu rápido"],
    "improvements": ["Confirmar convênio antes"],
    "objections": ["preco", "inventada"],
    "objection_notes": "Achou caro.",
    "next_action": "Enviar lembrete na véspera.",
}


class FakeMessages:
    async def create(self, **kwargs):
        sent.append(kwargs)
        return SimpleNamespace(
            stop_reason="end_turn",
            model=kwargs["model"],
            usage=SimpleNamespace(input_tokens=900, output_tokens=300),
            content=[SimpleNamespace(type="text", text=json.dumps(REPLY))],
        )


def fake_factory(api_key):
    return SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages()))


ai_analysis.client_factory = fake_factory
app.dependency_overrides[auth.require_user] = lambda: None
app.dependency_overrides[auth.require_admin] = lambda: None


async def main():
    print("tempo de resposta")
    msgs = [("in", at(0)), ("in", at(1)), ("out", at(4)), ("in", at(10)), ("out", at(70)), ("in", at(80))]
    waits = attendance.waits_of(1, msgs)
    check("3 esperas (mensagens seguidas do cliente não abrem espera nova)", len(waits) == 3, len(waits))
    check("primeira resposta = 4 min", waits[0].first and waits[0].seconds == 240, waits[0])
    check("segunda resposta = 60 min", waits[1].seconds == 3600 and not waits[1].first)
    check("última espera sem resposta", waits[2].seconds is None)
    st = attendance.stats(waits, at(-1), now=at(90))
    check("mediana", st["responses"]["median_seconds"] == 1920, st["responses"])
    check("50% em até 5 min", st["within_5min"] == 0.5)
    check("1 aguardando agora há 10 min", st["waiting_now_count"] == 1 and st["waiting_now"][0]["seconds"] == 600)

    print("funil")
    c = Contact(wa_id="1", stage="novo")
    check("automático não pula de novo para agendado sem marcar anteriores",
          funnel.advance(c, "agendado", "rule", at(0)) and c.mql_at and c.conversation_at and c.scheduled_at)
    check("automático nunca rebaixa", not funnel.advance(c, "mql", "ai") and c.stage == "agendado")
    funnel.set_manual(c, "perdido")
    check("perdido continua contando até onde chegou", funnel.reached_rank(c) == funnel.RANK["agendado"])
    check("automático não reabre perdido", not funnel.advance(c, "fechado", "rule") and c.stage == "perdido")
    funnel.set_manual(c, "mql")
    check("correção manual para trás limpa marcos seguintes", c.scheduled_at is None and c.mql_at is not None)

    d = Contact(wa_id="2", stage="novo")
    funnel.on_attendant_message(d, at(0))
    funnel.on_customer_message(d, at(5))
    check("cliente respondeu sem ser MQL: não avança, guarda o sinal", d.stage == "novo" and d.customer_replied_at)
    funnel.advance(d, "mql", "ai")
    check("virou MQL com conversa em andamento: vai para conversando", d.stage == "conversando", d.stage)

    counts = funnel.funnel_counts([c, d, Contact(wa_id="3", stage="novo"), Contact(wa_id="4", stage="fechado", deal_value=1500)])
    by = {s["stage"]: s["count"] for s in counts["steps"]}
    check("funil cumulativo", by == {"novo": 4, "mql": 3, "conversando": 2, "agendado": 1, "compareceu": 1, "fechado": 1}, by)
    check("receita do fechamento", counts["revenue"] == 1500)

    await init_db()
    async with SessionLocal() as s:
        number = WaNumber(label="Clínica", phone_number_id="evo:c", channel="evolution", evo_instance="c", webhook_token="t")
        s.add(number)
        await s.commit()
        s.add(KeywordRule(wa_number_id=number.id, event_name="__none__", keyword="agendamento confirmado",
                          match_mode="exact", direction="attendant", set_stage="agendado",
                          require_attribution=True))
        await s.commit()

        print("webhook -> funil")
        seq = iter(range(100))

        def msg(text, from_me):
            # id e hora proprios: mensagens no mesmo segundo nao podem virar a mesma
            n = next(seq)
            p = build_simulated_payload(instance="c", wa_id="5511900000009", name="Maria", text=text,
                                        ctwa_clid=None, ad_id=None, source_url=None, from_me=from_me)
            p["data"]["key"]["id"] = f"T{n}"
            p["data"]["messageTimestamp"] += n * 60
            return p
        r = await ingest_event(s, msg("Oi, quanto custa implante?", False), number)
        cid = r["contact_ids"][0]
        await ingest_event(s, msg("Olá Maria! Fica R$ 2.500. Quer agendar?", True), number)
        await ingest_event(s, msg("Quero sim", False), number)
        contact = await s.get(Contact, cid)
        check("primeira resposta registrada", contact.first_response_at is not None)
        check("cliente continuou a conversa (sinal)", contact.customer_replied_at is not None)
        check("atendente não move mais para 'atendendo'", contact.stage == "novo", contact.stage)
        r = await ingest_event(s, msg("Agendamento confirmado para quinta 15h!", True), number)
        await s.refresh(contact)
        check("regra sem evento moveu para agendado (sem exigir ctwa_clid)", contact.stage == "agendado", (contact.stage, r["rules"]))
        check("agendado marca MQL e conversa", contact.mql_at and contact.conversation_at)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as http:
        print("IA")
        r = await http.post(f"/api/attendance/contact/{cid}/analyze")
        a = r.json()["analysis"]
        check("sem chave: análise com erro explicado", a["status"] == "error" and "chave" in a["error"].lower(), a)
        check("sem chave: não chama a API", not sent)

        await http.put("/api/attendance/ai-config", json={"anthropic_api_key": "sk-ant-test-1234", "auto_apply_stage": True})
        cfg = (await http.get("/api/attendance/ai-config")).json()
        check("chave salva e mascarada", cfg["configured"] and cfg["key_hint"] == "...1234" and "sk-ant" not in json.dumps(cfg))

        r = await http.post(f"/api/attendance/contact/{cid}/analyze")
        a = r.json()["analysis"]
        req = sent[-1]
        check("modelo claude-opus-5-5 com thinking adaptativo", req["model"] == "claude-opus-5-5" and req["thinking"] == {"type": "adaptive"})
        check("saída estruturada por JSON schema", req["output_config"]["format"]["type"] == "json_schema")
        check("fallback do servidor ligado", req["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in req["betas"])
        check("conversa vai como dado, com tempo de resposta",
              "<conversa>" in req["messages"][0]["content"] and "respondeu em" in req["messages"][0]["content"])
        check("nota limitada a 10", a["score"] == 10, a["score"])
        check("objeção fora do catálogo descartada", [o["key"] for o in a["objections"]] == ["preco"])
        check("etapa já alcançada não é reaplicada", a["applied_stage"] is None and r.json()["stage"] == "agendado")

        ov = (await http.get("/api/attendance/ai-overview")).json()
        check("visão geral conta a análise", ov["analyzed"] == 1 and ov["avg_score"] == 10 and ov["mql_rate"] == 1.0, ov)
        check("objeção agregada", ov["objections"][0]["label"] == "Preço")

        fn = (await http.get("/api/attendance/funnel")).json()
        steps = {s["stage"]: s["count"] for s in fn["steps"]}
        check("endpoint do funil", steps["agendado"] == 1 and steps["compareceu"] == 0, steps)

        rt = (await http.get("/api/attendance/response-times")).json()
        check("endpoint de tempo de resposta", rt["first_response"]["count"] == 1, rt["first_response"])

        r = await http.patch(f"/api/crm/contacts/{cid}", json={"stage": "fechado", "deal_value": 2500})
        fn = (await http.get("/api/attendance/funnel")).json()
        check("fechamento manual com valor", fn["revenue"] == 2500 and {s["stage"]: s["count"] for s in fn["steps"]}["compareceu"] == 1, fn["revenue"])

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
