"""Vinculo de uma linha com o numero dela na Cloud API oficial da Meta.

A Evolution conecta como aparelho pareado (WhatsApp Web) e nao tem nocao de
"qualidade do numero": isso e um dado que so a Meta calcula, e so pra numero
registrado num WABA. Quando o mesmo numero tambem esta na Cloud API (coexistencia
App + API), a linha Evolution guarda o Phone Number ID real da Meta e ganha duas
coisas:

* qualidade (GREEN/YELLOW/RED), limite de envio (tier) e status do numero;
* disparo por template aprovado, pela API oficial, sem sair da linha.

Linha `cloud` ja e o proprio numero na Meta: o vinculo e implicito.
"""

from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app import numbers as numbers_service
from app.models import WaNumber
from app.services import whatsapp_cloud


def has_meta(number: WaNumber) -> bool:
    """A linha consegue falar com a Graph API como numero de WhatsApp?"""
    if (number.channel or "evolution") == "cloud":
        return True
    # token proprio e obrigatorio: ver `cloud_cfg`
    return bool((number.meta_phone_number_id or "").strip() and number.access_token)


def cloud_cfg(global_cfg: dict, number: WaNumber) -> dict:
    """Config que o `whatsapp_cloud` entende, mesmo pra uma linha Evolution.

    Na linha Evolution o `phone_number_id` e a chave sintetica "evo:<instancia>",
    que a Meta nao conhece — aqui ele da lugar ao ID real do vinculo.

    Token e WABA vem SO da linha, nunca dos globais: quem edita a linha escolhe o
    Phone Number ID, e com o token global da plataforma poderia apontar pro numero
    de outro cliente e ler a qualidade, listar templates ou disparar como ele. Com
    token proprio, a propria Meta decide se aquele token enxerga aquele numero.
    """
    cfg = numbers_service.effective_cfg(global_cfg, number)
    if (number.channel or "evolution") != "cloud":
        cfg["wa_phone_number_id"] = (number.meta_phone_number_id or "").strip()
        cfg["wa_access_token"] = number.access_token or ""
        cfg["wa_business_account_id"] = (
            number.business_account_id or (number.overrides or {}).get("meta_waba_id") or ""
        )
    return cfg


async def refresh_quality(session: AsyncSession, number: WaNumber, cfg: dict) -> dict:
    """Busca qualidade/limite/status na Graph API e grava na linha. Nao levanta."""
    now = datetime.now(timezone.utc)
    number.quality_checked_at = now
    try:
        info = await whatsapp_cloud.phone_number_info(cfg)
    except Exception as exc:  # noqa: BLE001 — o motivo da Meta e o que a tela mostra
        number.quality_error = str(exc)
        await session.commit()
        return {"ok": False, "error": str(exc), **quality_of(number)}

    number.quality_rating = info.get("quality_rating")
    number.messaging_limit_tier = info.get("messaging_limit_tier")
    number.meta_status = info.get("status")
    number.quality_error = None
    if (number.channel or "evolution") == "cloud":
        number.display_phone_number = info.get("display_phone_number")
        number.verified_name = info.get("verified_name")
    elif not number.verified_name:
        number.verified_name = info.get("verified_name")
    await session.commit()
    return {"ok": True, "error": None, "raw": info, **quality_of(number)}


def quality_of(number: WaNumber) -> dict:
    """O pedaco da linha que a UI usa pra desenhar o selo de qualidade."""
    return {
        "meta_linked": has_meta(number),
        "quality_rating": number.quality_rating,
        "messaging_limit_tier": number.messaging_limit_tier,
        "meta_status": number.meta_status,
        "quality_checked_at": number.quality_checked_at,
        "quality_error": number.quality_error,
    }
