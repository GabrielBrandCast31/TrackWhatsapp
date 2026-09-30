"""Cada usuario so ve as linhas (clientes) dele; o admin ve todas.

Login de verdade (JWT), sem dublê de autenticacao — o que se testa e justamente
o filtro que a dependencia de login preenche. SQLite temporario:

    cd backend && ./.venv/bin/python tests/test_access.py
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'access.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"

from httpx import ASGITransport, AsyncClient

from app import auth
from app.db import SessionLocal, init_db
from app.evolution_ingest import build_simulated_payload, ingest_event
from app.main import app
from app.models import KeywordRule, WaNumber

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
        a = WaNumber(label="Clínica A", phone_number_id="evo:a", channel="evolution", evo_instance="a", webhook_token="ta")
        b = WaNumber(label="Clínica B", phone_number_id="evo:b", channel="evolution", evo_instance="b", webhook_token="tb")
        s.add_all([a, b])
        await s.commit()
        A, B = a.id, b.id
        for n, wa in ((a, "5511900000001"), (b, "5511900000002")):
            await ingest_event(s, build_simulated_payload(instance=n.evo_instance, wa_id=wa, name=f"Lead {n.label}",
                                                          text="Oi", ctwa_clid=None, ad_id=None, source_url=None), n)
        s.add(KeywordRule(wa_number_id=B, keyword="fechado", event_name="Purchase"))
        await s.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        adm = await login(http, "admin", "admin-senha-forte")
        r = await http.post("/api/auth/users", headers=adm,
                            json={"username": "nicolas", "password": "nicolas-senha-1", "role": "user", "number_ids": [A]})
        check("admin cria o nicolas com a linha A", r.status_code == 201 and r.json()["number_ids"] == [A], r.text)
        nicolas_id = r.json()["id"]
        nic = await login(http, "nicolas", "nicolas-senha-1")

        print("linhas")
        lines = (await http.get("/api/evolution/instances", headers=nic)).json()
        check("nicolas vê só a linha A", [l["id"] for l in lines] == [A], lines)
        lines = (await http.get("/api/evolution/instances", headers=adm)).json()
        check("admin vê as duas (o filtro do nicolas não vaza)", sorted(l["id"] for l in lines) == sorted([A, B]))
        r = await http.get(f"/api/evolution/instances/{B}/status", headers=nic)
        check("linha B por id: 404 pro nicolas", r.status_code == 404, r.status_code)

        print("conversas")
        rows = (await http.get("/api/crm/contacts", headers=nic)).json()
        check("CRM 'todas as linhas' do nicolas = só as dele", {c["wa_number_id"] for c in rows} == {A}, rows)
        other = [c for c in (await http.get("/api/crm/contacts", headers=adm)).json() if c["wa_number_id"] == B][0]
        check("conversa da B por id: 404", (await http.get(f"/api/crm/contacts/{other['id']}", headers=nic)).status_code == 404)
        check("responder conversa da B: 404",
              (await http.post(f"/api/crm/contacts/{other['id']}/reply", headers=nic, json={"text": "x"})).status_code == 404)
        check("mudar etapa da B: 404",
              (await http.patch(f"/api/crm/contacts/{other['id']}", headers=nic, json={"stage": "mql"})).status_code == 404)
        check("CRM filtrando pela B: 404",
              (await http.get(f"/api/crm/contacts?number_id={B}", headers=nic)).status_code == 404)
        check("análise IA da conversa da B: 404",
              (await http.get(f"/api/attendance/contact/{other['id']}", headers=nic)).status_code == 404)
        check("jornada da conversa da B: 404",
              (await http.get(f"/api/journeys/contact/{other['id']}", headers=nic)).status_code == 404)

        print("indicadores")
        st = (await http.get("/api/stats", headers=nic)).json()
        check("topo do nicolas conta só a A", st["contacts"] == 1 and st["numbers"] == 1, st)
        st = (await http.get("/api/stats", headers=adm)).json()
        check("topo do admin conta tudo", st["contacts"] == 2 and st["numbers"] == 2, st)
        fn = (await http.get("/api/attendance/funnel", headers=nic)).json()
        check("funil do nicolas", fn["total"] == 1, fn["total"])

        print("regras")
        rules = (await http.get("/api/rules", headers=nic)).json()
        check("regra da B não aparece", all(r["wa_number_id"] != B for r in rules), rules)
        r = await http.post("/api/rules", headers=nic, json={"keyword": "x", "wa_number_id": None})
        check("regra global: só admin", r.status_code == 403, r.status_code)
        r = await http.post("/api/rules", headers=nic, json={"keyword": "x", "wa_number_id": B})
        check("regra na linha B: 404", r.status_code == 404, r.status_code)
        r = await http.post("/api/rules", headers=nic, json={"keyword": "x", "wa_number_id": A})
        check("regra na própria linha: ok", r.status_code == 200, r.text)

        print("linha nova")
        r = await http.post("/api/evolution/instances", headers=nic,
                            json={"label": "Clínica C", "instance": "c", "base_url": "http://x", "api_key": "k"})
        C = r.json()["id"]
        lines = (await http.get("/api/evolution/instances", headers=nic)).json()
        check("quem cadastra a linha fica dono dela", sorted(l["id"] for l in lines) == sorted([A, C]), lines)

        r = await http.patch(f"/api/auth/users/{nicolas_id}", headers=adm, json={"number_ids": [B]})
        lines = (await http.get("/api/evolution/instances", headers=nic)).json()
        check("admin troca as linhas do nicolas e vale na hora", [l["id"] for l in lines] == [B], lines)
        check("nicolas não mexe em usuários", (await http.get("/api/auth/users", headers=nic)).status_code == 403)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
