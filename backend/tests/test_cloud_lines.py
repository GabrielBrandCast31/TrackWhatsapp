"""Linha da Cloud API cadastrada pela aba Conexao: qualquer usuario conecta,
mas so enxerga e mexe nas linhas dele. Sem rede (status/assinatura nao rodam):

    cd backend && ./.venv/bin/python tests/test_cloud_lines.py
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'cloud.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"

from httpx import ASGITransport, AsyncClient

from app import auth
from app.db import SessionLocal, init_db
from app.main import app

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

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        adm = await login(http, "admin", "admin-senha-forte")
        for name in ("ana", "bia"):
            await http.post("/api/auth/users", headers=adm,
                            json={"username": name, "password": f"{name}-senha-123", "role": "user", "number_ids": []})
        ana = await login(http, "ana", "ana-senha-123")
        bia = await login(http, "bia", "bia-senha-123")

        print("cadastro")
        r = await http.post("/api/cloud/lines", headers=ana,
                            json={"label": "Clínica Cloud", "phone_number_id": "123456", "access_token": "EAAG-secreto"})
        check("usuario de operacao cadastra linha Cloud", r.status_code == 201, r.text)
        line = r.json()
        check("token nao volta em claro", "EAAG-secreto" not in r.text and line["access_token__set"])
        check("verify token gerado e URL propria", bool(line["verify_token"]) and line["webhook_url"].endswith(f"/{line['id']}"))
        check("destinos do admin nao aparecem", "overrides" not in line)
        r = await http.post("/api/cloud/lines", headers=ana, json={"label": "x", "phone_number_id": "123456", "access_token": "t"})
        check("Phone Number ID repetido: recusado", r.status_code == 400)
        r = await http.post("/api/cloud/lines", headers=ana, json={"label": "x", "phone_number_id": "99"})
        check("sem token: recusado", r.status_code == 400)

        print("escopo")
        check("ana ve a linha", [l["id"] for l in (await http.get("/api/cloud/lines", headers=ana)).json()] == [line["id"]])
        check("bia nao ve", (await http.get("/api/cloud/lines", headers=bia)).json() == [])
        check("admin ve", len((await http.get("/api/cloud/lines", headers=adm)).json()) == 1)
        check("bia nao edita: 404", (await http.patch(f"/api/cloud/lines/{line['id']}", headers=bia, json={"label": "z"})).status_code == 404)
        check("bia nao testa: 404", (await http.get(f"/api/cloud/lines/{line['id']}/status", headers=bia)).status_code == 404)
        check("bia nao apaga: 404", (await http.delete(f"/api/cloud/lines/{line['id']}", headers=bia)).status_code == 404)
        check("rotas do admin continuam fechadas", (await http.get("/api/numbers", headers=ana)).status_code == 403)
        check("linha aparece no CRM da ana", (await http.get(f"/api/crm/contacts?number_id={line['id']}", headers=ana)).status_code == 200)

        print("edicao")
        r = await http.patch(f"/api/cloud/lines/{line['id']}", headers=ana, json={"label": "Novo nome", "access_token": ""})
        check("renomeia e token em branco mantem o atual", r.status_code == 200 and r.json()["label"] == "Novo nome"
              and r.json()["access_token__set"], r.text)
        r2 = await http.post("/api/cloud/lines", headers=bia, json={"label": "Da Bia", "phone_number_id": "777", "access_token": "t"})
        r = await http.patch(f"/api/cloud/lines/{line['id']}", headers=ana, json={"phone_number_id": "777"})
        check("trocar pro ID de outra linha: recusado sem revelar o dono",
              r.status_code == 400 and "Da Bia" not in r.text and r2.status_code == 201, r.text)
        r = await http.delete(f"/api/cloud/lines/{line['id']}", headers=ana)
        check("ana remove a propria linha", r.status_code == 204, r.text)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
