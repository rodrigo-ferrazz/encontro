"""Fixtures binárias usadas pelos testes do front (web/test). Garante que os dois lados
falam o mesmo formato: se mudar `mesh.py`/`flood.py`, rode com UPDATE_FIXTURES=1."""

import os
from pathlib import Path

import pytest

from encontro_sp import flood, mesh, output
from encontro_sp.solver import Person, Request, Solver

from .conftest import grid_graph, node_coord

FIXTURES = Path(__file__).parent.parent / "web" / "test" / "fixtures"
N = 5


def build(geocoder) -> dict[str, bytes]:
    g = grid_graph(N)
    people = [Person("Ana", node_coord(N, 0, 0)), Person("Bia", node_coord(N, 4, 4))]
    sol = Solver(g, geocoder).solve(Request(people, k=2, live=False))
    return {
        "grid_mesh.bin": mesh.encode(g).blob,
        "grid_flood.bin": flood.build(sol, extra=output.to_dict(sol)).encode(),
    }


def test_web_fixtures_are_up_to_date(geocoder):
    blobs = build(geocoder)
    if os.getenv("UPDATE_FIXTURES"):
        FIXTURES.mkdir(parents=True, exist_ok=True)
        for name, b in blobs.items():
            (FIXTURES / name).write_bytes(b)
    for name, b in blobs.items():
        path = FIXTURES / name
        if not path.exists():
            pytest.fail(f"fixture ausente: {path} (rode UPDATE_FIXTURES=1 uv run pytest)")
        assert path.read_bytes() == b, f"{name} desatualizada: rode UPDATE_FIXTURES=1 uv run pytest"
