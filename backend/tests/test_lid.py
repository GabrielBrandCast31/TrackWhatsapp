"""Enderecamento por LID: a conversa individual que chega como `<id>@lid`.

O WhatsApp migrou o enderecamento e o `remoteJid` de conversa 1:1 passou a vir
como LID — um identificador opaco que NAO e telefone. O codigo antigo tratava
`@lid` na mesma lista de grupo e status, e descartava essas conversas em silencio.
Numa instancia real isso era quase metade da base.

Roda sem banco, sem docker e sem rede:

    cd backend && ./.venv/bin/python tests/test_lid.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from app.crm import identity_from_chat
from app.evolution_ingest import identity_of

ok = fail = 0
def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  ok   {label}")
    else:
        fail += 1; print(f"  FAIL {label} {extra}")


print("webhook — conversa normal, sem LID")
r = identity_of({"key": {"remoteJid": "5531999990001@s.whatsapp.net", "fromMe": False}})
check("telefone sai do proprio jid", r == ("5531999990001", None), r)

print("webhook — conversa por LID com o telefone ao lado")
msg = {
    "key": {
        "remoteJid": "44444506173613@lid",
        "remoteJidAlt": "553171384066@s.whatsapp.net",
        "addressingMode": "lid",
        "fromMe": True,
    }
}
r = identity_of(msg)
check("telefone vem do remoteJidAlt", r == ("553171384066", "44444506173613"), r)

print("webhook — outros nomes do campo alternativo")
for campo in ("senderPn", "participantAlt", "participantPn"):
    r = identity_of({"key": {"remoteJid": "999@lid", campo: "5511988887777@s.whatsapp.net"}})
    check(f"{campo} tambem resolve", r == ("5511988887777", "999"), r)

print("webhook — LID sem telefone conhecido")
r = identity_of({"key": {"remoteJid": "26517279133788@lid", "fromMe": False}})
check("telefone None, LID preservado", r == (None, "26517279133788"), r)
check("a conversa NAO e descartada", r[1] is not None, r)

print("webhook — o que continua fora do rastreio")
for jid in ("120363404816758395@g.us", "status@broadcast", "1234@newsletter"):
    r = identity_of({"key": {"remoteJid": jid}})
    check(f"{jid.split('@')[1]} ignorado", r == (None, None), r)

print("webhook — grupo nao vira lead nem pelo participantAlt")
grupo = {
    "key": {
        "remoteJid": "120363404698216898@g.us",
        "participant": "160769366839426@lid",
        "participantAlt": "5521980404253@s.whatsapp.net",
    }
}
check("grupo segue ignorado", identity_of(grupo) == (None, None), identity_of(grupo))

print("sync — conversa da Evolution com LID resolvido pela ultima mensagem")
chat = {
    "remoteJid": "44444506173613@lid",
    "lastMessage": {"key": {"remoteJid": "44444506173613@lid", "remoteJidAlt": "553171384066@s.whatsapp.net"}},
}
r = identity_from_chat(chat["remoteJid"], chat)
check("telefone sai do lastMessage.key", r == ("553171384066", "44444506173613"), r)

print("sync — conversa com LID e sem nenhuma pista de telefone")
chat = {"remoteJid": "26517279133788@lid", "lastMessage": {"key": {"remoteJid": "26517279133788@lid"}}}
r = identity_from_chat(chat["remoteJid"], chat)
check("entra identificada pelo LID", r == (None, "26517279133788"), r)

print("sync — grupo continua de fora")
check("grupo ignorado", identity_from_chat("120363404816758395@g.us", {}) == (None, None))

print(f"\n{ok} ok, {fail} falhas")
sys.exit(1 if fail else 0)
