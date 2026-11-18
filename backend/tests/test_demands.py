"""Painel de demandas: cadastro, quem ve o que e quem edita o que.

SQLite descartavel, sem docker e sem rede:

    cd backend && PYTHONPATH=$PWD ./.venv/bin/python tests/test_demands.py
"""
import asyncio, os, sys, tempfile, pathlib

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
from app.db import SessionLocal
from app.main import app
from app.models import WaNumber

ok = fail = 0
def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  ok   {label}")
    else:
        fail += 1; print(f"  FAIL {label} {extra}")

async def seed():
    async with SessionLocal() as s:
        a = WaNumber(label="Clinica A", phone_number_id="evo:a", channel="evolution", evo_instance="a")
        b = WaNumber(label="Loja B", phone_number_id="evo:b", channel="evolution", evo_instance="b")
        s.add_all([a, b]); await s.commit()
        return a.id, b.id

def login(c, user, pw):
    tok = c.post("/api/auth/login", json={"username": user, "password": pw}).json()
    return {"Authorization": f"Bearer {tok['access_token']}"}, tok["user"]["id"]

with TestClient(app) as c:
    a_id, b_id = asyncio.run(seed())
    H, admin_id = login(c, "gabriel", "senha-forte-123")
    for name in ("ana", "beto"):
        r = c.post("/api/auth/users", headers=H, json={"username": name, "password": "outra-senha-1", "role": "user",
                                                       "number_ids": [a_id] if name == "ana" else []})
        check(f"cria usuário {name}", r.status_code in (200, 201), r.text)
    AH, ana_id = login(c, "ana", "outra-senha-1")
    BH, beto_id = login(c, "beto", "outra-senha-1")

    check("sem token = 401", c.get("/api/demands").status_code == 401)
    check("painel começa vazio", c.get("/api/demands", headers=H).json() == [])

    r = c.post("/api/demands", headers=H, json={"title": "  Subir campanha de Black Friday ", "description": "3 criativos",
                                                "wa_number_id": a_id, "assignee_id": ana_id, "priority": "alta",
                                                "due_date": "2026-11-20"})
    d = r.json()
    check("gestor cadastra", r.status_code == 200 and d["title"] == "Subir campanha de Black Friday", r.text)
    check("traz cliente, responsável e criador", (d["number_label"], d["assignee_name"], d["created_by"]) == ("Clinica A", "ana", admin_id), d)
    check("nasce aberta, com prazo", d["status"] == "aberta" and d["due_date"] == "2026-11-20" and d["completed_at"] is None, d)
    did = d["id"]

    check("título vazio = 400", c.post("/api/demands", headers=H, json={"title": "   "}).status_code == 400)
    check("prioridade inválida = 400", c.post("/api/demands", headers=H, json={"title": "x", "priority": "ontem"}).status_code == 400)
    check("status inválido = 400", c.patch(f"/api/demands/{did}", headers=H, json={"status": "sumiu"}).status_code == 400)
    check("responsável inexistente = 400", c.post("/api/demands", headers=H, json={"title": "x", "assignee_id": 9999}).status_code == 400)
    check("cliente inexistente = 404", c.post("/api/demands", headers=H, json={"title": "x", "wa_number_id": 9999}).status_code == 404)

    # --- quem ve o que ---
    check("responsável vê a demanda", [x["id"] for x in c.get("/api/demands", headers=AH).json()] == [did])
    check("responsável não é dono", c.get("/api/demands", headers=AH).json()[0]["can_edit"] is False)
    check("quem não tem a ver não vê", c.get("/api/demands", headers=BH).json() == [])
    check("nem acessa por id (404)", c.patch(f"/api/demands/{did}", headers=BH, json={"status": "andamento"}).status_code == 404)
    check("nem apaga (404)", c.delete(f"/api/demands/{did}", headers=BH).status_code == 404)

    # --- responsavel: so o status ---
    r = c.patch(f"/api/demands/{did}", headers=AH, json={"status": "andamento"})
    check("responsável move o status", r.status_code == 200 and r.json()["status"] == "andamento", r.text)
    check("responsável não edita o resto", c.patch(f"/api/demands/{did}", headers=AH, json={"title": "outra"}).status_code == 403)
    check("responsável não apaga", c.delete(f"/api/demands/{did}", headers=AH).status_code == 403)
    r = c.patch(f"/api/demands/{did}", headers=AH, json={"status": "concluida"})
    check("concluir marca a data", r.json()["completed_at"] is not None, r.text)
    r = c.patch(f"/api/demands/{did}", headers=H, json={"status": "aberta"})
    check("reabrir limpa a data", r.json()["completed_at"] is None, r.text)

    # --- operacao cadastra as proprias ---
    r = c.post("/api/demands", headers=AH, json={"title": "Responder leads parados", "wa_number_id": a_id, "assignee_id": ana_id})
    mine = r.json()
    check("operação cadastra pra si", r.status_code == 200 and mine["can_edit"] is True, r.text)
    check("operação não atribui a outro", c.post("/api/demands", headers=AH, json={"title": "x", "assignee_id": beto_id}).status_code == 403)
    check("operação não usa cliente alheio", c.post("/api/demands", headers=AH, json={"title": "x", "wa_number_id": b_id}).status_code == 404)
    check("operação edita a própria", c.patch(f"/api/demands/{mine['id']}", headers=AH, json={"title": "Responder leads", "due_date": "2026-11-15"}).json()["due_date"] == "2026-11-15")
    check("gestor vê todas", len(c.get("/api/demands", headers=H).json()) == 2)

    # --- edicao do gestor ---
    r = c.patch(f"/api/demands/{did}", headers=H, json={"assignee_id": None, "due_date": None, "wa_number_id": b_id})
    d = r.json()
    check("gestor tira responsável e prazo, troca cliente", (d["assignee_id"], d["due_date"], d["number_label"]) == (None, None, "Loja B"), r.text)
    check("sem responsável, some pra ana", [x["id"] for x in c.get("/api/demands", headers=AH).json()] == [mine["id"]])

    # --- opcoes de responsavel ---
    check("gestor distribui pra todos", {u["name"] for u in c.get("/api/demands/options", headers=H).json()["users"]} >= {"ana", "beto"})
    check("operação só vê a si", [u["id"] for u in c.get("/api/demands/options", headers=AH).json()["users"]] == [ana_id])

    check("dono apaga", c.delete(f"/api/demands/{mine['id']}", headers=AH).status_code == 200)
    check("gestor apaga", c.delete(f"/api/demands/{did}", headers=H).status_code == 200)
    check("painel vazio de novo", c.get("/api/demands", headers=H).json() == [])

print(f"\n{ok} ok, {fail} falha(s)")
sys.exit(1 if fail else 0)
