"""Conexao com o Facebook por OAuth: conectar linha, escolher ativos, Lead Ads,
vincular conta e "Entrar com Facebook".

A Graph API e trocada por funcoes falsas (nada sai pra rede); o resto e o app de
verdade, com login JWT e SQLite temporario:

    cd backend && ./.venv/bin/python tests/test_meta_oauth.py
"""
import asyncio, hashlib, hmac, json, os, pathlib, sys, tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote, urlsplit

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'meta.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"
os.environ["META_APP_ID"] = "111"
os.environ["META_APP_SECRET"] = "segredo-do-app"
os.environ["META_WEBHOOK_VERIFY_TOKEN"] = "verifica"
os.environ["PUBLIC_BASE_URL"] = "https://painel.exemplo.com"

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app import auth
from app.db import SessionLocal, init_db
from app.main import app
from app.models import Contact, MetaLead, WaNumber
from app.routers import meta as meta_router
from app.services import meta_oauth

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


# --- Graph API falsa -----------------------------------------------------------
FB = {"user": "fb-1", "name": "Gabriel FB", "token": "tok-1"}
SUBSCRIBED: list[str] = []
LEAD = {
    "id": "L1", "created_time": "2026-10-07T12:00:00+0000", "ad_id": "AD9", "ad_name": "Anúncio",
    "campaign_name": "Campanha", "form_id": "F1", "platform": "ig",
    "field_data": [{"name": "full_name", "values": ["Maria Lead"]},
                   {"name": "phone_number", "values": ["+55 11 91234-5678"]},
                   {"name": "email", "values": ["maria@x.com"]}],
}


async def fake_exchange(code):
    return {"access_token": FB["token"], "expires_at": datetime.now(timezone.utc) + timedelta(days=60),
            "fb_user_id": FB["user"], "fb_user_name": FB["name"], "scopes": list(meta_oauth.CONNECT_SCOPES)}


async def fake_accounts(token):
    return [{"id": "act_1", "name": "Conta 1", "business": None, "active": True}]


async def fake_pixels(token, act):
    return [{"id": "PX1", "name": "Pixel 1", "last_fired_time": None}] if act == "act_1" else []


async def fake_pages(token):
    return [{"id": "PG1", "name": "Página 1", "access_token": "page-tok", "tasks": []}]


async def fake_subscribe(page_id, page_token):
    SUBSCRIBED.append(page_id)


async def fake_unsubscribe(page_id, page_token):
    SUBSCRIBED.remove(page_id)


async def fake_lead(leadgen_id, page_token):
    return {**LEAD, "id": leadgen_id}


async def fake_forms(page_id, page_token):
    return [{"id": "F1", "name": "Form Captação"}]


async def fake_form_leads(form_id, page_token, limit=100):
    return [LEAD, {**LEAD, "id": "L2", "field_data": [{"name": "email", "values": ["sem@tel.com"]}]}]


meta_oauth.exchange_code = fake_exchange
meta_oauth.ad_accounts = fake_accounts
meta_oauth.pixels = fake_pixels
meta_oauth.pages = fake_pages
meta_oauth.subscribe_leadgen = fake_subscribe
meta_oauth.unsubscribe = fake_unsubscribe
meta_oauth.lead = fake_lead
meta_oauth.lead_forms = fake_forms
meta_oauth.form_leads = fake_form_leads


async def login(http, user, pw):
    r = await http.post("/api/auth/login", json={"username": user, "password": pw})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def state_of(url):
    return parse_qs(urlsplit(url).query)["state"][0]


def fragment(resp):
    frag = urlsplit(resp.headers["location"]).fragment
    return {k: unquote(v) for k, v in (p.split("=", 1) for p in frag.split("&") if "=" in p)}


async def main():
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        a = WaNumber(label="Clínica A", phone_number_id="evo:a", channel="evolution", evo_instance="a",
                     webhook_token="ta", overrides={"meta_capi_token": "manual-system-user"})
        b = WaNumber(label="Clínica B", phone_number_id="evo:b", channel="evolution", evo_instance="b", webhook_token="tb")
        s.add_all([a, b])
        await s.commit()
        A, B = a.id, b.id

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        adm = await login(http, "admin", "admin-senha-forte")
        await http.post("/api/auth/users", headers=adm,
                        json={"username": "operador", "password": "operador-senha", "role": "user", "number_ids": [A]})
        op = await login(http, "operador", "operador-senha")

        print("início do OAuth")
        st = (await http.get("/api/meta/status", headers=op)).json()
        check("redirect_uri sai do PUBLIC_BASE_URL", st["redirect_uri"] == "https://painel.exemplo.com/api/meta/oauth/callback", st)
        r = await http.post("/api/meta/oauth/start", headers=op, json={"purpose": "connect", "number_id": B})
        check("linha de outro cliente: 404", r.status_code == 404, r.status_code)
        r = await http.post("/api/meta/oauth/start", headers=op, json={"purpose": "connect", "number_id": A})
        url = r.json()["url"]
        check("URL do diálogo com escopos de anúncios e leads", "leads_retrieval" in unquote(url) and "ads_read" in unquote(url), url)
        check("sem token: 401", (await http.post("/api/meta/oauth/start", json={"purpose": "link"})).status_code == 401)

        print("callback")
        r = await http.get("/api/meta/oauth/callback", params={"state": "lixo", "code": "c"})
        check("state inválido não conecta", "meta_error" in fragment(r), r.headers.get("location"))
        r = await http.get("/api/meta/oauth/callback", params={"state": state_of(url), "error": "access_denied"})
        check("cancelou no Facebook", "cancelou" in fragment(r).get("meta_error", ""))
        r = await http.get("/api/meta/oauth/callback", params={"state": state_of(url), "code": "c"})
        check("conecta e volta pro painel", r.status_code == 302 and fragment(r).get("meta") == "connected", r.headers.get("location"))
        conn = (await http.get(f"/api/meta/lines/{A}", headers=op)).json()["connection"]
        check("status mostra a conta", conn and conn["fb_user_name"] == "Gabriel FB" and not conn["expired"], conn)
        check("token nunca volta pra tela", "access_token" not in json.dumps(conn))

        print("ativos")
        assets = (await http.get(f"/api/meta/lines/{A}/assets", headers=op)).json()
        check("lista contas e páginas", assets["ad_accounts"][0]["id"] == "act_1" and assets["pages"][0]["id"] == "PG1", assets)
        check("token da página não vaza", "page-tok" not in json.dumps(assets))
        r = await http.post(f"/api/meta/lines/{A}/select", headers=op, json={"pixel_id": "PX1"})
        check("pixel antes da conta: 400", r.status_code == 400, r.text)
        r = await http.post(f"/api/meta/lines/{A}/select", headers=op,
                            json={"ad_account_id": "act_1", "pixel_id": "PX1", "page_id": "PG1"})
        body = r.json()
        check("seleção salva", r.status_code == 200 and body["connection"]["pixel_id"] == "PX1", r.text)
        check("página inscrita no leadgen", SUBSCRIBED == ["PG1"] and body["connection"]["leads_subscribed"])
        async with SessionLocal() as s:
            ov = (await s.get(WaNumber, A)).overrides
        check("pixel vira override da linha", ov.get("meta_dataset_id") == "PX1", ov)
        check("token de anúncios preenchido pela conexão", ov.get("meta_ads_token") == "tok-1", ov)
        check("token manual da CAPI é preservado", ov.get("meta_capi_token") == "manual-system-user", ov)

        print("Lead Ads")
        payload = json.dumps({"object": "page", "entry": [{"id": "PG1", "changes": [
            {"field": "leadgen", "value": {"page_id": "PG1", "leadgen_id": "L1", "form_id": "F1"}}]}]}).encode()
        r = await http.post("/webhook/meta", content=payload, headers={"x-hub-signature-256": "sha256=errada"})
        check("webhook sem assinatura válida: 401", r.status_code == 401)
        sig = "sha256=" + hmac.new(b"segredo-do-app", payload, hashlib.sha256).hexdigest()
        r = await http.post("/webhook/meta", content=payload,
                            headers={"x-hub-signature-256": sig, "content-type": "application/json"})
        check("webhook aceito", r.status_code == 200 and r.json()["leads"] == 1, r.text)
        for _ in range(50):
            if not meta_router._tasks:
                break
            await asyncio.sleep(0.02)
        async with SessionLocal() as s:
            lead = (await s.execute(select(MetaLead).where(MetaLead.leadgen_id == "L1"))).scalar_one_or_none()
            contact = await s.get(Contact, lead.contact_id) if lead and lead.contact_id else None
        check("lead gravado", lead is not None and lead.platform == "instagram")
        check("virou conversa no CRM da linha", contact is not None and contact.wa_number_id == A and contact.origin == "lead_ads",
              contact and (contact.wa_number_id, contact.origin))
        check("anúncio vira atribuição", contact is not None and contact.source_id == "AD9" and contact.name == "Maria Lead")
        r = await http.get("/webhook/meta", params={"hub.mode": "subscribe", "hub.verify_token": "verifica", "hub.challenge": "42"})
        check("verificação do webhook", r.status_code == 200 and r.text == "42", r.text)

        r = await http.post(f"/api/meta/lines/{A}/leads/sync", headers=op)
        check("importar: não duplica o L1, grava o L2", r.json() == {"forms": 1, "seen": 2, "new": 1}, r.text)
        leads = (await http.get(f"/api/meta/lines/{A}/leads", headers=op)).json()
        check("lista de leads", len(leads) == 2 and any(l["contact_id"] is None for l in leads), leads)

        print("vincular e entrar com Facebook")
        r = await http.post("/api/meta/login/start")
        login_state = state_of(r.json()["url"])
        r = await http.get("/api/meta/oauth/callback", params={"state": login_state, "code": "c"})
        check("sem vínculo: login recusado", "fb_error" in fragment(r), r.headers.get("location"))
        r = await http.post("/api/meta/oauth/start", headers=op, json={"purpose": "link"})
        r = await http.get("/api/meta/oauth/callback", params={"state": state_of(r.json()["url"]), "code": "c"})
        check("vinculou", "fb_linked" in fragment(r), r.headers.get("location"))
        check("me mostra o vínculo", (await http.get("/api/auth/me", headers=op)).json()["facebook_linked"])
        r = await http.post("/api/meta/oauth/start", headers=adm, json={"purpose": "link"})
        r = await http.get("/api/meta/oauth/callback", params={"state": state_of(r.json()["url"]), "code": "c"})
        check("mesmo Facebook em outro usuário: recusado", "outro usuário" in fragment(r).get("link_error", ""))

        r = await http.get("/api/meta/oauth/callback", params={"state": login_state, "code": "c"})
        tok = fragment(r).get("fb_login")
        check("login devolve token curto", bool(tok), r.headers.get("location"))
        r = await http.post("/api/meta/login/exchange", json={"token": tok})
        check("troca por sessão do operador", r.status_code == 200 and r.json()["user"]["username"] == "operador", r.text)
        r = await http.post("/api/meta/login/exchange", json={"token": tok})
        check("token de login só vale uma vez", r.status_code == 401)
        r = await http.post("/api/meta/login/exchange", json={"token": state_of(url)})
        check("state não serve como login", r.status_code == 401)

        print("desconectar")
        await http.delete(f"/api/meta/lines/{A}", headers=op)
        async with SessionLocal() as s:
            ov = (await s.get(WaNumber, A)).overrides
        check("sai o token da conexão, fica o manual", "meta_ads_token" not in ov and ov.get("meta_capi_token") == "manual-system-user", ov)
        check("página desinscrita", SUBSCRIBED == [])
        check("status vazio", (await http.get(f"/api/meta/lines/{A}", headers=op)).json()["connection"] is None)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
