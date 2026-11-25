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


# ---------------------------------------------------------------- FE-01: geometria
from encontro_sp.graph import FORMAT_VERSION, load_or_build, polygon_rings, simplify_lines  # noqa: E402


def test_straight_segments_fallback_draws_two_way_street_once():
    g = grid_graph(3)  # 12 ruas de mão dupla = 24 arestas dirigidas
    assert len(g.src) == 24
    assert g.n_segments == 12
    assert len(g.edge_offsets) == g.n_segments + 1
    assert np.all(np.diff(g.edge_offsets) == 2)
    # a polilinha começa no nó edge_u e termina no edge_v
    s = 5
    a, b = g.edge_offsets[s], g.edge_offsets[s + 1]
    u, v = g.edge_u[s], g.edge_v[s]
    np.testing.assert_allclose(g.edge_coords[a], [g.lon[u], g.lat[u]], atol=1e-5)
    np.testing.assert_allclose(g.edge_coords[b - 1], [g.lon[v], g.lat[v]], atol=1e-5)


def test_simplify_lines_drops_collinear_points_and_keeps_ends():
    lat0 = -23.55
    straight = np.array([[-46.63 + i * 1e-4, lat0] for i in range(10)])  # reta, 10 pontos
    bend = np.array([[-46.63, lat0], [-46.629, lat0 + 0.001], [-46.628, lat0]])  # pico de ~110 m
    coords, offsets = simplify_lines([straight, bend], 5.0, lat0)
    assert list(np.diff(offsets)) == [2, 3]
    np.testing.assert_allclose(coords[0], straight[0], atol=1e-5)
    np.testing.assert_allclose(coords[1], straight[-1], atol=1e-5)
    assert coords.dtype == np.float32


def test_simplify_lines_empty():
    coords, offsets = simplify_lines([], 5.0, 0.0)
    assert coords.shape == (0, 2) and list(offsets) == [0]


def test_polygon_rings_handles_multipolygon_with_hole():
    from shapely.geometry import MultiPolygon, Polygon

    outer = [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)]
    hole = [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.4)]
    mp = MultiPolygon([Polygon(outer, [hole]), Polygon([(2, 2), (3, 2), (3, 3), (2, 2)])])
    rings = polygon_rings(mp)
    assert len(rings) == 3


def _osmnx_like_graph():
    """MultiDiGraph mínimo no formato do OSMnx: rua curva de mão dupla + rua reta de mão única."""
    import networkx as nx
    from shapely.geometry import LineString

    G = nx.MultiDiGraph(crs="epsg:4326")
    pts = {1: (-46.63, -23.55), 2: (-46.62, -23.55), 3: (-46.62, -23.54)}
    for n, (x, y) in pts.items():
        G.add_node(n, x=x, y=y)
    curve = LineString([pts[1], (-46.625, -23.545), pts[2]])
    G.add_edge(1, 2, length=1100.0, highway="residential", name="Rua A", maxspeed="40", geometry=curve)
    G.add_edge(2, 1, length=1100.0, highway="residential", name="Rua A",
               geometry=LineString(list(curve.coords)[::-1]))
    G.add_edge(2, 3, length=1100.0, highway="primary", name="Av B")
    G.add_edge(3, 1, length=1500.0, highway="primary", name="Av B")
    return G


def test_from_osmnx_keeps_curve_geometry_and_boundary():
    from shapely.geometry import Polygon

    box = Polygon([(-46.7, -23.6), (-46.5, -23.6), (-46.5, -23.5), (-46.7, -23.5)])
    g = RoadGraph.from_osmnx(_osmnx_like_graph(), boundary=box)
    assert g.n_segments == 3  # a mão dupla aparece uma vez só
    assert len(g.src) == 4
    counts = np.diff(g.edge_offsets)
    assert sorted(counts.tolist()) == [2, 2, 3]  # a curva manteve o ponto do meio
    assert len(g.boundary_offsets) == 2 and g.boundary_offsets[-1] == 5


def test_save_load_roundtrip_with_geometry(tmp_path):
    from shapely.geometry import Polygon

    box = Polygon([(-46.7, -23.6), (-46.5, -23.6), (-46.5, -23.5)])
    g = RoadGraph.from_osmnx(_osmnx_like_graph(), boundary=box)
    p = tmp_path / "g.npz"
    g.save(p)
    h = RoadGraph.load(p)
    assert h.format_version == FORMAT_VERSION
    for k in ("edge_u", "edge_v", "edge_coords", "edge_offsets", "boundary_coords", "boundary_offsets"):
        np.testing.assert_array_equal(getattr(h, k), getattr(g, k))


def test_old_cache_format_is_rebuilt(tmp_path, monkeypatch):
    g = grid_graph(3)
    path = tmp_path / "graph_drive.npz"
    # formato 1: sem geometria nem versão
    np.savez_compressed(
        path, lat=g.lat, lon=g.lon, src=g.src, dst=g.dst, time_s=g.time_s,
        length_m=g.length_m, eligible=g.eligible, street=np.asarray(g.street, dtype=str),
    )
    assert RoadGraph.load(path).format_version == 1

    import osmnx as ox
    from shapely.geometry import Polygon

    calls = []
    monkeypatch.setattr(ox, "graph_from_place", lambda place, network_type: calls.append(place) or _osmnx_like_graph())
    box = Polygon([(-46.7, -23.6), (-46.5, -23.6), (-46.5, -23.5)])
    import geopandas as gpd
    monkeypatch.setattr(ox, "geocode_to_gdf", lambda place: gpd.GeoDataFrame(geometry=[box]))
    h = load_or_build("Lugar", tmp_path)
    assert calls == ["Lugar"]
    assert h.format_version == FORMAT_VERSION and h.n_segments == 3
    # e o cache novo é reaproveitado
    assert load_or_build("Lugar", tmp_path).n_segments == 3 and calls == ["Lugar"]


def test_mesh_roundtrip_quantization_and_oneway():
    from encontro_sp import mesh

    g = RoadGraph(
        lat=np.array([-23.55, -23.55, -23.54]), lon=np.array([-46.63, -46.62, -46.62]),
        src=np.array([0, 1, 1]), dst=np.array([1, 0, 2]),
        time_s=np.array([10.0, 12.0, 30.0]), length_m=np.array([1000.0, 1000.0, 1100.0]),
        eligible=np.ones(3, dtype=bool),
    )
    header, a = mesh.decode(mesh.encode(g).blob)
    back = mesh.dequantize(a["coords"], header["bbox"])
    np.testing.assert_allclose(back, g.edge_coords, atol=2e-5)
    s = int(np.flatnonzero((a["seg_u"] == 1) & (a["seg_v"] == 2))[0])
    assert a["seg_t_uv"][s] == 300 and a["seg_t_vu"][s] == mesh.NO_WAY  # mão única 1→2
    s = int(np.flatnonzero((a["seg_u"] == 0) & (a["seg_v"] == 1))[0])
    assert a["seg_t_uv"][s] == 100 and a["seg_t_vu"][s] == 120
    assert abs(int(a["seg_len"][s]) - 1021) < 5  # ~0,01° de longitude em SP
