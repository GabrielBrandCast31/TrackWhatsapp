"""Primeiro atendimento do formulario: a linha manda uma mensagem pro lead
depois do envio, com ou sem redirecionamento ao WhatsApp. Sem rede:

    cd backend && ./.venv/bin/python tests/test_first_contact.py
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'fc.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"
os.environ["GEMINI_API_KEY"] = ""

from httpx import ASGITransport, AsyncClient

from app import auth, forms
from app.db import SessionLocal, init_db
from app.main import app
from app.models import WaNumber

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
    {"id": "orc", "label": "Orçamento", "type": "choice", "options": ["Baixo", "Alto"]},
]
LEAD = "5531988881111"


def unit():
    print("configuração e texto")
    s = forms.clean_settings({"first_contact_delay": 99999, "first_contact_audience": "x",
                              "first_contact_message": "a" * 2000})
    check("espera limitada a 10 min", s["first_contact_delay"] == forms.FIRST_CONTACT_MAX_DELAY, s["first_contact_delay"])
    check("público inválido volta pra todos", s["first_contact_audience"] == "all")
    check("mensagem aceita até 1500", len(s["first_contact_message"]) == 1500)
    check("desligado por padrão", forms.clean_settings({})["first_contact_enabled"] is False)
    t = forms.first_contact_text("Oi, {nome}! ({nome_completo}) {formulario}", "Ana Souza", "Diagnóstico")
    check("variáveis trocadas", t == "Oi, Ana! (Ana Souza) Diagnóstico", t)
    check("sem nome some o vocativo", forms.first_contact_text("Olá, {nome}! Tudo bem?", "", "F") == "Olá! Tudo bem?")
    check("vazio usa a padrão", forms.first_contact_text("", "Ana", "F").startswith("Olá, Ana!"))
    on = {**forms.DEFAULT_SETTINGS, "first_contact_enabled": True, "first_contact_audience": "qualified"}
    check("só qualificados: barra o não qualificado", forms.first_contact_applies(on, False) is False)
    check("só qualificados: sem critério não barra", forms.first_contact_applies(on, None) is True)


async def main():
    unit()
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        a = WaNumber(label="Clínica A", phone_number_id="evo:a", channel="evolution", evo_instance="a", webhook_token="ta")
        s.add(a)
        await s.commit()
        A = a.id

    msgs: list[tuple[str, str]] = []

    async def fake_notify(session, number, phone, text):
        msgs.append((phone, text))

    async def noop(*a, **k):
        return None

    forms.send_notify = fake_notify
    forms.fix_wa_id = noop
    forms.send_capi_event = noop

    async def settle():
        for _ in range(50):
            await asyncio.sleep(0.02)
            if not forms._tasks:
                return

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        r = await http.post("/api/auth/login", json={"username": "admin", "password": "admin-senha-forte"})
        H = {"Authorization": f"Bearer {r.json()['access_token']}"}

        print("envio com redirecionamento ao WhatsApp")
        settings = {"first_contact_enabled": True, "first_contact_delay": 0,
                    "first_contact_message": "Olá, {nome}! Obrigado por responder o {formulario}.",
                    "whatsapp_redirect": True, "whatsapp_phone": "5531999990000"}
        f = (await http.post("/api/forms", headers=H, json={
            "title": "Diagnóstico", "wa_number_id": A, "fields": FIELDS, "settings": settings,
        })).json()
        check("configuração salva", f["settings"]["first_contact_enabled"] is True
              and f["settings"]["first_contact_delay"] == 0, f.get("settings"))
        pub = (await http.get(f"/api/forms/public/{f['slug']}")).json()
        check("página pública não expõe a mensagem", "first_contact_message" not in str(pub))
        sub = lambda slug, answers: http.post(f"/api/forms/public/{slug}/submit", json={"answers": answers})

        r = (await sub(f["slug"], {"nome": "Ana Souza", "zap": "31 98888-1111", "orc": "Alto"})).json()
        await settle()
        check("redireciona normalmente", r["redirect_url"].startswith("https://wa.me/5531999990000"), r)
        check("lead recebe o primeiro atendimento", msgs == [(LEAD, "Olá, Ana! Obrigado por responder o Diagnóstico.")], msgs)

        print("envio sem redirecionamento")
        await http.patch(f"/api/forms/{f['id']}", headers=H, json={"settings": {**f["settings"], "whatsapp_redirect": False}})
        msgs.clear()
        r = (await sub(f["slug"], {"nome": "Beto", "zap": "31 98888-1111", "orc": "Baixo"})).json()
        await settle()
        check("fica na tela de obrigado", not r["redirect_url"], r)
        check("lead recebe mesmo assim", len(msgs) == 1 and msgs[0][1].startswith("Olá, Beto!"), msgs)

        print("só qualificados + confirmação de não qualificado")
        await http.patch(f"/api/forms/{f['id']}", headers=H, json={
            "settings": {**f["settings"], "first_contact_audience": "qualified"},
            "qualification": {"enabled": True, "rules": [{"field_id": "orc", "op": "is_any", "values": ["Alto"]}],
                              "send_event": False},
        })
        msgs.clear()
        await sub(f["slug"], {"nome": "Caio", "zap": "31 98888-1111", "orc": "Baixo"})
        await settle()
        check("não qualificado não recebe", msgs == [], msgs)
        await sub(f["slug"], {"nome": "Duda", "zap": "31 98888-1111", "orc": "Alto"})
        await settle()
        check("qualificado recebe", len(msgs) == 1 and msgs[0][1].startswith("Olá, Duda!"), msgs)

        await http.patch(f"/api/forms/{f['id']}", headers=H, json={
            "settings": {**f["settings"], "first_contact_audience": "all"},
            "qualification": {"enabled": True, "rules": [{"field_id": "orc", "op": "is_any", "values": ["Alto"]}],
                              "send_event": False, "whatsapp_only_qualified": True, "notify_lead_unqualified": True},
        })
        msgs.clear()
        await sub(f["slug"], {"nome": "Edu", "zap": "31 98888-1111", "orc": "Baixo"})
        await settle()
        check("barrado com confirmação ligada: só uma mensagem", len(msgs) == 1
              and "Recebemos as suas respostas" in msgs[0][1], msgs)

        print("desligado")
        await http.patch(f"/api/forms/{f['id']}", headers=H, json={
            "settings": {**f["settings"], "first_contact_enabled": False}, "qualification": {"enabled": False}})
        msgs.clear()
        await sub(f["slug"], {"nome": "Fabi", "zap": "31 98888-1111", "orc": "Alto"})
        await settle()
        check("sem mensagem", msgs == [], msgs)

        print("teste pelo painel")
        r = await http.post("/api/forms/test-first-contact", headers=H, json={
            "wa_number_id": A, "phone": "31 97777-0000", "title": "Diagnóstico", "message": "Oi {nome}, {formulario}"})
        check("teste enviado com nome de exemplo", r.status_code == 200 and msgs[-1] == ("31 97777-0000", "Oi Maria, Diagnóstico"),
              (r.text, msgs[-1:]))
        r = await http.post("/api/forms/test-first-contact", headers=H, json={"wa_number_id": A, "phone": "123"})
        check("número curto recusado", r.status_code == 400, r.text)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
