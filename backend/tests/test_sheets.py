"""Planilha do Google Sheets por formulario (Apps Script). Sem rede:

    cd backend && ./.venv/bin/python tests/test_sheets.py
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'sh.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"
os.environ["GEMINI_API_KEY"] = ""

from httpx import ASGITransport, AsyncClient

from app import auth, forms, sheets
from app.db import init_db, SessionLocal
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


URL = "https://script.google.com/macros/s/AKfycbxABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/exec"
FIELDS = [
    {"id": "nome", "label": "Nome", "type": "text"},
    {"id": "zap", "label": "WhatsApp", "type": "phone"},
    {"id": "orc", "label": "Orçamento", "type": "choice", "options": ["Baixo", "Alto"]},
]


def unit():
    print("unidade")
    check("URL /exec válida", sheets.valid_url(URL))
    check("URL Workspace válida", sheets.valid_url(URL.replace("/macros/", "/a/macros/empresa.com.br/")))
    check("URL /dev recusada", not sheets.valid_url(URL.replace("/exec", "/dev")))
    check("outro host recusado", not sheets.valid_url("https://evil.com/macros/s/AKfycbxABCDEFGHIJKLMNOPQRST/exec"))
    cols = sheets.build_columns(
        form_title="F", response_id=1, created_at=None,
        fields=[{"id": "a", "label": "Nome"}, {"id": "b", "label": "Nome"}], answers={"a": "x", "b": "y"},
        qualified=False, page_url="https://s.com/?utm_source=meta&utm_campaign=c1",
    )
    d = dict(cols)
    check("rótulo repetido não sobrescreve", d.get("Nome") == "x" and d.get("Nome (2)") == "y", cols)
    check("UTM da URL quando não há jornada", d["utm_source"] == "meta" and d["utm_campaign"] == "c1", d)
    check("qualificado em texto", d["Qualificado"] == "Não")
    s = sheets.apps_script("SEGREDO123456789012")
    check("script leva o segredo", 'const SECRET = "SEGREDO123456789012"' in s)
    check("script neutraliza fórmula", "function safe" in s)


async def main():
    unit()
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        a = WaNumber(label="A", phone_number_id="evo:a", channel="evolution", evo_instance="a", webhook_token="ta")
        s.add(a)
        await s.commit()
        A = a.id

    calls = []
    fail_next = {"on": False}

    async def fake_append(url, secret, tab, columns):
        if fail_next["on"]:
            raise sheets.SheetsError("Segredo não confere")
        calls.append({"url": url, "secret": secret, "tab": tab, "cols": dict(columns)})
        return {"ok": True, "row": len(calls) + 1}

    sheets.append_row = fake_append

    async def noop(*a, **k):
        return None

    forms.send_notify = noop
    forms.fix_wa_id = noop

    async def settle():
        for _ in range(30):
            await asyncio.sleep(0.02)
            if not forms._tasks:
                return

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        r = await http.post("/api/auth/login", json={"username": "admin", "password": "admin-senha-forte"})
        H = {"Authorization": f"Bearer {r.json()['access_token']}"}

        print("configuração")
        f = (await http.post("/api/forms", headers=H, json={
            "title": "Planilha", "wa_number_id": A, "fields": FIELDS,
            "settings": {"sheets_enabled": True, "sheets_url": URL, "sheets_tab": "Leads"},
        })).json()
        secret = f["settings"]["sheets_secret"]
        check("segredo gerado ao ligar", len(secret) >= 16, f["settings"])
        pub = (await http.get(f"/api/forms/public/{f['slug']}")).json()
        check("segredo e URL fora da página pública",
              "sheets_secret" not in pub["settings"] and "sheets_url" not in pub["settings"], pub["settings"])
        g = (await http.patch(f"/api/forms/{f['id']}", headers=H, json={
            "settings": {**f["settings"], "sheets_url": "https://evil.com/x"}})).json()
        check("URL fora do Apps Script é descartada", g["settings"]["sheets_url"] == "")
        check("segredo se mantém ao salvar", g["settings"]["sheets_secret"] == secret)
        await http.patch(f"/api/forms/{f['id']}", headers=H, json={"settings": f["settings"]})

        sc = (await http.get(f"/api/forms/sheets-script?secret={secret}", headers=H)).json()
        check("script pronto com o segredo", secret in sc["script"])

        print("teste antes de salvar")
        r = await http.post("/api/forms/sheets-test", headers=H, json={
            "wa_number_id": A, "url": URL, "secret": secret, "tab": "Leads", "title": "Planilha", "fields": FIELDS})
        check("linha de teste", r.status_code == 200 and calls[-1]["cols"]["Formulário"] == "Planilha (TESTE)", r.text)

        print("resposta vira linha")
        n = len(calls)
        r = await http.post(f"/api/forms/public/{f['slug']}/submit", json={
            "answers": {"nome": "Ana", "zap": "31 98888-1111", "orc": "Alto"},
            "url": "https://lp.com/?utm_source=google&utm_medium=cpc"})
        rid = r.json()["id"]
        await settle()
        row = calls[-1] if len(calls) > n else {}
        check("linha enviada com segredo e aba", row.get("secret") == secret and row.get("tab") == "Leads", row)
        check("colunas por pergunta", row.get("cols", {}).get("Orçamento") == "Alto"
              and row["cols"]["Resposta #"] == str(rid), row)
        check("UTM da página", row.get("cols", {}).get("utm_source") == "google", row)
        resp = (await http.get(f"/api/forms/{f['id']}/responses", headers=H)).json()[0]
        check("status 'sent' na resposta", resp["sheets_status"] == "sent", resp)

        print("falha e reenvio")
        fail_next["on"] = True
        await http.post(f"/api/forms/public/{f['slug']}/submit", json={
            "answers": {"nome": "Beto", "zap": "31 98888-2222", "orc": "Baixo"}})
        await settle()
        resp = (await http.get(f"/api/forms/{f['id']}/responses", headers=H)).json()[0]
        check("falha registrada sem perder o lead", resp["sheets_status"] == "failed" and "Segredo" in resp["sheets_error"], resp)
        fail_next["on"] = False
        r = await http.post(f"/api/forms/{f['id']}/responses/{resp['id']}/sheets", headers=H)
        check("reenvio grava", r.status_code == 200 and r.json()["sheets_status"] == "sent", r.text)

        print("desligado")
        off = {**f["settings"], "sheets_enabled": False}
        await http.patch(f"/api/forms/{f['id']}", headers=H, json={"settings": off})
        n = len(calls)
        await http.post(f"/api/forms/public/{f['slug']}/submit", json={
            "answers": {"nome": "Caio", "zap": "31 98888-3333", "orc": "Baixo"}})
        await settle()
        check("desligado não envia", len(calls) == n)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
