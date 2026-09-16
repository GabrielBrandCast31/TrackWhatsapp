"""Fumaca da extracao de atribuicao, com foco no fallback do ctwa_clid.

Roda sem banco, sem docker e sem rede:

    cd backend && PYTHONPATH=$PWD ./.venv/bin/python tests/test_tracking.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import pathlib, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from app.tracking import extract

ok = fail = 0
def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  ok   {label}")
    else:
        fail += 1; print(f"  FAIL {label} {extra}")

print("referral oficial")
r = extract({"ctwa_clid": "ARAoficial123", "source_url": "https://lp.com/?ctwa_clid=ARAdaurl"}, None)
check("clid do referral ganha da url", r["ctwa_clid"] == "ARAoficial123", r["ctwa_clid"])

print("fallback pela url de origem")
r = extract({"source_url": "https://lp.com/p?utm_source=ig&ctwa_clid=ARAdaurl456"}, "Ola, quero saber mais")
check("clid vem da query string", r["ctwa_clid"] == "ARAdaurl456", r["ctwa_clid"])
check("utm continua sendo lido", r["utm"].get("utm_source") == "ig", r["utm"])

print("fallback pelo camelCase na url")
r = extract({"source_url": "https://lp.com/?ctwaClid=ARAcamel789"}, None)
check("ctwaClid normaliza pra ctwa_clid", r["ctwa_clid"] == "ARAcamel789", r["ctwa_clid"])

print("fallback pelo texto pre-preenchido")
r = extract(None, "Ola! [ref: ctwa_clid=ARAdotexto000 gclid=Cj0KCabc]")
check("clid vem do texto", r["ctwa_clid"] == "ARAdotexto000", r["ctwa_clid"])
check("gclid continua funcionando", r["gclid"] == "Cj0KCabc", r["gclid"])

print("url no meio do texto")
r = extract(None, "vim por aqui https://lp.com/x?ctwa_clid=ARAurlnotexto")
check("clid da url colada no texto", r["ctwa_clid"] == "ARAurlnotexto", r["ctwa_clid"])

print("url ganha do texto")
r = extract({"source_url": "https://lp.com/?ctwa_clid=ARAurl"}, "ctwa_clid=ARAtexto")
check("precedencia url > texto", r["ctwa_clid"] == "ARAurl", r["ctwa_clid"])

print("sem nada")
r = extract(None, "bom dia, tudo bem?")
check("sem clid continua None", r["ctwa_clid"] is None, r["ctwa_clid"])
check("utm vazio", r["utm"] == {}, r["utm"])

print(f"\n{ok} ok, {fail} falhas")
sys.exit(1 if fail else 0)
