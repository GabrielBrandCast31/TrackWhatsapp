"""Formulario de captacao: painel por linha, pagina publica, resposta -> lead
no CRM com a jornada ligada. Sem rede (a IA cai no modelo do metodo):

    cd backend && ./.venv/bin/python tests/test_forms.py
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'forms.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"
os.environ["GEMINI_API_KEY"] = ""

from httpx import ASGITransport, AsyncClient

from app import auth, journey
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


async def login(http, user, pw):
    r = await http.post("/api/auth/login", json={"username": user, "password": pw})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def main():
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        a = WaNumber(label="Clínica A", phone_number_id="evo:a", channel="evolution", evo_instance="a",
                     webhook_token="ta", site_key="KEYA", display_phone_number="+55 31 99999-0000")
        b = WaNumber(label="Clínica B", phone_number_id="evo:b", channel="evolution", evo_instance="b", webhook_token="tb")
        s.add_all([a, b])
        await s.commit()
        A, B = a.id, b.id

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        adm = await login(http, "admin", "admin-senha-forte")
        await http.post("/api/auth/users", headers=adm,
                        json={"username": "nicolas", "password": "nicolas-senha-1", "number_ids": [A]})
        nic = await login(http, "nicolas", "nicolas-senha-1")

        print("IA sem chave")
        fw = (await http.get("/api/forms/frameworks", headers=nic)).json()
        check("11 métodos de qualificação", len(fw["frameworks"]) == 11, len(fw["frameworks"]))
        d = (await http.post("/api/forms/ai-generate", headers=nic, json={"framework": "spin", "number_id": A})).json()
        check("sem Gemini: entrega o modelo do método", d["source"] == "modelo" and len(d["fields"]) >= 4, d.get("source"))

        print("painel")
        r = await http.post("/api/forms", headers=nic, json={"title": "Captação Implante", "wa_number_id": B})
        check("nicolas não cria formulário na linha B", r.status_code == 404, r.status_code)
        body = {
            "title": "Captação Implante", "wa_number_id": A, "headline": "Avaliação gratuita",
            "capi_token": "SEGREDO", "pixel_id": "123",
            "fields": [
                {"id": "nome", "label": "Seu nome", "type": "text"},
                {"id": "zap", "label": "WhatsApp", "type": "phone"},
                {"id": "quando", "label": "Quando?", "type": "choice", "options": ["Já", "Depois"]},
                {"id": "mail", "label": "E-mail", "type": "email", "required": False},
            ],
            "settings": {"whatsapp_redirect": True, "consent_enabled": True},
        }
        f = (await http.post("/api/forms", headers=nic, json=body)).json()
        check("formulário criado com slug", f["slug"].startswith("captacao-implante-"), f["slug"])
        check("token da CAPI não volta", f["capi_token"] == "" and f["capi_token__set"])
        slug = f["slug"]
        check("admin vê o formulário do nicolas", len((await http.get("/api/forms", headers=adm)).json()) == 1)
        await http.post("/api/auth/users", headers=adm, json={"username": "outra", "password": "outra-senha-12", "number_ids": [B]})
        outra = await login(http, "outra", "outra-senha-12")
        check("outra usuária não vê", (await http.get("/api/forms", headers=outra)).json() == [])
        check("outra usuária não abre por id", (await http.get(f"/api/forms/{f['id']}/responses", headers=outra)).status_code == 404)

        print("página pública")
        p = (await http.get(f"/api/forms/public/{slug}")).json()
        check("público sem login", p["headline"] == "Avaliação gratuita")
        check("público não expõe token nem webhook", "capi_token" not in p and "webhook_url" not in p["settings"])
        check("público leva a tag da jornada da linha", p["site_key"] == "KEYA")
        check("destino do WhatsApp = número da linha", p["whatsapp"]["phone"] == "5531999990000", p["whatsapp"])

        TL = "1790195601229_17901956838213"
        async with SessionLocal() as s:
            number = await s.get(WaNumber, A)
            s.add(journey.build_event(number, {"tl": TL, "event_name": "page_view", "page_url": f"https://x/f/{slug}?utm_source=google&utm_medium=cpc&utm_campaign=implante",
                                               "utm": {"source": "google", "medium": "cpc", "campaign": "implante"}}, None, None))
            await s.commit()

        sub = lambda answers, **kw: http.post(f"/api/forms/public/{slug}/submit", json={"answers": answers, **kw})
        r = await sub({"nome": "Maria", "zap": "(31) 98888-7777", "quando": "Já"})
        check("sem consentimento: recusa", r.status_code == 400 and "consentimento" in r.json()["detail"], r.text)
        r = await sub({"nome": "Maria", "zap": "123", "quando": "Já"}, consent=True)
        check("telefone inválido: recusa", r.status_code == 400, r.text)
        r = await sub({"nome": "Maria", "zap": "(31) 98888-7777", "quando": "Talvez"}, consent=True)
        check("opção fora da lista: recusa", r.status_code == 400, r.text)
        r = await sub({"nome": "Robô"}, website="spam")
        check("honeypot finge sucesso", r.status_code == 200)
        r = await sub({"nome": "Maria", "zap": "(31) 98888-7777", "quando": "Já", "mail": "maria@x.com"}, consent=True, tl=TL)
        out = r.json()
        check("envio aceito", r.status_code == 200 and out["ok"], r.text)
        check("redireciona pro WhatsApp com o tl", out["redirect_url"].startswith("https://wa.me/5531999990000") and "tl%3D" in out["redirect_url"], out["redirect_url"])
        await asyncio.sleep(0.2)

        async with SessionLocal() as s:
            c = (await s.execute(__import__("sqlalchemy").select(Contact))).scalars().first()
            check("lead criado no CRM da linha A", c is not None and c.wa_number_id == A and c.origin == "form", c and (c.wa_number_id, c.origin))
            check("nome e telefone do lead", c.name == "Maria" and c.wa_id == "5531988887777", (c.name, c.wa_id))
            check("respostas na nota", "Quando?: Já" in (c.note or ""))
            check("jornada ligada pelo TL_ID", c.transaction_id == TL and c.match_method == "transaction_id")
            check("origem recuperada (google)", (c.last_utm or {}).get("campaign") == "implante", c.last_utm)
            cid = c.id

        rs = (await http.get(f"/api/forms/{f['id']}/responses", headers=nic)).json()
        check("resposta listada com contato e tl", len(rs) == 1 and rs[0]["contact_id"] == cid and rs[0]["transaction_id"] == TL)
        cr = (await http.get(f"/api/forms/contact/{cid}", headers=nic)).json()
        check("respostas no painel do contato", cr[0]["form_title"] == "Captação Implante" and len(cr[0]["answers"]) == 4, cr)
        lst = (await http.get("/api/forms", headers=nic)).json()
        check("contador de visitas e leads", lst[0]["views"] == 1 and lst[0]["responses"] == 1, (lst[0]["views"], lst[0]["responses"]))
        ev = (await http.get(f"/api/journeys/{TL}", headers=nic)).json()
        check("form_submit na linha do tempo da jornada", any(e["event_name"] == "form_submit" for e in ev["events"]))

        await http.patch(f"/api/forms/{f['id']}", headers=nic, json={"active": False})
        check("pausado: link público some", (await http.get(f"/api/forms/public/{slug}")).status_code == 404)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
