"""Qualificacao de lead no formulario: criterios, classificacao manual, evento
QualifiedLead (CAPI) uma vez por resposta, MQL no CRM e simulacao. Sem rede:

    cd backend && ./.venv/bin/python tests/test_qualification.py
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'ql.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"
os.environ["GEMINI_API_KEY"] = ""

from httpx import ASGITransport, AsyncClient

from app import auth, forms
from app import qualification as ql
from app.db import SessionLocal, init_db
from app.main import app
from app.models import Contact, WaNumber

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


FIELDS = [
    {"id": "nome", "label": "Nome", "type": "text"},
    {"id": "zap", "label": "WhatsApp", "type": "phone"},
    {"id": "orc", "label": "Orçamento", "type": "choice", "options": ["Até R$ 1 mil", "R$ 1 a 5 mil", "Acima de R$ 5 mil"]},
    {"id": "canais", "label": "Canais", "type": "multi", "options": ["Instagram", "Google", "TikTok"], "required": False},
    {"id": "nota", "label": "Urgência", "type": "rating", "required": False},
]
RULES = [
    {"id": "r_orc", "field_id": "orc", "op": "is_any", "values": ["R$ 1 a 5 mil", "Acima de R$ 5 mil"], "points": 2},
    {"id": "r_nota", "field_id": "nota", "op": "gte", "value": "4", "points": 1},
]


def unit():
    print("motor de criterios")
    f = [{**x, "required": x.get("required", True), "options": x.get("options", [])} for x in FIELDS]
    cfg = {"enabled": True, "mode": "all", "rules": RULES}
    check("all: tudo bate", ql.evaluate(cfg, f, {"orc": "Acima de R$ 5 mil", "nota": "5"})["qualified"] is True)
    check("all: uma falha", ql.evaluate(cfg, f, {"orc": "Acima de R$ 5 mil", "nota": "2"})["qualified"] is False)
    check("any", ql.evaluate({**cfg, "mode": "any"}, f, {"orc": "Até R$ 1 mil", "nota": "5"})["qualified"] is True)
    r = ql.evaluate({**cfg, "mode": "score", "min_score": 2}, f, {"orc": "R$ 1 a 5 mil", "nota": "1"})
    check("score: 2 pontos qualifica", r["qualified"] is True and r["score"] == 2, r)
    check("desligado = sem classificação", ql.evaluate({**cfg, "enabled": False}, f, {})["qualified"] is None)
    m = {"enabled": True, "rules": [{"field_id": "canais", "op": "is_any", "values": ["Google"]}]}
    check("multi casa pela opção", ql.evaluate(m, f, {"canais": "Instagram, Google"})["qualified"] is True)
    n = {"enabled": True, "rules": [{"field_id": "nota", "op": "gte", "value": "1.500,00"}]}
    check("número no formato BR", ql.evaluate(n, f, {"nota": "2.000"})["qualified"] is True)
    c = ql.clean_config({"event_name": "nome com espaço", "mode": "x", "rules": [{"op": "zzz"}]})
    check("config inválida normaliza", c["event_name"] == "QualifiedLead" and c["mode"] == "all" and c["rules"] == [], c)


async def main():
    unit()
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        a = WaNumber(label="Clínica A", phone_number_id="evo:a", channel="evolution", evo_instance="a", webhook_token="ta")
        s.add(a)
        await s.commit()
        A = a.id

    sent: list[dict] = []

    async def fake_capi(form, event_name, event_id, nome, email, phone, ctx, custom_data=None):
        sent.append({"name": event_name, "id": event_id, "fbp": ctx.get("fbp"), "custom": custom_data})

    forms.send_capi_event = fake_capi

    async def no_notify(*a, **k):
        return None

    forms.send_notify = no_notify
    forms.fix_wa_id = no_notify

    async def settle():
        for _ in range(20):
            await asyncio.sleep(0.02)
            if not forms._tasks:
                return

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        r = await http.post("/api/auth/login", json={"username": "admin", "password": "admin-senha-forte"})
        H = {"Authorization": f"Bearer {r.json()['access_token']}"}

        print("formulário com critérios")
        f = (await http.post("/api/forms", headers=H, json={
            "title": "Diagnóstico", "wa_number_id": A, "fields": FIELDS, "pixel_id": "999", "capi_token": "TK",
            "qualification": {"enabled": True, "mode": "all", "rules": RULES, "event_name": "QualifiedLead"},
        })).json()
        check("critérios salvos", len(f["qualification"]["rules"]) == 2 and f["qualification"]["move_to_mql"], f.get("qualification"))
        slug = f["slug"]
        sub = lambda answers, **kw: http.post(f"/api/forms/public/{slug}/submit", json={"answers": answers, **kw})

        r = await sub({"nome": "Ana", "zap": "31 98888-1111", "orc": "Acima de R$ 5 mil", "nota": "5"}, fbp="fb.1.x", event_id="ev1")
        body = r.json()
        check("envio qualificado devolve evento pro Pixel", body.get("qualified_event", {}).get("name") == "QualifiedLead"
              and body["qualified_event"]["event_id"] == f"ql-{body['id']}", body)
        await settle()
        check("CAPI: QualifiedLead saiu com o fbp da visita",
              [e["name"] for e in sent] == ["Lead", "QualifiedLead"] and sent[1]["fbp"] == "fb.1.x", sent)
        check("CAPI: event_id fixo por resposta", sent[1]["id"] == f"ql-{body['id']}")

        r2 = (await sub({"nome": "Beto", "zap": "31 98888-2222", "orc": "Até R$ 1 mil", "nota": "5"})).json()
        await settle()
        check("não qualificado: sem evento no navegador", r2.get("qualified_event") is None, r2)
        check("não qualificado: só o Lead na CAPI", [e["name"] for e in sent].count("QualifiedLead") == 1, sent)

        rows = (await http.get(f"/api/forms/{f['id']}/responses", headers=H)).json()
        ana = next(x for x in rows if x["id"] == body["id"])
        beto = next(x for x in rows if x["id"] == r2["id"])
        check("resposta guarda a classificação", ana["qualified"] is True and ana["qualified_source"] == "auto"
              and ana["ql_event_status"] == "sent", ana)
        check("regra que falhou fica registrada", beto["qualified"] is False and "r_orc" in beto["qualification"]["failed"], beto)

        async with SessionLocal() as s:
            from sqlalchemy import select
            stages = {c.name: c.stage for c in (await s.execute(select(Contact))).scalars().all()}
        check("qualificado vai para MQL no CRM", stages.get("Ana") == "mql" and stages.get("Beto") == "novo", stages)

        print("classificação manual")
        r = await http.patch(f"/api/forms/{f['id']}/responses/{beto['id']}/qualification", headers=H, json={"qualified": True})
        j = r.json()
        check("manual: qualifica e dispara", r.status_code == 200 and j["qualified"] is True
              and j["qualified_source"] == "manual" and j["ql_event_status"] == "sent", r.text)
        check("manual: evento marcado como manual", sent[-1]["custom"]["qualification_source"] == "manual", sent[-1])
        n = len(sent)
        await http.patch(f"/api/forms/{f['id']}/responses/{beto['id']}/qualification", headers=H, json={"qualified": False})
        await http.patch(f"/api/forms/{f['id']}/responses/{beto['id']}/qualification", headers=H, json={"qualified": True})
        check("reclassificar não duplica o evento", len(sent) == n, sent[n:])
        r = await http.patch(f"/api/forms/{f['id']}/responses/{beto['id']}/qualification", headers=H, json={"qualified": None})
        check("None volta pro automático", r.json()["qualified"] is False and r.json()["qualified_source"] == "auto", r.text)

        print("simulação e reaplicação")
        sim = (await http.post(f"/api/forms/{f['id']}/qualification/simulate", headers=H, json={
            "qualification": {"mode": "any", "rules": [{"id": "x", "field_id": "nota", "op": "gte", "value": "5"}]},
        })).json()
        check("simulação conta quem qualificaria", sim["total"] == 2 and sim["qualified"] == 2, sim)
        orc = next(b for b in sim["fields"] if b["field_id"] == "orc")
        check("distribuição por opção", {o["value"]: o["count"] for o in orc["options"]}["Até R$ 1 mil"] == 1, orc)

        await http.patch(f"/api/forms/{f['id']}", headers=H, json={
            "qualification": {"enabled": True, "mode": "any", "rules": [{"field_id": "nota", "op": "gte", "value": "5"}]},
        })
        n = len(sent)
        rr = (await http.post(f"/api/forms/{f['id']}/qualification/reapply", headers=H)).json()
        check("reaplica nas automáticas", rr["evaluated"] == 2 and rr["changed"] == 1, rr)
        check("reaplicar não dispara evento", len(sent) == n)
        lst = (await http.get("/api/forms", headers=H)).json()
        check("lista mostra qualificados", lst[0]["qualified"] == 2, lst[0].get("qualified"))

        print("sem Pixel/token")
        g = (await http.post("/api/forms", headers=H, json={
            "title": "Sem pixel", "wa_number_id": A, "fields": FIELDS,
            "qualification": {"enabled": True, "rules": RULES},
        })).json()
        r = (await http.post(f"/api/forms/public/{g['slug']}/submit", json={"answers": {
            "nome": "Caio", "zap": "31 98888-3333", "orc": "Acima de R$ 5 mil", "nota": "4"}})).json()
        await settle()
        row = (await http.get(f"/api/forms/{g['id']}/responses", headers=H)).json()[0]
        check("sem Pixel: qualifica mas evento fica 'skipped'", row["qualified"] is True and row["ql_event_status"] == "skipped"
              and r.get("qualified_event") is None, row)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
