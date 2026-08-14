"""Geolocalizacao da varredura: endereco -> coordenada -> area de busca circular.

O geocoder e o Nominatim (OpenStreetMap): nao pede chave e a politica de uso exige
um User-Agent identificando a aplicacao. Como e 1 request por busca criada, cabe
folgado no limite de 1 req/s deles.
"""

import math

import httpx

NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "wpp-conversion-tracker/0.2 (prospeccao interna)"

EARTH_RADIUS_KM = 6371.0


class GeoError(Exception):
    pass


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Distancia em km entre dois pontos. Usada pra filtrar o que caiu fora do raio."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def circle_geolocation(lat: float, lng: float, radius_km: float) -> dict:
    """Area de busca do actor do Apify.

    GeoJSON com a ordem de coordenada que eles pedem: [longitude, latitude].
    """
    return {"type": "Point", "coordinates": [lng, lat], "radiusKm": radius_km}


async def geocode(query: str, limit: int = 5, country: str = "br") -> list[dict]:
    """Converte texto livre ('Av Paulista 1000, Sao Paulo') em candidatos de coordenada."""
    if not query or not query.strip():
        raise GeoError("Informe um endereco, bairro ou cidade para buscar.")

    params = {
        "q": query.strip(),
        "format": "jsonv2",
        "limit": str(limit),
        "addressdetails": "1",
    }
    if country:
        params["countrycodes"] = country

    try:
        async with httpx.AsyncClient(timeout=20, headers={"User-Agent": USER_AGENT}) as client:
            resp = await client.get(NOMINATIM, params=params)
    except httpx.HTTPError as exc:
        raise GeoError(f"Nao consegui falar com o geocoder: {exc}") from exc

    if resp.status_code != 200:
        raise GeoError(f"Geocoder respondeu HTTP {resp.status_code}.")

    try:
        rows = resp.json()
    except ValueError as exc:
        raise GeoError("Resposta invalida do geocoder.") from exc

    out = []
    for row in rows if isinstance(rows, list) else []:
        try:
            out.append(
                {
                    "label": row.get("display_name") or "",
                    "lat": float(row["lat"]),
                    "lng": float(row["lon"]),
                    "kind": row.get("type") or row.get("category"),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    return out
