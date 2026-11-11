"""Super admin: quem entra na tela, visao geral, relatorio e alerta de queda.

Roda contra um SQLite descartavel, sem docker e sem rede (o envio e trocado por
um dublê):

    cd backend && PYTHONPATH=$PWD ./.venv/bin/python tests/test_superadmin.py
"""
import asyncio, os, sys, tempfile, pathlib
from datetime import datetime

tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{tmp}/t.db"
os.environ["JWT_SECRET"] = "chave-de-teste-nao-usar-em-producao"
os.environ["ADMIN_USER"] = "gabriel"
os.environ["ADMIN_PASSWORD"] = "senha-forte-123"
os.environ["EVOLUTION_STATE_POLL_SECONDS"] = "0"
os.environ["CRM_AUTO_SYNC_SECONDS"] = "0"
os.environ["SUPER_REPORT_POLL_SECONDS"] = "0"
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from app import superadmin
from app.db import SessionLocal
from app.main import app
from app.models import Contact, WaNumber
from app.services import evolution

ok = fail = 0
def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  ok   {label}")
    else:
        fail += 1; print(f"  FAIL {label} {extra}")

sent = []
async def fake_send(cfg, to, text):
    sent.append((cfg.get("evo_instance"), to, text))
    return {"key": {"id": "X"}}
evolution.send_text = fake_send

async def seed():
    async with SessionLocal() as s:
        a = WaNumber(label="Clinica A", phone_number_id="evo:a", channel="evolution", evo_instance="a",
                     evo_base_url="http://evo", evo_api_key="k", evo_state="open", evo_owner_jid="5511911112222@s.whatsapp.net")
        b = WaNumber(label="Loja B", phone_number_id="evo:b", channel="evolution", evo_instance="b",
                     evo_base_url="http://evo", evo_api_key="k", evo_state="close", last_error="sessao encerrada")
        c = WaNumber(label="Pausada C", phone_number_id="evo:c", channel="evolution", evo_instance="c", active=False)
        s.add_all([a, b, c]); await s.flush()
        s.add_all([Contact(wa_id="551100000001", wa_number_id=a.id), Contact(wa_id="551100000002", wa_number_id=a.id),
                   Contact(wa_id="551100000003", wa_number_id=b.id)])
        await s.commit()
        return a.id, b.id

with TestClient(app) as c:
    a_id, b_id = asyncio.run(seed())
    tok = c.post("/api/auth/login", json={"username": "gabriel", "password": "senha-forte-123"}).json()
    H = {"Authorization": f"Bearer {tok['access_token']}"}
    check("bootstrap nasce super admin", tok["user"]["is_super"] is True, tok["user"])

    c.post("/api/auth/users", headers=H, json={"username": "socio", "password": "outra-senha-1", "role": "admin"})
    adm = c.post("/api/auth/login", json={"username": "socio", "password": "outra-senha-1"}).json()
    AH = {"Authorization": f"Bearer {adm['access_token']}"}
    check("admin comum não é super", adm["user"]["is_super"] is False)
    check("sem token = 401", c.get("/api/superadmin/overview").status_code == 401)
    check("admin comum barrado = 403", c.get("/api/superadmin/overview", headers=AH).status_code == 403)
    check("admin comum não lê a config", c.get("/api/superadmin/settings", headers=AH).status_code == 403)
    me_id, socio_id = tok["user"]["id"], adm["user"]["id"]
    check("admin comum não troca senha do super", c.patch(f"/api/auth/users/{me_id}", headers=AH, json={"password": "invadi-12345"}).status_code == 403)
    check("admin comum não apaga o super", c.delete(f"/api/auth/users/{me_id}", headers=AH).status_code == 403)
    check("admin comum não se promove", c.patch(f"/api/auth/users/{socio_id}", headers=AH, json={"is_super": True}).status_code == 403)
    check("último super não se rebaixa", c.patch(f"/api/auth/users/{me_id}", headers=H, json={"is_super": False}).status_code == 400)
    check("último super não vira operação", c.patch(f"/api/auth/users/{me_id}", headers=H, json={"role": "user"}).status_code == 400)
    r = c.patch(f"/api/auth/users/{socio_id}", headers=H, json={"is_super": True})
    check("super promove outro", r.status_code == 200 and r.json()["is_super"] is True, r.text)
    check("promovido entra na tela", c.get("/api/superadmin/overview", headers=AH).status_code == 200)
    r = c.patch(f"/api/auth/users/{socio_id}", headers=H, json={"role": "user"})
    check("rebaixar a operação tira o super", r.status_code == 200 and r.json()["is_super"] is False, r.text)

    r = c.get("/api/superadmin/overview", headers=H)
    check("overview responde", r.status_code == 200, r.text)
    o = r.json(); t = o["totals"]
    check("totais de linhas", (t["lines"], t["active"], t["connected"], t["disconnected"]) == (3, 2, 1, 1), t)
    check("leads somados", (t["leads_today"], t["leads_total"]) == (3, 3), t)
    check("fora do ar vem primeiro", o["lines"][0]["label"] == "Loja B" and o["lines"][-1]["label"] == "Pausada C", [l["label"] for l in o["lines"]])
    la = [l for l in o["lines"] if l["id"] == a_id][0]
    check("linha traz telefone e leads", la["phone"] == "+5511911112222" and la["leads_today"] == 2, la)

    text = c.get("/api/superadmin/report/preview", headers=H).json()["text"]
    check("relatório lista quem caiu com o motivo", "FORA DO AR" in text and "Loja B" in text and "sessao encerrada" in text, text)
    check("relatório lista conectados e pausados", "Clinica A" in text and "Pausada C" in text, text)

    r = c.post("/api/superadmin/report/send", headers=H)
    check("sem número cadastrado = 400", r.status_code == 400 and not sent, r.text)
    check("número inválido = 400", c.put("/api/superadmin/settings", headers=H, json={"report_phone": "123"}).status_code == 400)
    check("horário inválido = 400", c.put("/api/superadmin/settings", headers=H, json={"daily_time": "25:00"}).status_code == 400)
    r = c.put("/api/superadmin/settings", headers=H, json={"report_phone": "(11) 99999-8888", "daily_enabled": True, "daily_time": "08:00"})
    check("salva e normaliza o número", r.status_code == 200 and r.json()["report_phone"] == "5511999998888", r.text)
    r = c.put("/api/superadmin/settings", headers=H, json={"sender_number_id": b_id})
    check("aceita linha de envio", r.status_code == 200 and r.json()["sender_number_id"] == b_id and r.json()["daily_enabled"] is True, r.text)

    r = c.post("/api/superadmin/report/send", headers=H)
    check("envia agora", r.status_code == 200, r.text)
    check("linha preferida caída: sai pela conectada", sent and sent[-1][0] == "a" and sent[-1][1] == "5511999998888", sent[-1][:2] if sent else None)
    check("guarda quando enviou", r.json()["settings"]["last_sent_at"] and not r.json()["settings"]["last_error"])

    cfg = c.get("/api/superadmin/settings", headers=H).json()
    check("diário: antes da hora não sai", not superadmin.daily_due(cfg, datetime(2026, 1, 5, 7, 59)))
    check("diário: passou da hora sai", superadmin.daily_due(cfg, datetime(2026, 1, 5, 8, 0)))
    check("diário: não repete no mesmo dia", not superadmin.daily_due({**cfg, "last_daily_date": "2026-01-05"}, datetime(2026, 1, 5, 9, 0)))
    check("diário: desligado não sai", not superadmin.daily_due({**cfg, "daily_enabled": False}, datetime(2026, 1, 5, 9, 0)))

    tr = superadmin.StateTracker(down_rounds=2)
    check("primeira olhada só tira a foto", tr.update({1: ("A", True), 2: ("B", False)}) == ([], []))
    check("um soluço não alerta", tr.update({1: ("A", False), 2: ("B", False)}) == ([], []))
    check("caiu de vez: alerta uma vez", tr.update({1: ("A", False), 2: ("B", False)}) == (["A"], []))
    check("não repete o alerta", tr.update({1: ("A", False), 2: ("B", False)}) == ([], []))
    check("voltou: avisa (inclusive a que nasceu caída)", tr.update({1: ("A", True), 2: ("B", True)}) == ([], ["A", "B"]))

    n = len(sent)
    asyncio.run(superadmin.tick(superadmin.StateTracker()))
    check("tick manda o diário (hora já passou ou não)", len(sent) in (n, n + 1))
    asyncio.run(superadmin.tick(superadmin.StateTracker()))
    check("tick não manda dois diários no dia", len(sent) <= n + 1, len(sent) - n)

print(f"\n{ok} ok, {fail} falha(s)")
sys.exit(1 if fail else 0)
