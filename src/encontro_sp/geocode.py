"""Geocodificação de endereços: TomTom Search (principal) e Nominatim (fallback), com cache."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import httpx

from .quota import QuotaExceeded, QuotaTracker

log = logging.getLogger(__name__)

# Centro aproximado de SP, usado para enviesar a busca.
SP_LAT, SP_LON = -23.5505, -46.6333
# viewbox (lon_min, lat_max, lon_max, lat_min) cobrindo o município.
SP_VIEWBOX = "-46.83,-23.35,-46.36,-24.01"
USER_AGENT = "encontro-sp/0.1 (personal non-commercial tool)"

_COORD_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


@dataclass(frozen=True)
class GeoPoint:
    lat: float
    lon: float
    label: str
    source: str


class GeocodeError(RuntimeError):
    pass


class Geocoder(Protocol):
    name: str

    def geocode(self, address: str) -> GeoPoint | None: ...


class TomTomGeocoder:
    name = "tomtom"
    URL = "https://api.tomtom.com/search/2/geocode/{q}.json"

    def __init__(self, api_key: str, client: httpx.Client, quota: QuotaTracker | None = None):
        self.api_key = api_key
        self.client = client
        self.quota = quota

    def geocode(self, address: str) -> GeoPoint | None:
        if self.quota:
            self.quota.check(1)
        r = self.client.get(
            self.URL.format(q=urllib.parse.quote(address, safe="")),
            params={
                "key": self.api_key,
                "countrySet": "BR",
                "limit": 1,
                "lat": SP_LAT,
                "lon": SP_LON,
                "radius": 60_000,
                "language": "pt-BR",
            },
        )
        if self.quota:
            self.quota.add(1)
        if r.status_code in (403, 429):
            raise QuotaExceeded(f"TomTom Search respondeu {r.status_code}")
        r.raise_for_status()
        results = r.json().get("results") or []
        if not results:
            return None
        top = results[0]
        pos = top["position"]
        label = top.get("address", {}).get("freeformAddress", address)
        return GeoPoint(float(pos["lat"]), float(pos["lon"]), label, self.name)


class NominatimGeocoder:
    """Nominatim público: no máximo 1 requisição por segundo e User-Agent identificável."""

    name = "nominatim"
    URL = "https://nominatim.openstreetmap.org/search"
    MIN_INTERVAL_S = 1.0
    _lock = threading.Lock()
    _last_call = 0.0

    def __init__(self, client: httpx.Client, sleep=time.sleep, clock=time.monotonic):
        self.client = client
        self._sleep = sleep
        self._clock = clock

    def _throttle(self) -> None:
        with self._lock:
            wait = NominatimGeocoder._last_call + self.MIN_INTERVAL_S - self._clock()
            if wait > 0:
                self._sleep(wait)
            NominatimGeocoder._last_call = self._clock()

    def geocode(self, address: str) -> GeoPoint | None:
        self._throttle()
        r = self.client.get(
            self.URL,
            params={
                "q": address,
                "format": "jsonv2",
                "limit": 1,
                "countrycodes": "br",
                "viewbox": SP_VIEWBOX,
                "bounded": 0,
                "accept-language": "pt-BR",
            },
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
        results = r.json()
        if not results:
            return None
        top = results[0]
        return GeoPoint(float(top["lat"]), float(top["lon"]), top.get("display_name", address), self.name)


class CachedGeocoder:
    """Tenta cada geocoder em ordem; resultados ficam em cache permanente em disco."""

    def __init__(self, geocoders: list[Geocoder], cache_path: Path):
        self.geocoders = geocoders
        self.cache_path = cache_path
        self.warnings: list[str] = []
        try:
            self._cache: dict = json.loads(cache_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            self._cache = {}

    @staticmethod
    def _key(address: str) -> str:
        return " ".join(address.lower().split())

    def _save(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(json.dumps(self._cache, ensure_ascii=False, indent=2))

    def geocode(self, address: str) -> GeoPoint:
        m = _COORD_RE.match(address)
        if m:  # "lat, lon" direto, sem consultar ninguém
            return GeoPoint(float(m.group(1)), float(m.group(2)), address.strip(), "coordenadas")

        key = self._key(address)
        if key in self._cache:
            c = self._cache[key]
            return GeoPoint(c["lat"], c["lon"], c["label"], c["source"] + " (cache)")

        query = address if re.search(r"s[ãa]o paulo", address, re.I) else f"{address}, São Paulo, SP"
        errors = []
        for g in self.geocoders:
            try:
                point = g.geocode(query)
            except (httpx.HTTPError, QuotaExceeded, KeyError, ValueError) as e:
                errors.append(f"{g.name}: {e}")
                log.warning("Geocoder %s falhou para %r: %s", g.name, address, e)
                continue
            if point is not None:
                self._cache[key] = point.__dict__
                self._save()
                return point
            errors.append(f"{g.name}: sem resultado")
        raise GeocodeError(f"não foi possível geocodificar {address!r} ({'; '.join(errors)})")
