"""Campanhas de disparo: texto, audiencia, teste, fila, descadastro e respostas.

O envio da Evolution e trocado por um dublê (`evolution.send_message`): nada sai
pra rede. Login de verdade, SQLite temporario:

    cd backend && ./.venv/bin/python tests/test_broadcasts.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import asyncio, os, pathlib, random, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'broadcasts.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"

from httpx import ASGITransport, AsyncClient

from app import auth, broadcasts
from app.db import SessionLocal, init_db
from app.evolution_ingest import build_simulated_payload, ingest_event
from app.main import app
from app.models import Contact, WaNumber
from app.services import evolution

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


sent: list[dict] = []
fail_sends = False


async def fake_send(cfg, payload):
    if fail_sends:
        raise evolution.EvolutionError("instância desconectada")
    sent.append(payload)
    return 200, {"key": {"id": f"MSG{len(sent)}"}}


evolution.send_message = fake_send
broadcasts.MIN_THROTTLE_SECONDS = 0


def pure_checks():
    print("texto")
    rng = random.Random(1)
    seen = {broadcasts.spin("{Oi|Olá|E aí} {nome}", rng) for _ in range(30)}
    check("spintax sorteia as 3 opções", {s.split()[0] for s in seen} == {"Oi", "Olá", "E"}, seen)
    check("spintax não mexe em {nome}", all("{nome}" in s for s in seen))
    c = Contact(wa_id="1", name="Maria Souza")
    check("variáveis", broadcasts.render("Oi {primeiro_nome}! ({nome})", c) == "Oi Maria! (Maria Souza)")
    check("nome vazio não deixa ' ,'", broadcasts.render("Oi {primeiro_nome}, tudo bem?", Contact(wa_id="1")) == "Oi, tudo bem?")

    print("descadastro")
    check("SAIR", broadcasts.is_opt_out("SAIR"))
    check("'Não quero mais!'", broadcasts.is_opt_out("Não quero mais!"))
    check("frase comum não descadastra", not broadcasts.is_opt_out("vou parar no caminho pra comprar"))

    print("janela de horário")
    from datetime import datetime
    b = broadcasts.Broadcast(window_start_hour=8, window_end_hour=20)
    check("10h dentro", broadcasts.in_window(b, datetime(2026, 1, 5, 10, tzinfo=broadcasts.TZ)))
    check("22h fora", not broadcasts.in_window(b, datetime(2026, 1, 5, 22, tzinfo=broadcasts.TZ)))
    check("janela 0-0 = sempre", broadcasts.in_window(broadcasts.Broadcast(window_start_hour=0, window_end_hour=0)))


async def wait_worker(timeout=10):
    for _ in range(timeout * 20):
        if broadcasts._worker is None or broadcasts._worker.done():
            return
        await asyncio.sleep(0.05)


async def main():
    pure_checks()
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        line = WaNumber(label="Loja", phone_number_id="evo:l", channel="evolution", evo_instance="l", webhook_token="tl")
        s.add(line)
        await s.commit()
        L = line.id
        for wa, name in (("5511900000001", "Ana Lima"), ("5511900000002", "Bruno"), ("5511900000003", None)):
            await ingest_event(s, build_simulated_payload(instance="l", wa_id=wa, name=name, text="Oi",
                                                          ctwa_clid=None, ad_id=None, source_url=None), line)
        # o terceiro pede pra sair antes da campanha
        await ingest_event(s, build_simulated_payload(instance="l", wa_id="5511900000003", name=None, text="Sair",
                                                      ctwa_clid=None, ad_id=None, source_url=None), line)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        r = await http.post("/api/auth/login", json={"username": "admin", "password": "admin-senha-forte"})
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}

        print("audiência")
        r = await http.post(f"/api/broadcasts/audience?number_id={L}", headers=h, json={})
        body = r.json()
        check("2 entram, 1 descadastrado fica de fora", body["count"] == 2 and body["dropped"]["opted_out"] == 1, body)
        r = await http.post(f"/api/broadcasts/audience?number_id={L}", headers=h, json={"stages": ["fechado"]})
        check("filtro por etapa", r.json()["count"] == 0, r.json())

        print("teste no próprio número")
        r = await http.post("/api/broadcasts/test", headers=h, json={
            "number_id": L, "phone": "(11) 98888-7777", "text": "Oi {primeiro_nome}, promo!", "sample_name": "Gabriel"})
        check("teste enviado", r.status_code == 200 and sent[-1]["number"] == "5511988887777", r.text)
        check("teste com variável e rodapé SAIR", "Oi Gabriel, promo!" in sent[-1]["text"] and "SAIR" in sent[-1]["text"], sent[-1])
        r = await http.post("/api/broadcasts/test", headers=h, json={"number_id": L, "phone": "1234-5678", "text": "x"})
        check("telefone inválido = 400", r.status_code == 400)

        print("campanha")
        sent.clear()
        r = await http.post("/api/broadcasts", headers=h, json={
            "number_id": L, "name": "Black Friday", "text": "{Oi|Olá} {primeiro_nome}! Black Friday: 30% off.",
            "throttle_seconds": 0, "jitter_seconds": 0, "window_start_hour": 0, "window_end_hour": 0, "start": True})
        check("criada e rodando", r.status_code == 201 and r.json()["status"] == "running", r.text)
        bid = r.json()["id"]
        await wait_worker()
        d = (await http.get(f"/api/broadcasts/{bid}", headers=h)).json()
        check("terminou", d["status"] == "done", d["status"])
        check("2 enviados", d["stats"]["sent"] == 2 and len(sent) == 2, d["stats"])
        check("descadastrado não recebeu", all(p["number"] != "5511900000003" for p in sent), sent)
        check("nome preenchido", any("Ana!" in p["text"] for p in sent), sent)
        check("wamid gravado", all(rc["wamid"] for rc in d["recipients"]), d["recipients"])

        print("resposta conta")
        await asyncio.sleep(1.1)  # o WhatsApp carimba a mensagem em segundos inteiros
        async with SessionLocal() as s:
            line = await s.get(WaNumber, L)
            await ingest_event(s, build_simulated_payload(instance="l", wa_id="5511900000001", name="Ana Lima",
                                                          text="Quero!", ctwa_clid=None, ad_id=None, source_url=None), line)
        d = (await http.get(f"/api/broadcasts/{bid}", headers=h)).json()
        check("1 respondeu", d["stats"]["replied"] == 1, d["stats"])

        print("não repetir")
        r = await http.post(f"/api/broadcasts/audience?number_id={L}", headers=h, json={"exclude_recent_days": 7})
        check("quem recebeu nos últimos 7 dias sai", r.json()["count"] == 0, r.json())

        print("linha caída pausa a campanha")
        global fail_sends
        fail_sends = True
        r = await http.post("/api/broadcasts", headers=h, json={
            "number_id": L, "name": "Falha", "text": "x", "throttle_seconds": 0, "jitter_seconds": 0,
            "window_start_hour": 0, "window_end_hour": 0, "start": True})
        bid2 = r.json()["id"]
        await wait_worker()
        d = (await http.get(f"/api/broadcasts/{bid2}", headers=h)).json()
        check("2 falhas, ainda não pausou (limite é 3)", d["stats"]["failed"] == 2 and d["status"] == "done", d)
        fail_sends = False
        r = await http.post(f"/api/broadcasts/{bid2}/retry-failed", headers=h)
        check("retry devolve pra fila", r.json()["requeued"] == 2 and r.json()["status"] == "paused", r.json())
        await http.post(f"/api/broadcasts/{bid2}/start", headers=h)
        await wait_worker()
        d = (await http.get(f"/api/broadcasts/{bid2}", headers=h)).json()
        check("retomada envia", d["stats"]["sent"] == 2 and d["status"] == "done", d["stats"])

        print("cancelar")
        r = await http.post("/api/broadcasts", headers=h, json={"number_id": L, "name": "Rascunho", "text": "x"})
        bid3 = r.json()["id"]
        check("rascunho não envia", r.json()["status"] == "draft")
        r = await http.post(f"/api/broadcasts/{bid3}/cancel", headers=h)
        check("cancelada, fila vira skipped", r.json()["stats"]["skipped"] == 2, r.json())

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
