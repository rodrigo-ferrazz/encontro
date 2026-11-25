"""Critérios de escolha (strategy + registry).

Cada critério recebe `costs[N, C]` (custo de cada pessoa até cada candidato) e devolve duas
chaves por candidato, `(primária, desempate)`, onde menor é melhor e `inf` significa
candidato inválido. Tudo é vetorizado, então roda sobre centenas de milhares de nós.

Para adicionar um critério novo basta decorar uma função com `@register(...)`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

Keys = tuple[np.ndarray, np.ndarray]
ScoreFn = Callable[..., Keys]


@dataclass(frozen=True)
class Criterion:
    name: str
    label: str
    fn: ScoreFn
    needs_limit: bool = False

    def score(self, costs: np.ndarray, **params) -> Keys:
        costs = np.asarray(costs, dtype=float)
        if costs.ndim != 2:
            raise ValueError("costs deve ter formato [pessoas, candidatos]")
        if self.needs_limit and params.get("limit") is None:
            raise ValueError(f"o critério {self.name!r} exige um limite (--limite)")
        primary, secondary = self.fn(costs, **params)
        # Candidato inalcançável por alguém nunca é válido.
        bad = ~np.isfinite(costs).all(axis=0)
        primary = np.where(bad, np.inf, primary)
        return primary, secondary


REGISTRY: dict[str, Criterion] = {}
ALIASES: dict[str, str] = {}


def register(name: str, label: str, *, aliases: tuple[str, ...] = (), needs_limit: bool = False):
    def deco(fn: ScoreFn) -> ScoreFn:
        REGISTRY[name] = Criterion(name, label, fn, needs_limit)
        for a in (name, *aliases):
            ALIASES[a] = name
        return fn

    return deco


def get(name: str) -> Criterion:
    key = ALIASES.get(str(name).lower())
    if key is None:
        raise KeyError(f"critério desconhecido: {name!r}. Opções: {', '.join(REGISTRY)}")
    return REGISTRY[key]


def rank(primary: np.ndarray, secondary: np.ndarray, k: int | None = None) -> np.ndarray:
    """Índices dos candidatos válidos, do melhor para o pior (ordem lexicográfica)."""
    valid = np.flatnonzero(np.isfinite(primary))
    order = valid[np.lexsort((secondary[valid], primary[valid]))]
    return order if k is None else order[:k]


# ---------------------------------------------------------------------- critérios


@register("justo", "Mais justo: minimiza o maior deslocamento", aliases=("minimax", "1"))
def _minimax(costs: np.ndarray, **_) -> Keys:
    return costs.max(axis=0), costs.sum(axis=0)


@register("total", "Menor custo total somado do grupo", aliases=("soma", "sum", "2"))
def _total(costs: np.ndarray, **_) -> Keys:
    return costs.sum(axis=0), costs.max(axis=0)


@register(
    "igualitario",
    "Mais igualitário: minimiza a diferença entre o maior e o menor deslocamento",
    aliases=("igualitário", "equidade", "range", "3"),
)
def _equal(costs: np.ndarray, resolution: float = 0.0, limit: float | None = None, **_) -> Keys:
    # A diferença pura tem um defeito: pontos MUITO longe de todos podem ser "iguais"
    # (ex.: qualquer ponto na mediatriz entre duas pessoas). Por isso a diferença é
    # discretizada em faixas de `resolution` (ex.: 2 min) e, dentro da mesma faixa,
    # desempata pelo maior deslocamento, o que puxa o ponto para perto do grupo.
    spread = costs.max(axis=0) - costs.min(axis=0)
    spread = np.nan_to_num(spread, nan=np.inf)
    if resolution > 0:
        spread = np.floor(spread / resolution)
    if limit is not None:  # teto opcional: igualdade só entre pontos onde ninguém passa de X
        spread = np.where(costs.max(axis=0) <= limit, spread, np.inf)
    return spread, costs.max(axis=0)


@register(
    "limite",
    "Limite máximo: ninguém passa de X; entre os válidos vence o menor total",
    aliases=("limit", "4"),
    needs_limit=True,
)
def _limit(costs: np.ndarray, limit: float | None = None, **_) -> Keys:
    total = costs.sum(axis=0)
    ok = costs.max(axis=0) <= limit
    return np.where(ok, total, np.inf), costs.max(axis=0)
