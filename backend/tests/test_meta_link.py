"""Linha Evolution vinculada ao mesmo numero na Cloud API: qualidade e disparo oficial.

A Graph API e trocada por dubles (`whatsapp_cloud.*`): nada sai pra rede.

    cd backend && ./.venv/bin/python tests/test_meta_link.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'meta_link.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"

from httpx import ASGITransport, AsyncClient

from app import auth, broadcasts
from app.db import SessionLocal, init_db
from app.evolution_ingest import build_simulated_payload, ingest_event
from app.main import app
from app.models import WaNumber
from app.services import evolution, whatsapp_cloud

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


evo_sent: list[dict] = []
cloud_sent: list[tuple[dict, dict]] = []
info_cfgs: list[dict] = []


async def fake_evo_send(cfg, payload):
    evo_sent.append(payload)
    return 200, {"key": {"id": f"EVO{len(evo_sent)}"}}


async def fake_cloud_send(cfg, payload):
    cloud_sent.append((cfg, payload))
    return 200, {"messages": [{"id": f"wamid.{len(cloud_sent)}"}]}


async def fake_info(cfg):
    info_cfgs.append(cfg)
    return {
        "id": cfg["wa_phone_number_id"],
        "display_phone_number": "+55 11 90000-0000",
        "verified_name": "Clínica Irailton",
        "quality_rating": "YELLOW",
        "messaging_limit_tier": "TIER_1K",
        "status": "CONNECTED",
    }


async def fake_templates(cfg):
    return [{"name": "promo", "status": "APPROVED", "language": "pt_BR",
             "components": [{"type": "BODY", "text": "Oi {{1}}, promo!"}]}]


evolution.send_message = fake_evo_send
whatsapp_cloud.send_message = fake_cloud_send
whatsapp_cloud.phone_number_info = fake_info
whatsapp_cloud.message_templates = fake_templates
broadcasts.MIN_THROTTLE_SECONDS = 0


async def wait_worker(timeout=10):
    for _ in range(timeout * 20):
        if broadcasts._worker is None or broadcasts._worker.done():
            return
        await asyncio.sleep(0.05)


async def main():
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        line = WaNumber(label="Irailton", phone_number_id="evo:ira", channel="evolution",
                        evo_instance="ira", webhook_token="ti")
        s.add(line)
        await s.commit()
        L = line.id
        for wa, name in (("5511900000001", "Ana Lima"), ("5511900000002", "Bruno")):
            await ingest_event(s, build_simulated_payload(instance="ira", wa_id=wa, name=name, text="Oi",
                                                          ctwa_clid=None, ad_id=None, source_url=None), line)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        r = await http.post("/api/auth/login", json={"username": "admin", "password": "admin-senha-forte"})
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}

        print("sem vínculo")
        r = await http.post(f"/api/evolution/instances/{L}/quality", headers=h)
        check("qualidade pede o vínculo", r.status_code == 400, r.text)
        r = await http.get(f"/api/broadcasts/templates?number_id={L}", headers=h)
        check("sem templates", r.json() == [], r.text)
        r = await http.post("/api/broadcasts", headers=h, json={
            "number_id": L, "name": "x", "via": "cloud", "kind": "template", "template_name": "promo"})
        check("disparo oficial recusado", r.status_code == 400, r.text)

        print("vínculo")
        r = await http.patch(f"/api/evolution/instances/{L}", headers=h, json={"meta_phone_number_id": "+55 11 9"})
        check("telefone no lugar do ID é recusado", r.status_code == 400, r.text)
        r = await http.patch(f"/api/evolution/instances/{L}", headers=h, json={"meta_business_account_id": "../me"})
        check("WABA não numérico é recusado", r.status_code == 400, r.text)
        r = await http.patch(f"/api/evolution/instances/{L}", headers=h, json={"meta_phone_number_id": "123456789"})
        check("sem token próprio não vincula", not r.json()["meta_linked"], r.json())
        r = await http.post(f"/api/evolution/instances/{L}/quality", headers=h)
        check("sem token próprio não usa o global", r.status_code == 400 and not info_cfgs, r.text)
        r = await http.patch(f"/api/evolution/instances/{L}", headers=h, json={
            "meta_phone_number_id": "123456789", "meta_business_account_id": "999", "meta_access_token": "EAAtoken1234"})
        body = r.json()
        check("vinculada", body["meta_linked"] and body["meta_phone_number_id"] == "123456789", body)
        check("token mascarado", body["meta_access_token__set"] and body["meta_access_token__hint"] == "...1234"
              and "EAAtoken1234" not in r.text)
        check("roteamento Evolution intacto", body["instance"] == "ira")

        print("qualidade")
        r = await http.post(f"/api/evolution/instances/{L}/quality", headers=h)
        q = r.json()
        check("consulta com o ID real da Meta", info_cfgs[-1]["wa_phone_number_id"] == "123456789", info_cfgs[-1])
        check("usa token da linha", info_cfgs[-1]["wa_access_token"] == "EAAtoken1234")
        check("qualidade/tier/status", (q["quality_rating"], q["messaging_limit_tier"], q["meta_status"])
              == ("YELLOW", "TIER_1K", "CONNECTED"), q)
        r = await http.get("/api/evolution/instances", headers=h)
        row = next(i for i in r.json() if i["id"] == L)
        check("persistida na linha", row["quality_rating"] == "YELLOW" and row["quality_checked_at"], row)

        print("disparo")
        r = await http.get(f"/api/broadcasts/templates?number_id={L}", headers=h)
        check("templates do WABA", [t["name"] for t in r.json()] == ["promo"], r.text)
        r = await http.post("/api/broadcasts", headers=h, json={
            "number_id": L, "name": "Oficial", "via": "cloud", "kind": "template", "template_name": "promo",
            "template_language": "pt_BR", "template_params": ["{primeiro_nome}"],
            "throttle_seconds": 0, "jitter_seconds": 0, "window_start_hour": 0, "window_end_hour": 0, "start": True})
        check("campanha criada", r.status_code == 201 and r.json()["via"] == "cloud", r.text)
        await wait_worker()
        check("saiu pela Cloud API", len(cloud_sent) == 2 and not evo_sent, (len(cloud_sent), len(evo_sent)))
        cfg, payload = cloud_sent[0]
        check("envio pelo ID real", cfg["wa_phone_number_id"] == "123456789", cfg.get("wa_phone_number_id"))
        check("template com nome", payload["type"] == "template"
              and payload["template"]["components"][0]["parameters"][0]["text"] == "Ana", payload)

        r = await http.post("/api/broadcasts", headers=h, json={
            "number_id": L, "name": "Evo", "text": "Oi", "throttle_seconds": 0, "jitter_seconds": 0,
            "window_start_hour": 0, "window_end_hour": 0, "start": True})
        check("sem via, segue pela Evolution", r.status_code == 201 and r.json()["via"] is None, r.text)
        await wait_worker()
        check("saiu pela Evolution", len(evo_sent) == 2, len(evo_sent))

        print("desvincular")
        r = await http.patch(f"/api/evolution/instances/{L}", headers=h, json={"clear_meta_link": True})
        body = r.json()
        check("vínculo e qualidade apagados", not body["meta_linked"] and body["quality_rating"] is None
              and not body["meta_access_token__set"], body)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
