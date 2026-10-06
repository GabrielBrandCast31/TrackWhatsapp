"""Lead do formulario e conversa do WhatsApp sao a mesma pessoa, mesmo com o
telefone diferindo pelo nono digito (o formulario grava 5531993370270, o
WhatsApp entrega 553193370270).

    cd backend && ./.venv/bin/python tests/test_dedupe.py
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'dedupe.db'}"

from sqlalchemy import select

from app import dedupe, forms
from app.services import evolution
from app.db import SessionLocal, init_db
from app.ingest import upsert_contact
from app.models import Contact, FormResponse, LeadForm, Message, WaNumber

ok = fail = 0


def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  ok   {label}")
    else:
        fail += 1
        print(f"  FAIL {label} {extra}")


async def main():
    await init_db()
    async with SessionLocal() as s:
        line = WaNumber(label="Clinica", phone_number_id="evo:x", evo_instance="x")
        other = WaNumber(label="Outra", phone_number_id="evo:y", evo_instance="y")
        s.add_all([line, other])
        await s.commit()

        print("formulario primeiro, WhatsApp depois")
        form_c, created = await upsert_contact(s, "5531993370270", "Sheila", {}, "evo:x", line.id, keep_wa_id=True)
        form_c.origin, form_c.stage = "form", "mql"
        await s.commit()
        wa_c, created = await upsert_contact(s, "553193370270", None, {}, "evo:x", line.id)
        check("nao cria segundo contato", not created and wa_c.id == form_c.id)
        check("wa_id passa a ser o do WhatsApp", wa_c.wa_id == "553193370270", wa_c.wa_id)
        check("continua lead do formulario", wa_c.origin == "form" and wa_c.stage == "mql")

        print("WhatsApp primeiro, formulario depois")
        a, _ = await upsert_contact(s, "555182173420", None, {}, "evo:x", line.id)
        b, created = await upsert_contact(s, "5551982173420", "Marcia", {}, "evo:x", line.id, keep_wa_id=True)
        check("formulario acha a conversa", not created and b.id == a.id)
        check("formulario nao troca o wa_id", b.wa_id == "555182173420", b.wa_id)

        print("escopo por linha")
        c, created = await upsert_contact(s, "553193370270", None, {}, "evo:y", other.id)
        check("outra linha tem o proprio contato", created and c.id != form_c.id)
        await s.commit()

        print("base antiga com a duplicata")
        old_form = Contact(wa_id="5551991424878", phone_e164="+5551991424878", name="Magda", origin="form",
                           stage="mql", wa_number_id=line.id, utm={"utm_source": "ig"}, note="📝 Formulário")
        old_wa = Contact(wa_id="555191424878", phone_e164="+555191424878", origin="webhook", stage="novo",
                         wa_number_id=line.id, utm={})
        s.add_all([old_form, old_wa])
        await s.flush()
        lf = LeadForm(slug="f", title="F", wa_number_id=line.id)
        s.add(lf)
        await s.flush()
        s.add(FormResponse(form_id=lf.id, answers={}, contact_id=old_form.id))
        s.add(Message(contact_id=old_wa.id, direction="out", body="Boa tarde, Magda!"))
        await s.commit()
        keep_id, gone_id = old_wa.id, old_form.id

    async with SessionLocal() as s:
        merged = await dedupe.merge_duplicates(s)
        check("uma duplicata juntada", merged == 1, merged)
    async with SessionLocal() as s:
        keep = await s.get(Contact, keep_id)
        check("duplicado apagado", await s.get(Contact, gone_id) is None)
        check("sobrevive o do WhatsApp", keep.wa_id == "555191424878")
        check("herda nome, etapa, origem, utm e nota",
              keep.name == "Magda" and keep.stage == "mql" and keep.origin == "form"
              and keep.utm == {"utm_source": "ig"} and "Formulário" in (keep.note or ""))
        resp = (await s.execute(select(FormResponse))).scalars().first()
        check("resposta do formulario aponta pro sobrevivente", resp.contact_id == keep_id)
        msg = (await s.execute(select(Message))).scalars().first()
        check("mensagens ficam no sobrevivente", msg.contact_id == keep_id)
        check("rodar de novo nao faz nada", await dedupe.merge_duplicates(s) == 0)

    print("formulario pergunta o id do WhatsApp para a Evolution")
    async def fake_request(cfg, method, path, **kw):
        n = kw["json"]["numbers"][0]
        return [{"exists": True, "jid": "553188887777@s.whatsapp.net", "number": n}]
    real_request = evolution._request
    evolution._request = fake_request
    check("le o jid sem o nono digito", await evolution.whatsapp_id({"evo_instance": "x"}, "5531988887777") == "553188887777")

    async def no_wa(cfg, method, path, **kw):
        return [{"exists": False, "jid": "5531900000000@s.whatsapp.net"}]
    evolution._request = no_wa
    check("numero sem WhatsApp: None", await evolution.whatsapp_id({"evo_instance": "x"}, "5531900000000") is None)

    async def fails(cfg, method, path, **kw):
        raise evolution.EvolutionError("HTTP 500")
    evolution._request = fails
    check("Evolution fora do ar: None, sem erro", await evolution.whatsapp_id({"evo_instance": "x"}, "5531900000000") is None)

    async def fake_id(cfg, number):
        return "553177776666" if number == "5531977776666" else "553188887777"
    evolution._request = real_request
    evolution.whatsapp_id = fake_id
    async with SessionLocal() as s:
        line = (await s.execute(select(WaNumber).where(WaNumber.evo_instance == "x"))).scalars().first()
        lf = LeadForm(slug="g", title="G", wa_number_id=line.id)
        s.add(lf)
        await s.flush()
        # sem conversa ainda: o card troca pro id do WhatsApp
        novo = Contact(wa_id="5531988887777", phone_e164="+5531988887777", origin="form", wa_number_id=line.id, utm={})
        s.add(novo)
        await s.flush()
        r1 = FormResponse(form_id=lf.id, answers={}, contact_id=novo.id)
        # ja conversava: o card do formulario some dentro da conversa
        conversa = Contact(wa_id="553177776666", phone_e164="+553177776666", origin="webhook", stage="novo",
                           wa_number_id=line.id, utm={})
        form_c = Contact(wa_id="5531977776666", phone_e164="+5531977776666", origin="form", stage="mql",
                         name="Lucia", wa_number_id=line.id, utm={})
        s.add_all([conversa, form_c])
        await s.flush()
        r2 = FormResponse(form_id=lf.id, answers={}, contact_id=form_c.id)
        s.add_all([r1, r2])
        await s.commit()
        ids = (novo.id, conversa.id, form_c.id, r1.id, r2.id)
    async with SessionLocal() as s:
        line = (await s.execute(select(WaNumber).where(WaNumber.evo_instance == "x"))).scalars().first()
        await forms.fix_wa_id(s, line, ids[3])
        await forms.fix_wa_id(s, line, ids[4])
    async with SessionLocal() as s:
        novo = await s.get(Contact, ids[0])
        check("card novo ja nasce sem o nono digito", novo.wa_id == "553188887777" and novo.phone_e164 == "+553188887777", novo.wa_id)
        conversa = await s.get(Contact, ids[1])
        check("formulario de quem ja conversava some dentro da conversa", await s.get(Contact, ids[2]) is None)
        check("a conversa vira lead do formulario", conversa.origin == "form" and conversa.stage == "mql" and conversa.name == "Lucia")
        check("resposta aponta pra conversa", (await s.get(FormResponse, ids[4])).contact_id == ids[1])

    print(f"\n{ok} ok, {fail} falha(s)")
    sys.exit(1 if fail else 0)


asyncio.run(main())
