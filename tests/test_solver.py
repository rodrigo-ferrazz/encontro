import numpy as np
import pytest

from encontro_sp.providers import CostMatrix, ProviderError
from encontro_sp.solver import Person, Request, Solver, spatially_diverse

from .conftest import grid_graph, node_coord

N = 11


def people_corners():
    # Três pessoas em cantos da grade 11×11.
    return [
        Person("Ana", node_coord(N, 0, 0)),
        Person("Bia", node_coord(N, 0, 10)),
        Person("Caio", node_coord(N, 10, 0)),
    ]


def test_city_minimax_lands_in_the_middle(grid, geocoder):
    sol = Solver(grid, geocoder).solve(Request(people_corners(), objective="cidade", criterion="justo", k=3))
    best = sol.results[0]
    # Maior deslocamento mínimo possível: 10 arestas (100 s).
    assert best.time_s.max() == pytest.approx(100.0)
    assert not best.live.any()
    assert any("TOMTOM_API_KEY" in w for w in sol.warnings)


def test_city_results_are_spatially_diverse(grid, geocoder):
    sol = Solver(grid, geocoder).solve(
        Request(people_corners(), objective="cidade", criterion="total", k=5, diversity_m=300)
    )
    xy = grid.node_xy(np.array([r.node for r in sol.results]))
    d = np.hypot(*(xy[:, None, :] - xy[None, :, :]).transpose(2, 0, 1))
    assert d[np.triu_indices(len(xy), 1)].min() >= 300


def test_house_objective_returns_hosts(grid, geocoder):
    sol = Solver(grid, geocoder).solve(Request(people_corners(), objective="casa", criterion="total", k=3))
    assert len(sol.results) == 3
    assert sol.results[0].host == "Ana"  # canto (0,0) é vizinho dos outros dois
    i_ana = 0
    assert sol.results[0].time_s[i_ana] == 0.0


def test_limit_criterion(grid, geocoder):
    req = Request(people_corners(), objective="casa", criterion="limite", limit=100.0, k=3)
    sol = Solver(grid, geocoder).solve(req)
    assert [r.host for r in sol.results] == ["Ana"]
    req.limit = 10.0
    sol = Solver(grid, geocoder).solve(req)
    assert sol.results == [] and any("limite" in w for w in sol.warnings)


def test_distance_metric(grid, geocoder):
    sol = Solver(grid, geocoder).solve(Request(people_corners(), metric="distancia", k=1))
    assert sol.results[0].dist_m.max() == pytest.approx(1000.0)


def test_meeting_point_avoids_expressway(geocoder):
    g = grid_graph(N, expressway_row=5)
    people = [Person("A", node_coord(N, 0, 5)), Person("B", node_coord(N, 10, 5))]
    sol = Solver(g, geocoder).solve(Request(people, k=3))
    assert all(g.eligible[r.node] for r in sol.results)


class FakeLive:
    name = "fake"

    def __init__(self, factor=None, fail=False, nan_first=False):
        self.factor, self.fail, self.nan_first = factor, fail, nan_first
        self.calls = []

    def matrix(self, origins, candidates):
        self.calls.append((len(origins), len(candidates)))
        if self.fail:
            raise ProviderError("timeout")
        n, c = len(origins), len(candidates)
        t = np.array([[self.factor(o, k) for k in candidates] for o in origins], dtype=float)
        d = t * 10
        if self.nan_first:
            t[0, 0] = np.nan
        return CostMatrix(t, d, np.isfinite(t))


def test_live_refinement_reranks(grid, geocoder):
    # Trânsito fictício: tudo perto da coluna 0 fica muito lento.
    live = FakeLive(factor=lambda o, k: 1000.0 if abs(k.lon - grid.lon[0]) < 1e-9 else 50.0)
    sol = Solver(grid, geocoder, live).solve(Request(people_corners(), objective="casa", criterion="total", k=3))
    assert sol.live_used
    assert sol.results[0].host == "Bia"
    assert live.calls == [(3, 3)]


def test_live_failure_falls_back(grid, geocoder):
    sol = Solver(grid, geocoder, FakeLive(fail=True)).solve(Request(people_corners(), k=2))
    assert not sol.live_used and sol.results
    assert any("indisponível" in w for w in sol.warnings)


def test_partial_live_cells_marked(grid, geocoder):
    live = FakeLive(factor=lambda o, k: 60.0, nan_first=True)
    sol = Solver(grid, geocoder, live).solve(Request(people_corners(), objective="casa", k=3))
    all_live = np.array([r.live for r in sol.results])
    assert (~all_live).sum() == 1


def test_m_fits_free_tier(grid, geocoder):
    live = FakeLive(factor=lambda o, k: 60.0)
    Solver(grid, geocoder, live, max_cells=200).solve(Request(people_corners(), k=2, diversity_m=0))
    n, m = live.calls[0]
    assert n * m <= 200 and m == 30


def test_spatially_diverse():
    xy = np.array([[0, 0], [10, 0], [500, 0], [1000, 0]], dtype=float)
    assert list(spatially_diverse(np.arange(4), xy, 10, 400)) == [0, 2, 3]
    assert list(spatially_diverse(np.arange(4), xy, 2, 400)) == [0, 2]


def test_requires_two_people(grid, geocoder):
    with pytest.raises(ValueError):
        Solver(grid, geocoder).solve(Request([Person("A", node_coord(N, 0, 0))]))
