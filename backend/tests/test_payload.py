"""Payload cru de uma mensagem: `raw` + o POST inteiro do webhook que a trouxe.

A conversa na tela mostra o texto; quando um lead do anuncio aparece sem
atribuicao, o que responde "por que" e o objeto cru — e o POST em que ele veio.
Para isso a mensagem guarda de QUAL webhook ela saiu (`messages.webhook_log_id`):
sem esse ponteiro, so dava pra chutar pelo horario qual log era o dela.

Roda sem docker e sem rede, num SQLite temporario:

    cd backend && ./.venv/bin/python tests/test_payload.py

Sai com codigo 1 se qualquer checagem falhar.
"""
import asyncio, os, pathlib, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

# banco proprio: o teste grava de verdade, e nao pode encostar no tracker.db
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{pathlib.Path(tempfile.mkdtemp()) / 'payload.db'}"

from fastapi import HTTPException
from sqlalchemy import select

from app.db import SessionLocal, init_db
from app.evolution_ingest import build_simulated_payload, ingest_event
from app.models import Message, WaNumber
from app.routers.crm import get_contact, message_payload

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
    async with SessionLocal() as session:
        number = WaNumber(
            label="linha de teste",
            channel="evolution",
            evo_instance="inst-teste",
            phone_number_id="evo-inst-teste",
            webhook_token="tok",
        )
        session.add(number)
        await session.commit()

        payload = build_simulated_payload(
            instance="inst-teste",
            wa_id="5531999990001",
            name="Cliente Teste",
            text="Oi, vi o anuncio",
            ctwa_clid="ARAyCLIDteste",
            ad_id="12021",
            source_url="https://fb.me/x",
        )
        result = await ingest_event(session, payload, number)

        print("webhook -> mensagem gravada")
        check("uma mensagem entrou", result["messages"] == 1, result)
        check("o log do POST tem id", result.get("webhook_log_id") is not None, result)

        message = (await session.execute(select(Message))).scalars().one()
        check(
            "a mensagem aponta pro POST que a trouxe",
            message.webhook_log_id == result["webhook_log_id"],
            message.webhook_log_id,
        )

        print("conversa — o payload NAO viaja junto (anexo tem miniatura em base64)")
        detail = await get_contact(result["contact_ids"][0], session)
        thread = detail["messages"][0]
        check("sem raw na listagem", "raw" not in thread, sorted(thread))
        check("mas avisa que existe", thread["has_payload"] is True, thread)

        print("payload sob demanda — as duas camadas")
        data = await message_payload(message.id, session)
        check("raw e o objeto do WhatsApp", "key" in data["raw"] and "message" in data["raw"], sorted(data["raw"]))
        check(
            "o bloco do anuncio esta no raw",
            "externalAdReply" in str(data["raw"]),
            data["raw"],
        )
        envelope = data["webhook"]["payload"]
        check("o POST inteiro veio", envelope == payload, envelope)
        check("com envelope do evento", envelope["event"] == "messages.upsert", envelope.get("event"))
        check("e o resumo do que o sistema fez", data["webhook"]["summary"] == result["summary"], data["webhook"])
        check("do POST certo", data["webhook"]["id"] == result["webhook_log_id"], data["webhook"])

        print("mensagem sem POST — veio do 'puxar historico', nao do webhook")
        session.add(
            Message(contact_id=message.contact_id, wamid="HIST1", direction="in", body="antiga", raw={"key": {}})
        )
        await session.commit()
        old = (await session.execute(select(Message).where(Message.wamid == "HIST1"))).scalars().one()
        historic = await message_payload(old.id, session)
        check("webhook nulo em vez de erro", historic["webhook"] is None, historic)
        check("e o raw dela continua servido", historic["raw"] == {"key": {}}, historic["raw"])

        print("mensagem que nao existe")
        try:
            await message_payload(999_999, session)
            check("404", False, "nao levantou")
        except HTTPException as exc:
            check("404", exc.status_code == 404, exc.status_code)


asyncio.run(main())
print(f"\n{ok} ok, {fail} falha(s)")
sys.exit(1 if fail else 0)
