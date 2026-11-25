"""TomTom Matrix Routing v2 (síncrona), com trânsito ao vivo e saída imediata.

Limites do plano gratuito (Freemium): 200 células por requisição síncrona e 2.500
requisições "non-tile" por dia. A matriz é quebrada em blocos para caber em 200 células.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path

import httpx
import numpy as np

from ..quota import QuotaExceeded, QuotaTracker
from .base import CostMatrix, Point, ProviderError

log = logging.getLogger(__name__)


class TomTomProvider:
    name = "tomtom"
    URL = "https://api.tomtom.com/routing/matrix/2"

    def __init__(
        self,
        api_key: str,
        client: httpx.Client,
        quota: QuotaTracker,
        *,
        max_cells: int = 200,
        count_cells: bool = True,
        cache_path: Path | None = None,
        cache_ttl_s: int = 300,
        clock=time.time,
    ):
        self.api_key = api_key
        self.client = client
        self.quota = quota
        self.max_cells = max_cells
        self.count_cells = count_cells
        self.cache_path = cache_path
        self.cache_ttl_s = cache_ttl_s
        self._clock = clock

    # ------------------------------------------------------------------ planejamento
    def chunks(self, n_origins: int, n_candidates: int) -> list[slice]:
        if n_origins > self.max_cells:
            raise ProviderError(f"{n_origins} pessoas excedem {self.max_cells} células por requisição")
        per = max(self.max_cells // n_origins, 1)
        return [slice(s, min(s + per, n_candidates)) for s in range(0, n_candidates, per)]

    def units_for(self, n_origins: int, n_candidates: int) -> int:
        if self.count_cells:
            return n_origins * n_candidates
        return len(self.chunks(n_origins, n_candidates))

    # ------------------------------------------------------------------ cache curto
    def _cache_load(self) -> dict:
        if not self.cache_path:
            return {}
        try:
            data = json.loads(self.cache_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
        now = self._clock()
        return {k: v for k, v in data.items() if now - v["at"] <= self.cache_ttl_s}

    def _cache_save(self, data: dict) -> None:
        if self.cache_path:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(json.dumps(data))

    @staticmethod
    def _key(origins: list[Point], dests: list[Point]) -> str:
        pts = [(round(p.lat, 5), round(p.lon, 5)) for p in origins] + [None] + [
            (round(p.lat, 5), round(p.lon, 5)) for p in dests
        ]
        return hashlib.sha1(json.dumps(pts).encode()).hexdigest()

    # ------------------------------------------------------------------ chamada
    @staticmethod
    def _body(origins: list[Point], dests: list[Point]) -> dict:
        pt = lambda p: {"point": {"latitude": p.lat, "longitude": p.lon}}  # noqa: E731
        return {
            "origins": [pt(p) for p in origins],
            "destinations": [pt(p) for p in dests],
            "options": {
                "departAt": "now",
                "traffic": "live",
                "travelMode": "car",
                "routeType": "fastest",
            },
        }

    def _request(self, origins: list[Point], dests: list[Point]) -> dict:
        try:
            r = self.client.post(self.URL, params={"key": self.api_key}, json=self._body(origins, dests))
        except httpx.TimeoutException as e:
            raise ProviderError(f"timeout na TomTom: {e}") from e
        except httpx.HTTPError as e:
            raise ProviderError(f"erro de rede na TomTom: {e}") from e
        if r.status_code in (403, 429):
            raise ProviderError(f"TomTom recusou ({r.status_code}): cota estourada ou chave inválida")
        if r.status_code >= 400:
            raise ProviderError(f"TomTom respondeu {r.status_code}: {r.text[:200]}")
        try:
            return r.json()
        except ValueError as e:
            raise ProviderError("resposta inválida da TomTom") from e

    def matrix(self, origins: list[Point], candidates: list[Point]) -> CostMatrix:
        n, c = len(origins), len(candidates)
        time_s = np.full((n, c), np.nan)
        dist_m = np.full((n, c), np.nan)
        cache = self._cache_load()

        pending = []
        for sl in self.chunks(n, c):
            key = self._key(origins, candidates[sl])
            if key in cache:
                payload = cache[key]["data"]
                self._fill(payload, sl, time_s, dist_m)
            else:
                pending.append((sl, key))

        if pending:
            units = sum(
                (n * (sl.stop - sl.start)) if self.count_cells else 1 for sl, _ in pending
            )
            try:
                self.quota.check(units)
            except QuotaExceeded as e:
                raise ProviderError(str(e)) from e

        for sl, key in pending:
            data = self._request(origins, candidates[sl])
            self.quota.add(n * (sl.stop - sl.start) if self.count_cells else 1)
            self._fill(data, sl, time_s, dist_m)
            cache[key] = {"at": self._clock(), "data": data}
        if pending:
            self._cache_save(cache)

        live = np.isfinite(time_s) & np.isfinite(dist_m)
        if not live.any():
            raise ProviderError("TomTom não devolveu nenhuma rota válida")
        if not live.all():
            log.warning("TomTom: %d de %d células sem rota; usando estimativa local nelas",
                        (~live).sum(), live.size)
        return CostMatrix(time_s=time_s, dist_m=dist_m, live=live)

    @staticmethod
    def _fill(data: dict, sl: slice, time_s: np.ndarray, dist_m: np.ndarray) -> None:
        for cell in data.get("data", []):
            summary = cell.get("routeSummary")
            if not summary:
                continue  # célula com detailedError: fica NaN e cai para o local
            i = int(cell["originIndex"])
            j = sl.start + int(cell["destinationIndex"])
            time_s[i, j] = float(summary["travelTimeInSeconds"])
            dist_m[i, j] = float(summary["lengthInMeters"])
