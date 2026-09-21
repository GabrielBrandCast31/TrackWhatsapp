"""Estado das linhas sem depender do webhook.

O `evo_state` de cada linha era mantido SO pelo evento `connection.update`. Isso
tem um ponto cego grave: quando o webhook para de chegar — sessao caida, URL
errada, tunel morto — o campo congela no ultimo valor bom e a tela passa a jurar
que a linha esta conectada enquanto ela esta fora do ar. A falha que deveria
gritar vira silencio, e o unico sintoma e "nao chega mensagem nova".

Este laco pergunta o estado direto pra Evolution de tempos em tempos. E uma
chamada por linha, e fecha o caminho pelo qual a tela podia mentir: se a linha
caiu, `evo_state` reflete isso mesmo que nenhum webhook chegue nunca mais.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone

from app import numbers as numbers_service
from app import settings_store
from app.db import SessionLocal
from app.services import evolution

log = logging.getLogger(__name__)

# quanto tempo entre duas rodadas. 0 desliga o laco (util em teste)
INTERVAL_SECONDS = int(os.getenv("EVOLUTION_STATE_POLL_SECONDS", "60"))

# Evolution sem resposta nao pode segurar a rodada: o timeout padrao do cliente
# e de 25s, e com varias linhas isso empilharia ate passar do proprio intervalo.
PROBE_TIMEOUT = 8


async def refresh_states() -> int:
    """Pergunta o estado de cada linha da Evolution e grava. Devolve quantas mudaram."""
    changed = 0
    async with SessionLocal() as session:
        rows = await numbers_service.list_numbers(session, channel="evolution")
        if not rows:
            return 0
        global_cfg = await settings_store.load(session)

        for number in rows:
            if not (number.evo_base_url and number.evo_api_key and number.evo_instance):
                continue  # linha sem credencial: nao ha o que perguntar
            cfg = numbers_service.effective_cfg(global_cfg, number)
            before = number.evo_state
            try:
                info = await asyncio.wait_for(evolution.fetch_instance(cfg), timeout=PROBE_TIMEOUT)
            except Exception as exc:  # noqa: BLE001 — timeout incluso: e TimeoutError
                # A Evolution fora do ar tambem e informacao: a linha nao esta
                # conectada de verdade, so nao sabemos em que estado ela parou.
                number.last_error = str(exc) or type(exc).__name__
                number.evo_state = None
                if before is not None:
                    changed += 1
                    log.warning(
                        "linha %s (%s): nao consegui ler o estado — %s",
                        number.id,
                        number.evo_instance,
                        number.last_error,
                    )
                continue

            state = (info.get("state") or "").lower() or None
            number.evo_state = state
            number.last_error = None
            number.last_checked_at = datetime.now(timezone.utc)
            if info.get("owner_jid"):
                number.evo_owner_jid = info["owner_jid"]
            if info.get("profile_name"):
                number.verified_name = info["profile_name"]
            if state != before:
                changed += 1
                log.info(
                    "linha %s (%s): estado %s -> %s",
                    number.id,
                    number.evo_instance,
                    before or "desconhecido",
                    state or "desconhecido",
                )

        await session.commit()
    return changed


async def watch_states() -> None:
    """Laco de fundo. Nunca morre por erro de uma rodada — so registra e segue."""
    if INTERVAL_SECONDS <= 0:
        log.info("monitor de estado das linhas desligado (EVOLUTION_STATE_POLL_SECONDS=0)")
        return
    log.info("monitor de estado das linhas a cada %ss", INTERVAL_SECONDS)
    while True:
        try:
            await refresh_states()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("falha na rodada do monitor de estado")
        await asyncio.sleep(INTERVAL_SECONDS)
