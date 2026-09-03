"""Fumaca do login: bootstrap, 401 sem token, papeis, refresh, troca de senha.

Roda contra um SQLite descartavel, sem docker e sem rede:

    cd backend && PYTHONPATH=$PWD ./.venv/bin/python tests/test_auth.py

Sai com codigo 1 se qualquer checagem falhar — da pra chamar num deploy.
"""
import asyncio, os, sys, tempfile, pathlib

tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{tmp}/t.db"
os.environ["JWT_SECRET"] = "chave-de-teste-nao-usar-em-producao"
os.environ["ADMIN_USER"] = "gabriel"
os.environ["ADMIN_PASSWORD"] = "senha-forte-123"
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from app.main import app

ok = fail = 0
def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  ok   {label}")
    else:
        fail += 1; print(f"  FAIL {label} {extra}")

with TestClient(app) as c:
    check("health é público", c.get("/api/health").status_code == 200)
    # a Evolution e a Meta chamam sem login: o webhook se autentica sozinho
    # (token na URL / assinatura), então não pode responder 401 por falta de sessão
    r = c.post("/webhook/evolution", json={"instance": "nao-existe", "event": "x"})
    check("webhook segue público", r.status_code != 401, r.status_code)
    r = c.get("/api/stats")
    check("stats sem token = 401", r.status_code == 401, r.status_code)
    check("contacts sem token = 401", c.get("/api/contacts").status_code == 401)
    check("config sem token = 401", c.get("/api/config").status_code == 401)
    check("evolution sem token = 401", c.get("/api/evolution/instances").status_code == 401)

    r = c.post("/api/auth/login", json={"username": "gabriel", "password": "errada"})
    check("senha errada = 401", r.status_code == 401, r.text)
    r = c.post("/api/auth/login", json={"username": "gabriel", "password": "senha-forte-123"})
    check("login ok", r.status_code == 200, r.text)
    tok = r.json()
    check("devolve access+refresh", "access_token" in tok and "refresh_token" in tok)
    check("papel admin no bootstrap", tok["user"]["role"] == "admin", tok["user"])
    H = {"Authorization": f"Bearer {tok['access_token']}"}

    check("stats com token", c.get("/api/stats", headers=H).status_code == 200)
    check("me", c.get("/api/auth/me", headers=H).json()["username"] == "gabriel")
    check("token adulterado = 401", c.get("/api/stats", headers={"Authorization": "Bearer " + tok["access_token"][:-2] + "xy"}).status_code == 401)

    r = c.post("/api/auth/refresh", json={"refresh_token": tok["refresh_token"]})
    check("refresh troca por novo access", r.status_code == 200 and "access_token" in r.json(), r.text)
    check("access não serve de refresh", c.post("/api/auth/refresh", json={"refresh_token": tok["access_token"]}).status_code == 401)

    r = c.post("/api/auth/users", headers=H, json={"username": "operador", "password": "outra-senha-1", "role": "user"})
    check("cria usuário de operação", r.status_code == 201, r.text)
    check("username curto recusado", c.post("/api/auth/users", headers=H, json={"username": "ab", "password": "senha-boa-123", "role": "user"}).status_code == 400)
    check("senha curta recusada", c.post("/api/auth/users", headers=H, json={"username": "curta", "password": "123", "role": "user"}).status_code == 400)
    check("username duplicado = 409", c.post("/api/auth/users", headers=H, json={"username": "operador", "password": "outra-senha-1", "role": "user"}).status_code == 409)

    op = c.post("/api/auth/login", json={"username": "operador", "password": "outra-senha-1"}).json()
    OH = {"Authorization": f"Bearer {op['access_token']}"}
    check("operação entra no painel", c.get("/api/stats", headers=OH).status_code == 200)
    check("operação barrada em /api/config", c.get("/api/config", headers=OH).status_code == 403)
    check("operação barrada no cadastro", c.get("/api/auth/users", headers=OH).status_code == 403)
    check("operação não cria usuário", c.post("/api/auth/users", headers=OH, json={"username": "z", "password": "seila-1234", "role": "admin"}).status_code == 403)

    op_id = [u for u in c.get("/api/auth/users", headers=H).json() if u["username"] == "operador"][0]["id"]
    check("admin desativa operação", c.patch(f"/api/auth/users/{op_id}", headers=H, json={"active": False}).status_code == 200)
    check("token de desativado morre na hora", c.get("/api/stats", headers=OH).status_code == 401)
    check("desativado não loga", c.post("/api/auth/login", json={"username": "operador", "password": "outra-senha-1"}).status_code == 401)

    me_id = tok["user"]["id"]
    check("último admin não se rebaixa", c.patch(f"/api/auth/users/{me_id}", headers=H, json={"role": "user"}).status_code == 400)
    check("último admin não se desativa", c.patch(f"/api/auth/users/{me_id}", headers=H, json={"active": False}).status_code == 400)
    check("admin não se apaga", c.delete(f"/api/auth/users/{me_id}", headers=H).status_code == 400)

    r = c.post("/api/auth/password", headers=H, json={"current_password": "errada", "new_password": "nova-senha-99"})
    check("troca de senha exige a atual", r.status_code == 400, r.text)
    r = c.post("/api/auth/password", headers=H, json={"current_password": "senha-forte-123", "new_password": "nova-senha-99"})
    check("troca de senha ok", r.status_code == 200, r.text)
    check("token antigo morre na troca", c.get("/api/stats", headers=H).status_code == 401)
    NH = {"Authorization": f"Bearer {r.json()['access_token']}"}
    check("token novo vale", c.get("/api/stats", headers=NH).status_code == 200)
    check("entra com a senha nova", c.post("/api/auth/login", json={"username": "gabriel", "password": "nova-senha-99"}).status_code == 200)

    for i in range(9):
        c.post("/api/auth/login", json={"username": "brute", "password": f"tent{i}"})
    check("força bruta leva 429", c.post("/api/auth/login", json={"username": "brute", "password": "x"}).status_code == 429)

print(f"\n{ok} ok, {fail} falha(s)")
sys.exit(1 if fail else 0)
