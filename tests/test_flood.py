import gzip

import numpy as np
import pytest

from encontro_sp import flood, output
from encontro_sp.solver import Person, Request, Solver

from .conftest import node_coord

N = 11


def corners():
    return [
        Person("Ana", node_coord(N, 0, 0)),
        Person("Bia", node_coord(N, 0, 10)),
        Person("Caio", node_coord(N, 10, 0)),
    ]


@pytest.fixture
def sol(grid, geocoder):
    return Solver(grid, geocoder).solve(Request(corners(), criterion="justo", k=3))


def test_solution_exposes_full_dijkstra(sol, grid):
    assert sol.weight == "time"
    assert sol.dist.shape == (3, grid.n_nodes)
    assert sol.pred.shape == (3, grid.n_nodes)
    assert sol.dist[0, 0] == 0.0  # Ana está no nó (0, 0)


def test_t_star_is_winner_max_travel_for_minimax(sol):
    data = flood.build(sol)
    assert data.t_star == pytest.approx(sol.results[0].time_s.max())
    assert data.t_star == pytest.approx(100.0)
    assert data.t_end == pytest.approx(115.0)
    assert data.meeting_node == sol.results[0].node


def test_arrival_is_rounded_and_cut_after_t_end(sol):
    data = flood.build(sol)
    a = data.arrival
    assert a.dtype == np.uint16 and a.shape == sol.dist.shape
    near = sol.dist <= data.t_end
    np.testing.assert_array_equal(a[near], np.rint(sol.dist[near]))
    assert np.all(a[~near] == flood.UNREACHED)
    # Ana chega ao canto oposto (20 arestas = 200 s) depois do fim: "não alcançado"
    assert a[0, N * N - 1] == flood.UNREACHED


def test_encode_decode_roundtrip_with_ranking(sol):
    extra = output.to_dict(sol)
    blob = flood.build(sol, extra=extra).encode()
    assert blob[:4] == b"ENCF"
    hlen = int.from_bytes(blob[4:8], "little")
    assert (8 + hlen) % 8 == 0  # arrays alinhados para typed arrays no JS
    back = flood.decode(blob)
    np.testing.assert_array_equal(back.arrival, flood.build(sol).arrival)
    assert back.extra["resultados"][0]["rank"] == 1
    assert back.unit == "s"


def test_distance_metric_uses_meters(grid, geocoder):
    sol = Solver(grid, geocoder).solve(Request(corners(), criterion="justo", metric="distancia", k=1))
    data = flood.build(sol)
    assert data.unit == "m"
    assert data.t_star == pytest.approx(1000.0)


def test_values_saturate_below_unreached():
    from encontro_sp.solver import Solution
    from encontro_sp import criteria

    dist = np.array([[0.0, 70000.0, np.inf], [10.0, 20.0, 30.0]])
    sol = Solution(None, [], [], criteria.get("justo"), False, 0, 0, dist=dist)
    data = flood.build(sol)
    assert data.meeting_node is None
    assert data.arrival.max() <= flood.UNREACHED
    assert data.arrival[0, 2] == flood.UNREACHED


def test_compresses_well(sol):
    blob = flood.build(sol).encode()
    assert len(gzip.compress(blob)) < len(blob)


def test_routes_go_from_each_person_to_each_result(sol, grid):
    data = flood.build(sol)
    assert len(data.routes) == len(sol.results)
    for r, per_person in zip(sol.results, data.routes):
        for p, path in zip(sol.people, per_person):
            assert path[0] == p.node and path[-1] == r.node
            # arestas consecutivas existem no grafo e o tempo bate com o Dijkstra
            assert len(path) - 1 == round(sol.dist[sol.people.index(p), r.node] / 10)
    back = flood.decode(data.encode())
    assert back.routes == data.routes
