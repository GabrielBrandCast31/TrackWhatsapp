"""Evento do Meta no formato `page_id` (sem WABA), em paralelo ao formato padrao.

Roda sem banco, sem docker e sem rede:

    cd backend && ./.venv/bin/python tests/test_capi_page.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from app.models import AdCampaign, Contact, Conversion
from app.services import dispatch, meta_capi

ok = fail = 0
def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  ok   {label}")
    else:
        fail += 1; print(f"  FAIL {label} {extra}")


contact = Contact(
    id=7, wa_id="5547999990001", ctwa_clid="AffZ40AAmLQ", source_id="120241", source_type="ad",
    source_url="https://www.instagram.com/p/x", ad_source_app="instagram",
)
conv = Conversion(
    id=1, contact_id=7, event_name="Lead", event_id="wa-7-abc", currency="BRL", is_test=False,
    created_at=datetime(2026, 10, 15, tzinfo=timezone.utc),
)
campaign = AdCampaign(ad_id="120241", ad_name="Img vaga", adset_id="1202", adset_name="SC", campaign_id="1203", campaign_name="Vaga")

print("formato page_id")
cfg = {"meta_page_id": "3236814274", "meta_dataset_id": "398", "meta_capi_token": "t"}
ev = dispatch._build_meta_page(cfg, contact, conv, campaign)["data"][0]
ud = ev["user_data"]
check("Lead vira LeadSubmitted", ev["event_name"] == "LeadSubmitted", ev["event_name"])
check("business_messaging / whatsapp", ev["action_source"] == "business_messaging" and ev["messaging_channel"] == "whatsapp")
check("page_id + ctwa_clid + ph", ud.get("page_id") == "3236814274" and ud.get("ctwa_clid") == "AffZ40AAmLQ" and ud.get("ph"), ud)
check("sem WABA", "whatsapp_business_account_id" not in ud, ud)
check("telefone hasheado", ud["ph"] == [meta_capi.hash_phone("+5547999990001")])
cd = ev["custom_data"]
check("anuncio e campanha no custom_data", cd.get("ad_id") == "120241" and cd.get("campaign_name") == "Vaga" and cd.get("adset_name") == "SC", cd)
check("lead_event_source WhatsApp", cd.get("lead_event_source") == "WhatsApp" and cd.get("source_app") == "instagram", cd)
check("mesmo event_id do padrao", ev["event_id"] == conv.event_id)

ev2 = dispatch._build_meta_page(cfg, contact, conv)["data"][0]
check("sem campanha no cache, so o anuncio", "campaign_name" not in ev2["custom_data"] and ev2["custom_data"]["ad_id"] == "120241", ev2["custom_data"])

print("paralelo")
check("com Page ID entra junto do meta_capi", dispatch._with_parallel(cfg, ["meta_capi", "webhook"]) == ["meta_capi", "meta_capi_page", "webhook"])
check("sem Page ID nao entra", dispatch._with_parallel({}, ["meta_capi"]) == ["meta_capi"])
check("sem meta_capi nao entra", dispatch._with_parallel(cfg, ["google_ads"]) == ["google_ads"])
check("nao duplica", dispatch._with_parallel(cfg, ["meta_capi", "meta_capi_page"]) == ["meta_capi", "meta_capi_page"])

print("o formato padrao continua igual")
std = dispatch._build_meta({**cfg, "meta_waba_id": "1098"}, contact, conv)["data"][0]
check("padrao segue com WABA e sem page_id", std["user_data"].get("whatsapp_business_account_id") == "1098" and "page_id" not in std["user_data"], std)
check("padrao tambem manda LeadSubmitted", std["event_name"] == "LeadSubmitted", std["event_name"])

print("erros")
try:
    dispatch._build_meta_page({}, contact, conv); check("sem Page ID recusa", False)
except meta_capi.CapiError:
    check("sem Page ID recusa", True)
try:
    dispatch._build_meta_page(cfg, Contact(id=8, wa_id="5547999990002"), conv); check("sem ctwa_clid recusa", False)
except meta_capi.CapiError:
    check("sem ctwa_clid recusa", True)

print(f"\n{ok} ok, {fail} falhas")
sys.exit(1 if fail else 0)
