"""CRM da Cloud API: o webhook oficial da Meta alimenta o CRM da linha com o
mesmo resumo e a mesma classificacao de origem que a Evolution. Sem rede:

    cd backend && ./.venv/bin/python tests/test_cloud_crm.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import asyncio, hashlib, hmac, json, os, pathlib, sys, tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'cloud_crm.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app import auth
from app.db import SessionLocal, engine, init_db
from app.main import app
from app.migrations import upgrade
from app.models import Contact, Message, WaNumber

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


SECRET = "segredo-do-app"
PNID = "1029384756"
TL = "1790195601229_17901956838213"


def signed(payload: dict) -> tuple[bytes, dict]:
    raw = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return raw, {"x-hub-signature-256": sig, "content-type": "application/json"}


def cloud_payload(messages: list[dict], contacts: list[dict]) -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "WABA",
            "changes": [{
                "field": "messages",
                "value": {
                    "messaging_product": "whatsapp",
                    "metadata": {"display_phone_number": "5531900000000", "phone_number_id": PNID},
                    "contacts": contacts,
                    "messages": messages,
                },
            }],
        }],
    }


def msg(wa_id: str, wamid: str, text: str, ago: int, referral: dict | None = None) -> dict:
    m = {
        "from": wa_id,
        "id": wamid,
        "timestamp": str(int((datetime.now(timezone.utc) - timedelta(seconds=ago)).timestamp())),
        "type": "text",
        "text": {"body": text},
    }
    if referral:
        m["referral"] = referral
    return m


async def main():
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        cloud = WaNumber(label="Clínica Cloud", channel="cloud", phone_number_id=PNID, access_token="EAAG",
                         app_secret=SECRET, verify_token="vt", site_key="SITEKEY", active=True, overrides={})
        evo = WaNumber(label="Clínica Evo", channel="evolution", phone_number_id="evo:clinica",
                       evo_instance="clinica", webhook_token="tok", site_key="EVOKEY", active=True, overrides={})
        s.add_all([cloud, evo])
        await s.commit()
        cloud_id, evo_id = cloud.id, evo.id
        # conversa de outra linha: nao pode aparecer no CRM da Cloud
        s.add(Contact(wa_id="5531911112222", wa_number_id=evo_id, utm={}))
        await s.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        r = await http.post("/api/auth/login", json={"username": "admin", "password": "admin-senha-forte"})
        adm = {"Authorization": f"Bearer {r.json()['access_token']}"}

        # visita no site com UTM antes de clicar no WhatsApp
        base = {"k": "SITEKEY", "tl": TL, "visitor_id": "v1", "session_id": "s1",
                "page_url": "https://clinica.com.br/?utm_source=facebook&utm_medium=social&utm_campaign=implante",
                "page_path": "/", "landing_page": "/", "hostname": "clinica.com.br"}
        for name, ago in (("page_view", 600), ("click_whatsapp", 120)):
            await http.post("/t/collect", content=json.dumps({
                **base, "event_name": name,
                "event_time": (datetime.now(timezone.utc) - timedelta(seconds=ago)).isoformat(),
                "utm": {"source": "facebook", "medium": "social", "campaign": "implante"},
                "first_touch": {"source": "facebook", "medium": "social", "campaign": "implante"},
            }))

        print("webhook da Cloud API")
        payload = cloud_payload(
            [
                msg("5531988887777", "wamid.SITE1", f"Olá! Quero saber do implante.\n\ntl={TL}", 60),
                msg("5531977776666", "wamid.AD1", "Vi o anúncio", 50, referral={
                    "source_url": "https://fb.me/abc", "source_id": "120200000001", "source_type": "ad",
                    "headline": "Implante em 1 dia", "body": "Fale conosco", "ctwa_clid": "CLID123",
                }),
                msg("5531966665555", "wamid.UTM1",
                    "Oi, vim por https://clinica.com.br/?utm_source=google&utm_campaign=busca", 40),
            ],
            [{"wa_id": "5531988887777", "profile": {"name": "Maria"}},
             {"wa_id": "5531977776666", "profile": {"name": "João"}},
             {"wa_id": "5531966665555", "profile": {"name": "Ana"}}],
        )
        raw, headers = signed(payload)
        r = await http.post("/webhook/whatsapp", content=raw, headers=headers)
        check("webhook aceito", r.status_code == 200 and r.json().get("messages") == 3, r.text)
        check("resumo cita a jornada", "jornada do site" in (r.json().get("summary") or ""), r.json().get("summary"))

        # reentrega da Meta: nada duplica, nao-lido nao sobe de novo
        await http.post("/webhook/whatsapp", content=raw, headers=headers)

        print("CRM da linha Cloud")
        r = await http.get(f"/api/crm/contacts?number_id={cloud_id}", headers=adm)
        rows = {c["wa_id"]: c for c in r.json()}
        check("só as conversas da linha Cloud", set(rows) == {"5531988887777", "5531977776666", "5531966665555"},
              list(rows))

        maria, joao, ana = rows.get("5531988887777", {}), rows.get("5531977776666", {}), rows.get("5531966665555", {})
        check("última mensagem preenchida", bool(maria.get("last_message_at")) and "implante" in (maria.get("last_message_body") or ""))
        check("não-lida conta 1 mesmo com reentrega", maria.get("unread_count") == 1, maria.get("unread_count"))
        check("última mensagem é do cliente", maria.get("last_message_from_me") is False)
        check("origem webhook", maria.get("origin") == "webhook")

        check("lead do site ligado ao TL_ID", maria.get("journey", {}).get("transaction_id") == TL, maria.get("journey"))
        check("UTM da jornada no lead", (maria.get("source") or {}).get("utm", {}).get("utm_campaign") == "implante",
              maria.get("source"))

        check("lead do anúncio classificado como Meta Ads", joao.get("source", {}).get("channel") == "meta_ads",
              joao.get("source"))
        check("ctwa_clid gravado", joao.get("attribution", {}).get("ctwa_clid") == "CLID123")
        check("campanha pendente (sem token de anúncios)", joao.get("source", {}).get("campaign_status") == "pending")

        check("UTM do link na mensagem", ana.get("attribution", {}).get("utm", {}).get("utm_source") == "google",
              ana.get("attribution"))
        check("canal classificado pela UTM", ana.get("source", {}).get("channel") in ("google_ads", "utm"),
              ana.get("source"))

        r = await http.get(f"/api/crm/pipeline?number_id={cloud_id}", headers=adm)
        pipe = r.json()
        check("pipeline: 3 conversas, 1 de anúncio, 3 não lidas",
              (pipe["total"], pipe["attributed"], pipe["unread"]) == (3, 1, 3), pipe)

        r = await http.get(f"/api/crm/campaigns?number_id={cloud_id}", headers=adm)
        channels = {g["channel"] for g in r.json()["groups"]}
        check("resumo por origem com o anúncio", "meta_ads" in channels, channels)

        r = await http.patch(f"/api/crm/contacts/{maria['id']}", headers=adm, json={"stage": "mql", "mark_read": True})
        check("etapa e lida pelo CRM", r.status_code == 200 and r.json()["stage"] == "mql" and r.json()["unread_count"] == 0)

        r = await http.post(f"/api/crm/contacts/{maria['id']}/reply", headers=adm, json={"text": "oi"})
        check("resposta pelo CRM recusada na Cloud", r.status_code == 400, r.text)

    print("migração: conversa antiga sem resumo")
    async with SessionLocal() as s:
        old = Contact(wa_id="5531955554444", wa_number_id=cloud_id, utm={})
        s.add(old)
        await s.flush()
        s.add(Message(contact_id=old.id, direction="in", msg_type="text", body="primeira",
                      sent_at=datetime.now(timezone.utc) - timedelta(days=2)))
        s.add(Message(contact_id=old.id, direction="in", msg_type="text", body="segunda",
                      sent_at=datetime.now(timezone.utc) - timedelta(days=1)))
        evo_old = Contact(wa_id="5531944443333", wa_number_id=evo_id, utm={})
        s.add(evo_old)
        await s.flush()
        s.add(Message(contact_id=evo_old.id, direction="in", msg_type="text", body="evo",
                      sent_at=datetime.now(timezone.utc)))
        await s.commit()
        old_id, evo_old_id = old.id, evo_old.id

    async with engine.begin() as conn:
        await conn.run_sync(upgrade)

    async with SessionLocal() as s:
        old = await s.get(Contact, old_id)
        evo_old = await s.get(Contact, evo_old_id)
        check("conversa Cloud antiga ganha a última mensagem", old.last_message_body == "segunda" and old.last_message_at,
              (old.last_message_body, old.last_message_at))
        check("conversa da Evolution não é tocada", evo_old.last_message_at is None)
        total = len((await s.execute(select(Message).where(Message.contact_id == old_id))).scalars().all())
        check("migração não cria mensagem", total == 2)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
