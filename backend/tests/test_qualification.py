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

    async def fake_capi(form, event_name, event_id, nome, email, phone, ctx, custom_data=None, target=None):
        sent.append({"name": event_name, "id": event_id, "fbp": ctx.get("fbp"), "custom": custom_data, "target": target})

    forms.send_capi_event = fake_capi

    async def no_notify(*a, **k):
        return None

    real_notify, forms.send_notify = forms.send_notify, no_notify
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

        print("jornada: conteúdo, WhatsApp só pro qualificado e Pixel da linha")
        avisos: list[tuple[str, str]] = []

        async def fake_send(cfg, to, text):
            avisos.append((to, text))
            return {}

        async def fake_wa_id(cfg, wa_id):
            return wa_id

        from app.services import evolution
        evolution.send_text, evolution.whatsapp_id = fake_send, fake_wa_id
        forms.send_notify = real_notify
        async with SessionLocal() as s:
            line = await s.get(WaNumber, A)
            line.overrides = {"meta_dataset_id": "777", "meta_capi_token": "TK-LINHA"}
            await s.commit()
        lp = (await http.get(f"/api/forms/line-pixel?number_id={A}", headers=H)).json()
        check("painel enxerga o Pixel da linha, sem o token", lp == {"pixel_id": "777", "token_set": True}, lp)

        info = {"id": "aula", "label": "Por que isso importa", "type": "info", "content": "Quem mede, vende mais.",
                "media_url": "javascript:alert(1)", "required": True}
        j = (await http.post("/api/forms", headers=H, json={
            "title": "Jornada", "wa_number_id": A, "fields": [FIELDS[0], info, *FIELDS[1:]],
            "whatsapp_notify": "31 97777-0000", "thank_you": "Obrigado!",
            "settings": {"whatsapp_redirect": True, "whatsapp_phone": "5531999990000", "use_line_pixel": True,
                         "redirect_url": "https://wa.me/5531999990000"},
            "qualification": {"enabled": True, "rules": RULES, "whatsapp_only_qualified": True,
                              "unqualified_message": "Ainda não é o momento.",
                              "unqualified_redirect_url": "https://exemplo.com/guia",
                              "notify_lead_unqualified": True},
        })).json()
        tela = next(x for x in j["fields"] if x["id"] == "aula")
        check("tela de conteúdo salva, sem URL perigosa", tela["type"] == "info" and tela["content"] == "Quem mede, vende mais."
              and tela["media_url"] == "" and tela["required"] is False, tela)
        pub = (await http.get(f"/api/forms/public/{j['slug']}")).json()
        check("página pública usa o Pixel da linha", pub["pixel_id"] == "777", pub.get("pixel_id"))
        check("página pública não expõe os critérios", "qualification" not in pub)
        subj = lambda answers: http.post(f"/api/forms/public/{j['slug']}/submit", json={"answers": answers})

        n = len(sent)
        r = (await subj({"nome": "Duda", "zap": "31 98888-4444", "orc": "Acima de R$ 5 mil", "nota": "5"})).json()
        await settle()
        check("qualificado: vai pro WhatsApp na hora", r["redirect_url"].startswith("https://wa.me/5531999990000?text=")
              and r["thank_you"] == "Obrigado!", r)
        check("qualificado: evento do Pixel da linha no navegador", (r.get("qualified_event") or {}).get("name") == "QualifiedLead", r)
        check("CAPI sai com o Pixel e o token da linha",
              [e["name"] for e in sent[n:]] == ["Lead", "QualifiedLead"] and all(e["target"] == ("777", "TK-LINHA") for e in sent[n:]), sent[n:])
        check("qualificado: só o aviso da equipe", len(avisos) == 1 and avisos[0][0] == "5531977770000"
              and "Lead qualificado" in avisos[0][1] and "Não foi levado" not in avisos[0][1], avisos)

        avisos.clear()
        r = (await subj({"nome": "Edu Lima", "zap": "31 98888-5555", "orc": "Até R$ 1 mil", "nota": "5"})).json()
        await settle()
        check("não qualificado: sem WhatsApp, com a tela e o destino dele",
              r["redirect_url"] == "https://exemplo.com/guia" and r["thank_you"] == "Ainda não é o momento.", r)
        equipe = [t for to, t in avisos if to == "5531977770000"]
        lead = [t for to, t in avisos if to == "5531988885555"]
        check("não qualificado: equipe é avisada do preenchimento", len(equipe) == 1 and "Não foi levado ao WhatsApp" in equipe[0]
              and "Por que isso importa" not in equipe[0], avisos)
        check("não qualificado: lead recebe só a confirmação", len(lead) == 1 and lead[0].startswith("Olá, Edu!"), avisos)

        await http.patch(f"/api/forms/{j['id']}", headers=H, json={
            "qualification": {**j["qualification"], "whatsapp_only_qualified": False}})
        avisos.clear()
        r = (await subj({"nome": "Fabi", "zap": "31 98888-6666", "orc": "Até R$ 1 mil", "nota": "5"})).json()
        await settle()
        check("trava desligada: todo mundo vai pro WhatsApp", r["redirect_url"].startswith("https://wa.me/"), r)
        check("trava desligada: lead não recebe confirmação", all(to == "5531977770000" for to, _ in avisos), avisos)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
