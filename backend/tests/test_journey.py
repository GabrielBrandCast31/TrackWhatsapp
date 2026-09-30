"""Jornada Web -> WhatsApp: coletor, match do lead e regra de atribuicao.

Roda num SQLite temporario, sem rede:

    cd backend && ./.venv/bin/python tests/test_journey.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import asyncio, json, os, pathlib, sys, tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'journey.db'}"

from httpx import ASGITransport, AsyncClient

from app import journey
from app.db import SessionLocal, init_db
from app.evolution_ingest import build_simulated_payload, ingest_event
from app.main import app
from app.models import Contact, TrackingEvent, WaNumber

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


TL = "1790195601229_17901956838213"


def ev(name, ago, **extra):
    base = {
        "k": "SITEKEY",
        "tl": TL,
        "visitor_id": "v1",
        "session_id": "s1",
        "event_name": name,
        "event_time": (datetime.now(timezone.utc) - timedelta(seconds=ago)).isoformat(),
        "page_url": "https://clinica.com.br/studio/",
        "page_path": "/studio/",
        "landing_page": "/studio/",
        "hostname": "clinica.com.br",
    }
    base.update(extra)
    return base


async def main():
    await init_db()
    async with SessionLocal() as s:
        number = WaNumber(label="Clínica", phone_number_id="evo:clinica", channel="evolution",
                          evo_instance="clinica", site_key="SITEKEY", webhook_token="tok")
        s.add(number)
        await s.commit()
        number_id = number.id

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        print("tag e coletor")
        r = await http.get("/t/tl.js?k=SITEKEY")
        check("tl.js servido com a chave", r.status_code == 200 and "SITEKEY" in r.text)

        first = ev("page_view", 600, page_url="https://clinica.com.br/studio/?utm_source=google&gclid=ABC123",
                   utm={"source": "google", "medium": "cpc", "campaign": "implante"},
                   first_touch={"source": "google", "medium": "cpc", "campaign": "implante"},
                   click_ids={"gclid": "ABC123", "fbc": "inventado"})
        r = await http.post("/t/collect", content=json.dumps(first), headers={"Content-Type": "text/plain"})
        check("coletor responde 204", r.status_code == 204)
        # visita posterior direta: nao pode apagar a origem
        # a tag reenvia o gclid guardado em todo evento: isso nao e origem nova
        await http.post("/t/collect", content=json.dumps(ev("page_view", 300, page_path="/studio/contato",
                                                            click_ids={"gclid": "ABC123"})))
        click = ev("click_whatsapp", 120, page_path="/studio/contato", protocol="TL-8F3K2Q", event_id="dup1")
        await http.post("/t/collect", content=json.dumps(click))
        await http.post("/t/collect", content=json.dumps(click))  # beacon reenviado
        await http.post("/t/collect", content=json.dumps({**ev("page_view", 1), "k": "OUTRA"}))
        await http.post("/t/collect", content="nao e json")

    async with SessionLocal() as s:
        events = await journey.events_for(s, TL)
        check("3 eventos gravados (dedupe + chave errada descartada)", len(events) == 3, len(events))
        check("fbc inventado (sem fbclid) descartado", events[0].fbc is None, events[0].fbc)
        summary = journey.summarize(events)
        check("last touch continua google/cpc depois da visita direta",
              summary["last_touch"].get("source") == "google", summary["last_touch"])
        check("last touch mantém a campanha (gclid reenviado não é origem nova)",
              summary["last_touch"].get("campaign") == "implante", summary["last_touch"])
        check("origem classificada como Google Ads", summary["origin"]["channel"] == "google_ads")
        check("páginas navegadas", summary["pages"] == ["/studio/", "/studio/contato"], summary["pages"])
        check("clique no WhatsApp registrado", summary["clicked_whatsapp_at"] is not None)

        print("referência na conversa")
        check("extrai tl do texto", journey.find_reference(f"Olá!\n\ntl={TL}") == (TL, None))
        check("extrai protocolo", journey.find_reference("Oi Protocolo: TL-8F3K2Q")[1] == "TL-8F3K2Q")
        check("não confunde html=", journey.find_reference("html=abcdefghij")[0] is None)
        check("remove a referência técnica", journey.strip_reference(f"Olá!\n\ntl={TL}") == "Olá!")

        number = await s.get(WaNumber, number_id)

        print("1. match por TL_ID")
        payload = build_simulated_payload(instance="clinica", wa_id="5511900000001", name="Maria",
                                          text=f"Olá! Quero saber mais sobre implante.\n\ntl={TL}",
                                          ctwa_clid=None, ad_id=None, source_url=None)
        result = await ingest_event(s, payload, number)
        maria = await s.get(Contact, result["contact_ids"][0])
        check("lead ligado ao TL_ID", maria.transaction_id == TL)
        check("método transaction_id, score 1.0", maria.match_method == "transaction_id" and maria.match_score == 1.0)
        check("gclid recuperado", maria.gclid == "ABC123")
        check("first touch no lead", maria.first_utm.get("campaign") == "implante", maria.first_utm)
        check("landing page no lead", maria.landing_page == "/studio/")
        check("utm no lead (etiqueta de origem)", (maria.utm or {}).get("utm_source") == "google", maria.utm)

        print("2. match por protocolo")
        s.add(journey.build_event(number, {**ev("click_whatsapp", 30), "tl": "2222222222_22222", "protocol": "TL-ZZZZ22"}, None, None))
        await s.commit()
        payload = build_simulated_payload(instance="clinica", wa_id="5511900000002", name="João",
                                          text="Oi! Protocolo: TL-ZZZZ22", ctwa_clid=None, ad_id=None, source_url=None)
        result = await ingest_event(s, payload, number)
        joao = await s.get(Contact, result["contact_ids"][0])
        check("método protocol", joao.match_method == "protocol" and joao.transaction_id == "2222222222_22222")

        print("3. match temporal")
        s.add(journey.build_event(number, {**ev("click_whatsapp", 20), "tl": "3333333333_33333"}, None, None))
        await s.commit()
        payload = build_simulated_payload(instance="clinica", wa_id="5511900000003", name="Ana",
                                          text="Olá, vi no site", ctwa_clid=None, ad_id=None, source_url=None)
        result = await ingest_event(s, payload, number)
        ana = await s.get(Contact, result["contact_ids"][0])
        check("método temporal com score 0.75", ana.match_method == "temporal" and ana.match_score == 0.75,
              (ana.match_method, ana.match_score, ana.transaction_id))
        check("clique já usado não é reaproveitado", ana.transaction_id == "3333333333_33333")

        payload = build_simulated_payload(instance="clinica", wa_id="5511900000004", name="Sem site",
                                          text="Oi", ctwa_clid=None, ad_id=None, source_url=None)
        result = await ingest_event(s, payload, number)
        other = await s.get(Contact, result["contact_ids"][0])
        check("sem clique livre na janela: sem match", other.transaction_id is None, other.transaction_id)

        payload = build_simulated_payload(instance="clinica", wa_id="5511900000001", name="Maria",
                                          text="outra mensagem", ctwa_clid=None, ad_id=None, source_url=None)
        await ingest_event(s, payload, number)
        await s.refresh(maria)
        check("mensagem seguinte não troca a jornada", maria.transaction_id == TL)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
