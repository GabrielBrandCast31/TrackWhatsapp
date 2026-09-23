"""Sincronizacao automatica do CRM de cada linha.

O webhook e o caminho em tempo real, mas ele falha calado: URL errada, tunel
morto, Evolution reiniciada sem o webhook configurado. Quando isso acontece o
lead do anuncio simplesmente nao aparece — e o `ctwaClid` dele fica parado na
Evolution. Este laco faz de tempos em tempos o mesmo que o botao "Sincronizar":
puxa as conversas novas e procura o anuncio na primeira mensagem de cada uma
(veja `crm.probe_ad_attribution`). Com isso a atribuicao chega mesmo sem webhook.

Historico sincronizado nao dispara regra de palavra-chave (veja o docstring de
`app.crm`); aqui so entra lead e atribuicao.
"""

import asyncio
import logging
import os

from app import crm
from app import numbers as numbers_service
from app import settings_store
from app.db import SessionLocal
from app.models import WaNumber

log = logging.getLogger(__name__)

# quanto tempo entre duas rodadas. 0 desliga o laco (util em teste)
INTERVAL_SECONDS = int(os.getenv("CRM_AUTO_SYNC_SECONDS", "300"))

# uma instancia travada nao pode segurar as outras linhas nem empilhar rodadas
SYNC_TIMEOUT = 120


async def sync_all() -> dict[int, dict]:
    """Um sync por linha conectada da Evolution. Devolve o resultado de cada uma."""
    results: dict[int, dict] = {}
    async with SessionLocal() as session:
        rows = await numbers_service.list_numbers(session, only_active=True, channel="evolution")
        global_cfg = await settings_store.load(session)
        targets = [
            (n.id, numbers_service.effective_cfg(global_cfg, n))
            for n in rows
            # linha fora do ar devolve erro em toda chamada: espera ela voltar
            if n.evo_base_url and n.evo_api_key and n.evo_instance and (n.evo_state or "") == "open"
        ]

    for number_id, cfg in targets:
        # sessao propria por linha: o erro de uma nao deixa a outra com transacao suja
        async with SessionLocal() as session:
            number = await session.get(WaNumber, number_id)
            if number is None:
                continue
            try:
                result = await asyncio.wait_for(
                    crm.sync_from_instance(session, number, cfg), timeout=SYNC_TIMEOUT
                )
            except Exception as exc:  # noqa: BLE001 — timeout incluso
                log.warning("sync automatico da linha %s falhou: %s", number_id, str(exc) or type(exc).__name__)
                continue
        results[number_id] = result
        if result.get("created") or result.get("attributed"):
            log.info(
                "sync automatico da linha %s: %s conversa(s) nova(s), %s lead(s) com anuncio",
                number_id,
                result.get("created", 0),
                result.get("attributed", 0),
            )
    return results


async def watch() -> None:
    """Laco de fundo. Nunca morre por erro de uma rodada — so registra e segue."""
    if INTERVAL_SECONDS <= 0:
        log.info("sync automatico do CRM desligado (CRM_AUTO_SYNC_SECONDS=0)")
        return
    log.info("sync automatico do CRM a cada %ss", INTERVAL_SECONDS)
    # deixa o monitor de estado rodar primeiro: sem ele `evo_state` pode estar velho
    await asyncio.sleep(15)
    while True:
        try:
            await sync_all()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("falha na rodada do sync automatico")
        await asyncio.sleep(INTERVAL_SECONDS)
