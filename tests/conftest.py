"""Grafo sintético (grade) perto do centro de SP, sem rede."""

from __future__ import annotations

import numpy as np
import pytest

from encontro_sp.geocode import CachedGeocoder
from encontro_sp.graph import RoadGraph

LAT0, LON0 = -23.55, -46.63
STEP = 0.001  # ~110 m


def grid_graph(n: int = 11, expressway_row: int | None = None) -> RoadGraph:
    """Grade n×n de mão dupla; cada aresta leva 10 s e mede ~100 m.

    `expressway_row` marca uma linha inteira como via expressa (nós inelegíveis).
    """
    idx = lambda r, c: r * n + c  # noqa: E731
    lat = np.array([LAT0 + r * STEP for r in range(n) for c in range(n)])
    lon = np.array([LON0 + c * STEP for r in range(n) for c in range(n)])
    src, dst = [], []
    for r in range(n):
        for c in range(n):
            if c + 1 < n:
                src += [idx(r, c), idx(r, c + 1)]
                dst += [idx(r, c + 1), idx(r, c)]
            if r + 1 < n:
                src += [idx(r, c), idx(r + 1, c)]
                dst += [idx(r + 1, c), idx(r, c)]
    e = len(src)
    eligible = np.ones(n * n, dtype=bool)
    if expressway_row is not None:
        eligible[[idx(expressway_row, c) for c in range(n)]] = False
    street = np.array([f"Rua {r}" for r in range(n) for c in range(n)], dtype=object)
    return RoadGraph(
        lat=lat, lon=lon,
        src=np.array(src), dst=np.array(dst),
        time_s=np.full(e, 10.0), length_m=np.full(e, 100.0),
        eligible=eligible, street=street,
    )


def node_coord(n: int, r: int, c: int) -> str:
    return f"{LAT0 + r * STEP}, {LON0 + c * STEP}"


@pytest.fixture
def grid():
    return grid_graph()


@pytest.fixture
def geocoder(tmp_path):
    # Sem geocoders externos: os testes usam endereços "lat, lon".
    return CachedGeocoder([], tmp_path / "geocode.json")
