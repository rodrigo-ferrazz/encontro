"""Interface comum dos provedores de custo (pessoas × candidatos)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np


@dataclass(frozen=True)
class Point:
    lat: float
    lon: float
    node: int | None = None  # índice no grafo local, quando houver


@dataclass
class CostMatrix:
    """Custos de cada origem (linha) até cada candidato (coluna)."""

    time_s: np.ndarray  # [N, C]
    dist_m: np.ndarray  # [N, C]
    live: np.ndarray  # [N, C] bool: True se veio com trânsito ao vivo

    def metric(self, name: str) -> np.ndarray:
        if name in ("time", "tempo"):
            return self.time_s
        if name in ("length", "distance", "distancia", "distância"):
            return self.dist_m
        raise ValueError(f"métrica desconhecida: {name!r}")

    def merged_over(self, fallback: "CostMatrix") -> "CostMatrix":
        """Preenche as células que falharam (NaN) com os valores de `fallback`."""
        missing = ~np.isfinite(self.time_s) | ~np.isfinite(self.dist_m)
        return CostMatrix(
            time_s=np.where(missing, fallback.time_s, self.time_s),
            dist_m=np.where(missing, fallback.dist_m, self.dist_m),
            live=np.where(missing, fallback.live, self.live),
        )


class ProviderError(RuntimeError):
    """Falha recuperável (timeout, cota, resposta inválida): o solver cai para o local."""


class CostProvider(Protocol):
    name: str

    def matrix(self, origins: list[Point], candidates: list[Point]) -> CostMatrix: ...
