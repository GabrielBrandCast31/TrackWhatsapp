"""De onde o lead veio: etiqueta de origem, campanha do anuncio e evento pelo objetivo.

A Marketing API e trocada por um dublê (`meta_ads.fetch_ad`): o teste nao sai
para a rede. Roda num SQLite temporario:

    cd backend && ./.venv/bin/python tests/test_campaigns.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'campaigns.db'}"

from app import campaigns
from app.db import SessionLocal, init_db
from app.evolution_ingest import ad_referral, apply_ad_attribution
from app.firing import fire_event
from app.models import AdCampaign, Contact
from app.services import meta_ads

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


calls: list[str] = []


async def fake_fetch(cfg, ad_id):
    calls.append(ad_id)
    if ad_id == "apagado":
        raise meta_ads.AdsError("Unsupported get request (code 100)")
    return {
        "ad_name": "Reel spa",
        "adset_id": "as1",
        "adset_name": "Tutores 25-45",
        "optimization_goal": "CONVERSATIONS",
        "campaign_id": "c1",
        "campaign_name": "[LEADS] Banho e tosa",
        "objective": "OUTCOME_LEADS",
    }


meta_ads.fetch_ad = fake_fetch

AD_ROW = {
    "key": {"remoteJid": "5531999990001@s.whatsapp.net", "fromMe": False, "id": "X"},
    "message": {"conversation": "Oi"},
    "contextInfo": {
        "externalAdReply": {"ctwaClid": "CLID", "sourceId": "120246", "sourceApp": "instagram", "sourceType": "ad"},
        "entryPointConversionApp": "instagram",
    },
}


def pure_checks():
    print("payload — app do anuncio")
    r = ad_referral(AD_ROW)
    check("sourceApp lido", r and r["source_app"] == "instagram", r)
    c = Contact(wa_id="1", utm={})
    apply_ad_attribution(c, AD_ROW)
    check("contato ganha ad_source_app", c.ad_source_app == "instagram", c.ad_source_app)

    print("etiqueta — anuncio sem campanha resolvida")
    src = campaigns.lead_source(c, None, {})
    check("canal Instagram Ads", src["channel"] == "meta_ads" and src["channel_label"] == "Instagram Ads", src)
    check("campanha pendente", src["campaign_status"] == "pending", src)
    check("evento padrao", src["suggested_event"] == "Lead", src)

    print("etiqueta — com campanha de Vendas")
    camp = AdCampaign(ad_id="120246", campaign_id="c9", campaign_name="Black Friday", objective="OUTCOME_SALES", status="resolved")
    src = campaigns.lead_source(c, camp, {})
    check("nome da campanha", src["campaign_name"] == "Black Friday", src)
    check("objetivo Vendas -> Purchase", src["suggested_event"] == "Purchase" and src["objective_label"] == "Vendas", src)
    check("chave pela campanha", src["key"] == "meta:c9", src["key"])
    src = campaigns.lead_source(c, camp, {"objective_events": {"OUTCOME_SALES": "InitiateCheckout"}})
    check("mapa da linha sobrescreve", src["suggested_event"] == "InitiateCheckout", src)

    print("etiqueta — Google, UTM, organico, agenda")
    g = Contact(wa_id="2", utm={"utm_campaign": "pesquisa-marca"}, gclid="Cj0")
    src = campaigns.lead_source(g, None, {})
    check("gclid -> Google Ads com utm_campaign", src["channel"] == "google_ads" and src["campaign_name"] == "pesquisa-marca", src)
    u = Contact(wa_id="3", utm={"utm_source": "newsletter", "utm_campaign": "setembro"})
    src = campaigns.lead_source(u, None, {})
    check("utm solta", src["channel"] == "utm" and src["key"] == "utm:setembro", src)
    ig = Contact(wa_id="4", utm={"utm_source": "ig", "utm_medium": "bio"})
    src = campaigns.lead_source(ig, None, {})
    check("link do instagram sem CTWA nao vira meta_ads", src["channel"] == "utm" and src["platform"] == "instagram", src)
    check("organico", campaigns.lead_source(Contact(wa_id="5", utm={}, origin="webhook"), None, {})["channel"] == "organic")
    check("agenda", campaigns.lead_source(Contact(wa_id="6", utm={}, origin="sync"), None, {})["channel"] == "agenda")


async def db_checks():
    await init_db()
    cfg = {"meta_ads_token": "tok", "default_event_name": "Lead", "meta_capi_enabled": False}
    async with SessionLocal() as session:
        print("resolve — consulta e guarda no cache")
        row = await campaigns.resolve_ad(session, cfg, "120246")
        check("resolvido", row.status == "resolved" and row.campaign_name == "[LEADS] Banho e tosa", row.status)
        await campaigns.resolve_ad(session, cfg, "120246")
        check("segunda leitura vem do cache", calls.count("120246") == 1, calls)

        print("resolve — erro fica guardado e nao repete na hora")
        row = await campaigns.resolve_ad(session, cfg, "apagado")
        check("status error", row.status == "error" and "code 100" in row.error, row.error)
        await campaigns.resolve_ad(session, cfg, "apagado")
        check("nao consulta de novo antes da janela", calls.count("apagado") == 1, calls)

        print("resolve — sem token nao grava nada")
        row = await campaigns.resolve_ad(session, {}, "sem-token")
        check("nada gravado", row is None and "sem-token" not in calls, row)

        print("disparo pelo objetivo")
        contact = Contact(wa_id="5531999990001", utm={}, ctwa_clid="CLID", source_id="120246")
        session.add(contact)
        await session.commit()
        conv = await fire_event(session, cfg, contact, event_name=meta_ads.OBJECTIVE_EVENT, destinations=[])
        check("objetivo Leads -> Lead", conv.event_name == "Lead", conv.event_name)
        check("motivo na nota", "Cadastros" in (conv.note or ""), conv.note)

        print("manual — nunca sobrescrito pela consulta")
        session.add(AdCampaign(ad_id="manual1", campaign_name="Campanha X", objective="OUTCOME_SALES", manual=True, status="manual"))
        await session.commit()
        row = await campaigns.resolve_ad(session, cfg, "manual1", force=True)
        check("manual mantido", row.campaign_name == "Campanha X" and "manual1" not in calls, calls)
        contact2 = Contact(wa_id="5531999990002", utm={}, ctwa_clid="C2", source_id="manual1")
        session.add(contact2)
        await session.commit()
        conv = await fire_event(session, cfg, contact2, event_name=meta_ads.OBJECTIVE_EVENT, destinations=[])
        check("manual de Vendas -> Purchase", conv.event_name == "Purchase", conv.event_name)


pure_checks()
asyncio.run(db_checks())
print(f"\n{ok} ok, {fail} falha(s)")
sys.exit(1 if fail else 0)
