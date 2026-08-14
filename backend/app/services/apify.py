"""Cliente do Apify para a varredura de potenciais clientes no Google Maps.

O actor padrao e o `compass/crawler-google-places`. A busca por raio nao e um
parametro dele: a gente entrega a area em `customGeolocation` como um GeoJSON
Point com `radiusKm` (a ordem da coordenada e [longitude, latitude]).

O actor ainda devolve alguns lugares um pouco fora da borda do circulo — o Google
raciocina por viewport, nao por raio exato. Por isso o import recalcula a distancia
com haversine e descarta o que passou do raio pedido.
"""

import asyncio

import httpx

from app.phones import classify, to_e164
from app.services.geo import haversine_km

APIFY = "https://api.apify.com/v2"
DEFAULT_ACTOR = "compass/crawler-google-places"

# status do run que significam "acabou"
TERMINAL = {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMING-OUT"}


class ApifyError(Exception):
    pass


def _token(cfg: dict) -> str:
    token = (cfg.get("apify_token") or "").strip()
    if not token:
        raise ApifyError("Token do Apify nao configurado — preencha em Prospecção → Configuração.")
    return token


def _actor_path(actor: str | None) -> str:
    """`compass/crawler-google-places` -> `compass~crawler-google-places` (formato da URL)."""
    return (actor or DEFAULT_ACTOR).strip().replace("/", "~")


def build_input(
    *,
    terms: list[str],
    lat: float,
    lng: float,
    radius_km: float,
    max_per_term: int,
    language: str = "pt-BR",
    skip_closed: bool = True,
    min_stars: str = "",
    website: str = "allPlaces",
    scrape_contacts: bool = False,
) -> dict:
    """Monta o input do actor. Fica gravado no banco pra auditoria da busca."""
    payload: dict = {
        "searchStringsArray": terms,
        "customGeolocation": {"type": "Point", "coordinates": [lng, lat], "radiusKm": radius_km},
        "maxCrawledPlacesPerSearch": max_per_term,
        "language": language,
        "skipClosedPlaces": skip_closed,
        "scrapePlaceDetailPage": False,
        "maxReviews": 0,
        "maxImages": 0,
        "maxQuestions": 0,
    }
    if min_stars:
        payload["placeMinimumStars"] = min_stars
    if website and website != "allPlaces":
        payload["website"] = website
    if scrape_contacts:
        # sobe o custo por lugar, mas traz e-mail e redes sociais do site da empresa
        payload["scrapeContacts"] = True
    return payload


async def start_run(cfg: dict, actor: str | None, run_input: dict) -> dict:
    """Dispara o actor. Nao espera terminar — devolve o id do run e do dataset."""
    url = f"{APIFY}/acts/{_actor_path(actor)}/runs"
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, params={"token": _token(cfg)}, json=run_input)
    except httpx.HTTPError as exc:
        raise ApifyError(f"Falha ao chamar o Apify: {exc}") from exc

    data = _unwrap(resp)
    return {
        "run_id": data.get("id"),
        "dataset_id": data.get("defaultDatasetId"),
        "status": data.get("status"),
    }


async def run_status(cfg: dict, run_id: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{APIFY}/actor-runs/{run_id}", params={"token": _token(cfg)})
    except httpx.HTTPError as exc:
        raise ApifyError(f"Falha ao consultar o run: {exc}") from exc

    data = _unwrap(resp)
    stats = data.get("stats") or {}
    return {
        "status": data.get("status"),
        "dataset_id": data.get("defaultDatasetId"),
        "cost_usd": data.get("usageTotalUsd"),
        "items": stats.get("outputItemCount") or stats.get("datasetItemCount"),
        "finished_at": data.get("finishedAt"),
        "message": (data.get("statusMessage") or "") or None,
    }


async def abort_run(cfg: dict, run_id: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{APIFY}/actor-runs/{run_id}/abort", params={"token": _token(cfg)})
    except httpx.HTTPError as exc:
        raise ApifyError(f"Falha ao abortar o run: {exc}") from exc
    return _unwrap(resp)


async def dataset_items(cfg: dict, dataset_id: str, limit: int = 1000) -> list[dict]:
    """Puxa o resultado da varredura, paginando ate o fim (ou ate `limit`)."""
    items: list[dict] = []
    offset = 0
    page = 500

    async with httpx.AsyncClient(timeout=90) as client:
        while len(items) < limit:
            params = {
                "token": _token(cfg),
                "offset": str(offset),
                "limit": str(min(page, limit - len(items))),
                "clean": "true",
            }
            try:
                resp = await client.get(f"{APIFY}/datasets/{dataset_id}/items", params=params)
            except httpx.HTTPError as exc:
                raise ApifyError(f"Falha ao baixar o dataset: {exc}") from exc

            if resp.status_code >= 400:
                raise ApifyError(f"Apify respondeu HTTP {resp.status_code} ao ler o dataset.")
            try:
                batch = resp.json()
            except ValueError as exc:
                raise ApifyError("Resposta invalida do dataset.") from exc

            if not isinstance(batch, list) or not batch:
                break
            items.extend(batch)
            offset += len(batch)
            if len(batch) < page:
                break

    return items


async def wait_for_run(cfg: dict, run_id: str, timeout_s: int = 600, interval_s: int = 5) -> dict:
    """Poll ate o run terminar. Usado pelo modo sincrono de teste."""
    waited = 0
    info = await run_status(cfg, run_id)
    while info.get("status") not in TERMINAL and waited < timeout_s:
        await asyncio.sleep(interval_s)
        waited += interval_s
        info = await run_status(cfg, run_id)
    return info


def _first_email(item: dict) -> str | None:
    for key in ("emails", "email"):
        val = item.get(key)
        if isinstance(val, list) and val:
            return str(val[0])[:240]
        if isinstance(val, str) and val:
            return val[:240]
    return None


def normalize_place(item: dict, center: tuple[float, float] | None = None) -> dict:
    """Item do dataset -> campos do Prospect.

    Defensivo de proposito: o actor muda campos entre versoes, e um lugar sem
    telefone ainda tem valor no CRM (da pra abordar pelo site).
    """
    location = item.get("location") or {}
    lat = location.get("lat")
    lng = location.get("lng")

    phone_raw = item.get("phoneUnformatted") or item.get("phone")
    phone_e164 = to_e164(phone_raw)

    distance = None
    if center and isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        distance = round(haversine_km(center[0], center[1], float(lat), float(lng)), 3)

    return {
        "place_id": item.get("placeId") or item.get("fid") or None,
        "name": (item.get("title") or "Sem nome")[:240],
        "category": (item.get("categoryName") or "")[:160] or None,
        "address": item.get("address"),
        "city": (item.get("city") or "")[:120] or None,
        "state": (item.get("state") or "")[:120] or None,
        "phone_raw": (str(phone_raw)[:48] if phone_raw else None),
        "phone_e164": phone_e164,
        "phone_kind": classify(phone_e164) if phone_e164 else None,
        "website": item.get("website"),
        "email": _first_email(item),
        "rating": item.get("totalScore"),
        "reviews_count": item.get("reviewsCount"),
        "lat": float(lat) if isinstance(lat, (int, float)) else None,
        "lng": float(lng) if isinstance(lng, (int, float)) else None,
        "distance_km": distance,
        "maps_url": item.get("url"),
        "permanently_closed": bool(item.get("permanentlyClosed") or item.get("temporarilyClosed")),
    }


def _unwrap(resp: httpx.Response) -> dict:
    try:
        body = resp.json()
    except ValueError:
        raise ApifyError(f"Resposta invalida do Apify (HTTP {resp.status_code}).") from None

    if isinstance(body, dict) and "error" in body:
        err = body["error"] or {}
        msg = err.get("message") or "Erro desconhecido."
        raise ApifyError(f"{msg} (type {err.get('type')})")
    if resp.status_code >= 400:
        raise ApifyError(f"Apify respondeu HTTP {resp.status_code}.")

    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise ApifyError("Apify nao devolveu o objeto esperado.")
    return data


async def account_info(cfg: dict) -> dict:
    """Prova que o token vale e mostra quanto de credito ainda tem."""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{APIFY}/users/me", params={"token": _token(cfg)})
    except httpx.HTTPError as exc:
        raise ApifyError(f"Falha ao falar com o Apify: {exc}") from exc

    data = _unwrap(resp)
    plan = data.get("plan") or {}
    return {
        "username": data.get("username"),
        "email": data.get("email"),
        "plan": plan.get("id"),
        "monthly_credits_usd": plan.get("monthlyUsageCreditsUsd"),
    }
