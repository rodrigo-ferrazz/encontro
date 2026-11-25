import numpy as np

from encontro_sp.graph import RoadGraph

from .conftest import grid_graph


def test_parallel_edges_keep_fastest_and_drop_loops():
    g = RoadGraph(
        lat=np.array([0.0, 0.0]), lon=np.array([0.0, 0.001]),
        src=np.array([0, 0, 1, 1]), dst=np.array([1, 1, 0, 1]),
        time_s=np.array([50.0, 20.0, 30.0, 5.0]), length_m=np.array([500.0, 300.0, 300.0, 1.0]),
        eligible=np.ones(2, dtype=bool),
    )
    assert len(g.src) == 2
    assert g.csr("time")[0, 1] == 20.0
    assert g.csr("length")[0, 1] == 300.0


def test_oneway_is_respected():
    # 0 → 1 direto (10 s); 1 → 0 só pelo desvio 1 → 2 → 0 (100 s).
    g = RoadGraph(
        lat=np.zeros(3), lon=np.array([0.0, 0.001, 0.002]),
        src=np.array([0, 1, 2]), dst=np.array([1, 2, 0]),
        time_s=np.array([10.0, 50.0, 50.0]), length_m=np.array([100.0, 500.0, 500.0]),
        eligible=np.ones(3, dtype=bool),
    )
    d = g.shortest_from(np.array([0, 1]), "time")
    assert d[0, 1] == 10.0
    assert d[1, 0] == 100.0


def test_snap_skips_expressway():
    g = grid_graph(5, expressway_row=2)
    target = 2 * 5 + 2  # nó no meio da via expressa
    node, _ = g.snap(g.lat[target], g.lon[target], eligible_only=True)
    assert node != target and g.eligible[node]
    node_any, d = g.snap(g.lat[target], g.lon[target], eligible_only=False)
    assert node_any == target and d < 1e-6


def test_path_cost_follows_fastest_path():
    g = grid_graph(5)
    dist, pred = g.shortest_from(np.array([0]), "time", predecessors=True)
    assert g.path_cost(pred[0], 0, 24, "length") == 800.0  # 8 arestas de 100 m
    assert g.path_cost(pred[0], 0, 0, "length") == 0.0


def test_save_load_roundtrip(tmp_path):
    g = grid_graph(4)
    p = tmp_path / "g.npz"
    g.save(p)
    h = RoadGraph.load(p)
    assert h.n_nodes == g.n_nodes
    np.testing.assert_array_equal(h.src, g.src)
    assert h.street[5] == g.street[5]
