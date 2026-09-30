"""Marketing API do Meta: de qual campanha e um anuncio, e com que objetivo.

O WhatsApp entrega so o id do anuncio (`externalAdReply.sourceId`). Nome da
campanha, do conjunto e o objetivo moram na Marketing API:

    GET /{ad_id}?fields=name,adset{id,name,optimization_goal},campaign{id,name,objective}

A consulta precisa de token com `ads_read` na conta de anuncios. O token que o
Events Manager gera para a Conversions API normalmente NAO tem essa permissao —
por isso existe `meta_ads_token` separado (token de usuario do sistema do Business
Manager com `ads_read`). Sem ele, tenta-se o da CAPI, que funciona quando o mesmo
usuario do sistema foi usado para os dois.

O objetivo da campanha decide o evento de conversao que faz sentido devolver:
campanha de Leads otimiza por `Lead`, de Vendas por `Purchase`. O mapa padrao
esta em `OBJECTIVE_EVENTS` e cada linha pode sobrescrever em `objective_events`.
"""

import httpx

GRAPH = "https://graph.facebook.com"

# Sentinela de evento: "o evento que o objetivo da campanha pede". Regra de
# palavra-chave e disparo manual podem usar isto no lugar de um nome fixo; quem
# resolve e `app.campaigns.event_for_contact`, na hora do disparo.
OBJECTIVE_EVENT = "__objective__"

# Objetivos ODAX (atuais) e os legados, que campanha antiga ainda devolve.
OBJECTIVE_LABEL = {
    "OUTCOME_LEADS": "Cadastros",
    "OUTCOME_SALES": "Vendas",
    "OUTCOME_ENGAGEMENT": "Engajamento",
    "OUTCOME_TRAFFIC": "Tráfego",
    "OUTCOME_AWARENESS": "Reconhecimento",
    "OUTCOME_APP_PROMOTION": "Promoção do app",
    "LEAD_GENERATION": "Geração de cadastros",
    "CONVERSIONS": "Conversões",
    "PRODUCT_CATALOG_SALES": "Vendas do catálogo",
    "MESSAGES": "Mensagens",
    "POST_ENGAGEMENT": "Engajamento com publicação",
    "LINK_CLICKS": "Cliques no link",
    "REACH": "Alcance",
    "BRAND_AWARENESS": "Reconhecimento da marca",
    "APP_INSTALLS": "Instalações do app",
    "VIDEO_VIEWS": "Visualizações do vídeo",
}

# O evento que a campanha usa para otimizar. Engajamento/Mensagens otimiza por
# conversa iniciada — o evento leve (`Contact`) e o que conversa com ela.
OBJECTIVE_EVENTS = {
    "OUTCOME_LEADS": "Lead",
    "LEAD_GENERATION": "Lead",
    "OUTCOME_SALES": "Purchase",
    "CONVERSIONS": "Purchase",
    "PRODUCT_CATALOG_SALES": "Purchase",
    "OUTCOME_ENGAGEMENT": "Contact",
    "MESSAGES": "Contact",
    "POST_ENGAGEMENT": "Contact",
    "OUTCOME_TRAFFIC": "Contact",
    "LINK_CLICKS": "Contact",
    "OUTCOME_AWARENESS": "Contact",
    "REACH": "Contact",
    "BRAND_AWARENESS": "Contact",
    "VIDEO_VIEWS": "Contact",
    "OUTCOME_APP_PROMOTION": "CompleteRegistration",
    "APP_INSTALLS": "CompleteRegistration",
}

# Objetivos que aparecem no seletor de preenchimento manual e no mapa por linha.
EDITABLE_OBJECTIVES = (
    "OUTCOME_LEADS",
    "OUTCOME_SALES",
    "OUTCOME_ENGAGEMENT",
    "OUTCOME_TRAFFIC",
    "OUTCOME_AWARENESS",
    "OUTCOME_APP_PROMOTION",
)


class AdsError(Exception):
    pass


def ads_token(cfg: dict) -> str:
    return (cfg.get("meta_ads_token") or cfg.get("meta_capi_token") or "").strip()


def objective_label(objective: str | None) -> str | None:
    if not objective:
        return None
    return OBJECTIVE_LABEL.get(objective, objective.replace("OUTCOME_", "").replace("_", " ").title())


def event_for_objective(objective: str | None, cfg: dict) -> str | None:
    """Evento para o objetivo, olhando primeiro o mapa da linha. None = objetivo desconhecido."""
    if not objective:
        return None
    custom = cfg.get("objective_events") or {}
    if isinstance(custom, dict) and custom.get(objective):
        return str(custom[objective])
    return OBJECTIVE_EVENTS.get(objective)


async def fetch_ad(cfg: dict, ad_id: str) -> dict:
    """Campanha, conjunto e objetivo de um anuncio. Levanta AdsError com a mensagem do Meta."""
    token = ads_token(cfg)
    if not token:
        raise AdsError(
            "Sem token de anúncios: preencha o token com ads_read em Rastreamento → Meta."
        )

    version = cfg.get("graph_version") or "v21.0"
    fields = "name,adset{id,name,optimization_goal},campaign{id,name,objective}"
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(
                f"{GRAPH}/{version}/{ad_id}", params={"fields": fields, "access_token": token}
            )
    except httpx.HTTPError as exc:
        raise AdsError(f"Não consegui falar com a Graph API: {exc}") from exc

    try:
        body = resp.json()
    except ValueError as exc:
        raise AdsError(f"Resposta inválida da Graph API (HTTP {resp.status_code}).") from exc

    if isinstance(body, dict) and "error" in body:
        err = body["error"]
        msg = err.get("error_user_msg") or err.get("message") or "Erro desconhecido."
        raise AdsError(f"{msg} (code {err.get('code')})")

    adset = body.get("adset") or {}
    campaign = body.get("campaign") or {}
    return {
        "ad_name": body.get("name"),
        "adset_id": adset.get("id"),
        "adset_name": adset.get("name"),
        "optimization_goal": adset.get("optimization_goal"),
        "campaign_id": campaign.get("id"),
        "campaign_name": campaign.get("name"),
        "objective": campaign.get("objective"),
    }
