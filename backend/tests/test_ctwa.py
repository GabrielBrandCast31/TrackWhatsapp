"""Deteccao do anuncio Click to WhatsApp nos formatos que a Evolution entrega.

O caso que motivou este teste: registro do `findMessages` da v2 (o formato do
"sincronizar"/"puxar historico") com `contextInfo` no MESMO nivel de `message`.
O `ctwaClid` estava ali e o lead ficava sem atribuicao, porque o sync nunca
olhava o anuncio.

Roda sem banco, sem docker e sem rede:

    cd backend && ./.venv/bin/python tests/test_ctwa.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from app.evolution_ingest import ad_referral, apply_ad_attribution
from app.models import Contact

ok = fail = 0
def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  ok   {label}")
    else:
        fail += 1; print(f"  FAIL {label} {extra}")


CLID = "Afh5882iObnbNwRA8UO0qjY4-RsZVzzY_wuoFlFT12xJ-IY8-hTYMnV7vxyrC1bR2tqU4FP-dTyRQrsVvCFnXQFw9gCqAH4R9uP4CEH_Sx7OtzsIcq2wScvML-mFY66-pBC0zhvW2A"

# recorte do payload real (miniatura e payloads opacos encurtados)
FIND_MESSAGES_ROW = {
    "key": {"remoteJid": "5531999990001@s.whatsapp.net", "fromMe": False, "id": "3EB0AD"},
    "messageType": "conversation",
    "message": {
        "conversation": "Olá! Gostaria de agendar um banho para o meu pet!",
        "messageContextInfo": {"threadId": [], "deviceListMetadata": {"senderKeyIndexes": []}},
    },
    "messageTimestamp": 1789433294,
    "instanceId": "b111c9e4-4832-4ef3-88bc-800a57ee603f",
    "source": "android",
    "contextInfo": {
        "ctwaPayload": "QWZo",
        "ctwaSignals": "all,all",
        "mentionedJid": [],
        "conversionData": "QWZo",
        "externalAdReply": {
            "body": "Na Clínica Cão Peão, seu melhor amigo recebe todo o cuidado.",
            "title": "🐶✨ SEU PET MERECE UM DIA DE SPA!",
            "ctwaClid": CLID,
            "mediaUrl": "https://www.facebook.com/reel/1989633591752685/",
            "sourceId": "120246244376650582",
            "mediaType": 2,
            "sourceApp": "instagram",
            "sourceUrl": "https://www.instagram.com/p/DcaINWCADK0/",
            "sourceType": "ad",
        },
        "conversionSource": "FB_Ads",
        "entryPointConversionSource": "ctwa_ad",
    },
    "MessageUpdate": [{"status": "READ"}],
}

print("findMessages v2 — contextInfo ao lado de message")
r = ad_referral(FIND_MESSAGES_ROW)
check("acha o ctwaClid", r and r["ctwa_clid"] == CLID, r)
check("id do anuncio", r and r["source_id"] == "120246244376650582", r)
check("url de origem", r and r["source_url"] == "https://www.instagram.com/p/DcaINWCADK0/", r)
check("titulo do anuncio", r and r["headline"].startswith("🐶"), r)

print("sync — o contato ganha a atribuicao")
c = Contact(wa_id="5531999990001", utm={})
check("apply devolve True", apply_ad_attribution(c, FIND_MESSAGES_ROW) is True)
check("ctwa_clid gravado", c.ctwa_clid == CLID, c.ctwa_clid)
check("anuncio gravado", c.source_id == "120246244376650582" and c.ad_headline, (c.source_id, c.ad_headline))
check("segunda vez nao conta de novo", apply_ad_attribution(c, FIND_MESSAGES_ROW) is False)

print("sync — nunca sobrescreve atribuicao existente")
c = Contact(wa_id="1", utm={}, ctwa_clid="JA_TINHA")
apply_ad_attribution(c, FIND_MESSAGES_ROW)
check("clid antigo mantido", c.ctwa_clid == "JA_TINHA", c.ctwa_clid)

print("sync — mensagem do atendente nao atribui")
mine = {**FIND_MESSAGES_ROW, "key": {**FIND_MESSAGES_ROW["key"], "fromMe": True}}
c = Contact(wa_id="1", utm={})
check("fromMe ignorado", apply_ad_attribution(c, mine) is False and c.ctwa_clid is None)

print("webhook — texto estendido, contextInfo dentro da mensagem")
ext = {
    "key": {"remoteJid": "1@s.whatsapp.net", "fromMe": False},
    "message": {"extendedTextMessage": {"text": "oi", "contextInfo": {"externalAdReply": {"ctwaClid": "X1", "sourceId": "9"}}}},
}
r = ad_referral(ext)
check("acha no nivel de dentro", r and r["ctwa_clid"] == "X1" and r["source_id"] == "9", r)

print("dois externalAdReply — vale o que tem clid")
two = {
    "message": {"extendedTextMessage": {"contextInfo": {"quotedMessage": {"x": {"contextInfo": {"externalAdReply": {"title": "citada"}}}}}}},
    "contextInfo": {"externalAdReply": {"title": "anuncio", "ctwaClid": "X2"}},
}
r = ad_referral(two)
check("escolhe o bloco com clid", r and r["ctwa_clid"] == "X2" and r["headline"] == "anuncio", r)

print("formato Cloud API — referral")
r = ad_referral({"referral": {"ctwa_clid": "X3", "source_id": "7", "source_url": "https://fb.me/x"}})
check("referral.ctwa_clid", r and r["ctwa_clid"] == "X3" and r["source_id"] == "7", r)

print("so os marcadores de conversao, sem bloco")
r = ad_referral({"contextInfo": {"conversionSource": "FB_Ads"}})
check("marca como anuncio, clid None", r is not None and r["ctwa_clid"] is None, r)

print("mensagem comum")
check("sem anuncio -> None", ad_referral({"message": {"conversation": "oi"}, "contextInfo": {"mentionedJid": []}}) is None)

print(f"\n{ok} ok, {fail} falha(s)")
sys.exit(1 if fail else 0)
