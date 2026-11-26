"""Exportacao CSV dos leads que chamaram vindos de campanha.

    cd backend && ./.venv/bin/python tests/test_campaign_leads_csv.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import asyncio, csv, io, os, pathlib, sys, tempfile
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'campaign_csv.db'}"
os.environ["JWT_SECRET"] = "teste"
os.environ["ADMIN_USER"] = "admin"
os.environ["ADMIN_PASSWORD"] = "admin-senha-forte"

from httpx import ASGITransport, AsyncClient

from app import auth
from app.db import SessionLocal, init_db
from app.main import app
from app.models import AdCampaign, Contact, WaNumber

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


def parse(text: str) -> list[dict]:
    check("começa com BOM (Excel)", text.startswith("﻿"))
    return list(csv.DictReader(io.StringIO(text.lstrip("﻿")), delimiter=";"))


def when(day: int) -> datetime:
    return datetime(2026, 11, day, 12, 0, tzinfo=timezone.utc)


async def main():
    await init_db()
    async with SessionLocal() as s:
        await auth.ensure_bootstrap_user(s)
        line = WaNumber(label="Clínica", phone_number_id="evo:cli", channel="evolution")
        s.add(line)
        await s.flush()
        L = line.id
        s.add(AdCampaign(ad_id="AD1", ad_name="Anúncio 1", adset_name="Conjunto A",
                         campaign_id="C1", campaign_name="Black Friday", status="resolved", manual=True))
        s.add_all([
            # Meta Ads (CTWA)
            Contact(wa_id="5511900000001", phone_e164="+5511900000001", name="Ana", utm={},
                    ctwa_clid="CL1", source_id="AD1", ad_source_app="instagram",
                    first_message="Oi,\nvim do anúncio", wa_number_id=L, created_at=when(10)),
            # mesmo telefone de novo (outro contato): sai uma vez so
            Contact(wa_id="5511900000001", phone_e164="+5511900000001", name="Ana", utm={},
                    ctwa_clid="CL1b", source_id="AD1", wa_number_id=L, created_at=when(11)),
            # Google Ads
            Contact(wa_id="5511900000002", name="=HYPERLINK(\"x\")", utm={"utm_campaign": "pesquisa"},
                    gclid="Cj0", wa_number_id=L, created_at=when(15)),
            # UTM
            Contact(wa_id="5511900000003", name="Carla",
                    utm={"utm_source": "newsletter", "utm_campaign": "novembro"},
                    wa_number_id=L, created_at=when(20)),
            # organico e simulado: fora
            Contact(wa_id="5511900000004", name="Duda", utm={}, wa_number_id=L, created_at=when(12)),
            Contact(wa_id="5511900000005", name="Sim", utm={}, ctwa_clid="X", source_id="AD1",
                    origin="simulado", wa_number_id=L, created_at=when(12)),
            # LID sem telefone: nao ha numero pra exportar
            Contact(wa_id="abc123", wa_lid="abc123", utm={}, ctwa_clid="CL9", source_id="AD1",
                    wa_number_id=L, created_at=when(13)),
        ])
        await s.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
        r = await http.post("/api/auth/login", json={"username": "admin", "password": "admin-senha-forte"})
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        url = "/api/contacts/campaign-leads.csv"

        print("todas as campanhas")
        r = await http.get(url, headers=h, params={"number_id": L})
        check("200", r.status_code == 200, r.text)
        check("é csv anexado", "attachment" in r.headers.get("content-disposition", ""))
        rows = parse(r.text)
        phones = [x["telefone"] for x in rows]
        check("3 leads de campanha, sem duplicar", phones == ["+5511900000001", "+5511900000002", "+5511900000003"], phones)
        ana = rows[0]
        check("campanha do Meta resolvida", ana["campanha"] == "Black Friday" and ana["conjunto"] == "Conjunto A", ana)
        check("plataforma", ana["plataforma"] == "Instagram", ana)
        check("quebra de linha some da mensagem", ana["primeira_mensagem"] == "Oi, vim do anúncio", ana)
        check("linha", ana["linha"] == "Clínica", ana)
        check("wa_id vira telefone quando falta e164", rows[1]["telefone"] == "+5511900000002")
        check("fórmula neutralizada", rows[1]["nome"].startswith("'="), rows[1])

        print("filtros")
        r = await http.get(url, headers=h, params={"channel": "meta_ads"})
        check("só Meta", [x["telefone"] for x in parse(r.text)] == ["+5511900000001"])
        r = await http.get(url, headers=h, params={"campaign": "novem"})
        check("por nome de campanha", [x["nome"] for x in parse(r.text)] == ["Carla"])
        r = await http.get(url, headers=h, params={"date_from": "2026-11-14", "date_to": "2026-11-15"})
        check("por data (inclusiva)", [x["telefone"] for x in parse(r.text)] == ["+5511900000002"])
        r = await http.get(url, headers=h, params={"unique": "false", "channel": "meta_ads"})
        check("sem dedupe", len(parse(r.text)) == 2)
        r = await http.get(url, headers=h, params={"channel": "organic"})
        check("canal inválido -> 422", r.status_code == 422, r.status_code)
        r = await http.get(url)
        check("sem login -> 401", r.status_code == 401, r.status_code)

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
