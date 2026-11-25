"""Malha viária: download via OSMnx, limpeza, pesos e cache compacto em disco.

O grafo é guardado como arrays NumPy (arestas + coordenadas dos nós) num `.npz`, o que
carrega em menos de um segundo, contra dezenas de segundos de um GraphML.

Além do grafo de roteamento, o cache guarda a geometria para desenhar o mapa:

- `edge_coords` [P, 2] float32 (lon, lat) e `edge_offsets` [S+1]: as polilinhas das ruas,
  uma por trecho *não dirigido* (uma rua de mão dupla é desenhada uma vez só), já
  simplificadas (Douglas-Peucker, ~5 m). O trecho `s` vai de `edge_u[s]` até `edge_v[s]`
  (índices de nós), e a polilinha começa no nó `edge_u[s]`.
- `boundary_coords` [Q, 2] e `boundary_offsets` [R+1]: os anéis do contorno do município.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

log = logging.getLogger(__name__)

# Vias onde não faz sentido marcar um encontro (nem "morar").
EXPRESSWAYS = frozenset({"motorway", "motorway_link", "trunk", "trunk_link"})
# maxspeed do OSM é limite, não velocidade média; em SP a média urbana é bem menor.
URBAN_SPEED_FACTOR = 0.6
# Peso mínimo de aresta (evita arestas de custo zero no Dijkstra).
MIN_WEIGHT = 1e-3

WEIGHTS = ("time", "length")
# Versão do formato do `.npz`. Suba quando mudar o que é gravado: caches antigos são refeitos.
#   1: só o grafo de roteamento.  2: + geometria das ruas e contorno do município.
FORMAT_VERSION = 2
# Tolerância do Douglas-Peucker (metros) para as ruas e para o contorno.
SIMPLIFY_STREETS_M = 5.0
SIMPLIFY_BOUNDARY_M = 20.0
EARTH_M_PER_DEG_LAT = 110_540.0
EARTH_M_PER_DEG_LON_EQ = 111_320.0


@dataclass
class RoadGraph:
    """Grafo dirigido (mão única respeitada) já restrito ao maior componente fortemente conexo."""

    lat: np.ndarray  # [V]
    lon: np.ndarray  # [V]
    src: np.ndarray  # [E] índice do nó de origem
    dst: np.ndarray  # [E] índice do nó de destino
    time_s: np.ndarray  # [E] tempo estimado (sem trânsito)
    length_m: np.ndarray  # [E]
    eligible: np.ndarray  # [V] bool: pode ser ponto de encontro / snap de endereço
    street: np.ndarray = field(default=None)  # [V] nome de uma via que passa pelo nó
    # Geometria para desenho (ver docstring do módulo). Sem ela, cada trecho vira uma reta
    # entre os dois nós (útil nos testes com grafo sintético).
    edge_u: np.ndarray = field(default=None)  # [S] int32
    edge_v: np.ndarray = field(default=None)  # [S] int32
    edge_coords: np.ndarray = field(default=None)  # [P, 2] float32 (lon, lat)
    edge_offsets: np.ndarray = field(default=None)  # [S+1] int64
    boundary_coords: np.ndarray = field(default=None)  # [Q, 2] float32 (lon, lat)
    boundary_offsets: np.ndarray = field(default=None)  # [R+1] int64
    format_version: int = FORMAT_VERSION

    def __post_init__(self) -> None:
        if self.street is None:
            self.street = np.full(len(self.lat), "", dtype=object)
        self._dedupe_edges()
        if self.edge_coords is None:
            self._straight_segments()
        if self.boundary_coords is None:
            self.boundary_coords = np.zeros((0, 2), dtype=np.float32)
            self.boundary_offsets = np.zeros(1, dtype=np.int64)

    # ------------------------------------------------------------------ estrutura
    @property
    def n_nodes(self) -> int:
        return len(self.lat)

    def _dedupe_edges(self) -> None:
        """Remove laços e arestas paralelas (fica a mais rápida). A CSR somaria duplicatas."""
        keep = self.src != self.dst
        src, dst = self.src[keep], self.dst[keep]
        t, l = self.time_s[keep], self.length_m[keep]
        order = np.lexsort((t, dst, src))
        src, dst, t, l = src[order], dst[order], t[order], l[order]
        first = np.ones(len(src), dtype=bool)
        first[1:] = (src[1:] != src[:-1]) | (dst[1:] != dst[:-1])
        self.src = src[first].astype(np.int32)
        self.dst = dst[first].astype(np.int32)
        self.time_s = np.maximum(t[first], MIN_WEIGHT).astype(np.float64)
        self.length_m = np.maximum(l[first], MIN_WEIGHT).astype(np.float64)

    def _straight_segments(self) -> None:
        """Um trecho reto por par não dirigido de nós ligados (fallback sem geometria)."""
        a, b = np.minimum(self.src, self.dst), np.maximum(self.src, self.dst)
        pairs = np.unique(np.column_stack([a, b]), axis=0) if len(a) else np.zeros((0, 2), int)
        self.edge_u = pairs[:, 0].astype(np.int32)
        self.edge_v = pairs[:, 1].astype(np.int32)
        ends = np.stack([pairs[:, 0], pairs[:, 1]], axis=1).reshape(-1)
        self.edge_coords = np.column_stack([self.lon[ends], self.lat[ends]]).astype(np.float32)
        self.edge_offsets = np.arange(0, 2 * len(pairs) + 1, 2, dtype=np.int64)

    @property
    def n_segments(self) -> int:
        return len(self.edge_u)

    def csr(self, weight: str) -> csr_matrix:
        if weight not in WEIGHTS:
            raise ValueError(f"peso desconhecido: {weight!r} (use {WEIGHTS})")
        cache = self.__dict__.setdefault("_csr_cache", {})
        if weight not in cache:
            data = self.time_s if weight == "time" else self.length_m
            cache[weight] = csr_matrix(
                (data, (self.src, self.dst)), shape=(self.n_nodes, self.n_nodes)
            )
        return cache[weight]

    # ------------------------------------------------------------------ geometria
    @cached_property
    def _lat0(self) -> float:
        return float(np.mean(self.lat))

    def project(self, lat, lon) -> np.ndarray:
        """Projeção equiretangular em metros (suficiente na escala de uma cidade)."""
        lat = np.asarray(lat, dtype=float)
        lon = np.asarray(lon, dtype=float)
        x = lon * EARTH_M_PER_DEG_LON_EQ * np.cos(np.radians(self._lat0))
        y = lat * EARTH_M_PER_DEG_LAT
        return np.column_stack([np.atleast_1d(x), np.atleast_1d(y)])

    @cached_property
    def _xy(self) -> np.ndarray:
        return self.project(self.lat, self.lon)

    @cached_property
    def _tree_all(self) -> cKDTree:
        return cKDTree(self._xy)

    @cached_property
    def _eligible_idx(self) -> np.ndarray:
        return np.flatnonzero(self.eligible)

    @cached_property
    def _tree_eligible(self) -> cKDTree:
        return cKDTree(self._xy[self._eligible_idx])

    def snap(self, lat: float, lon: float, eligible_only: bool = True) -> tuple[int, float]:
        """Nó mais próximo (por padrão, fora de vias expressas). Devolve (índice, distância em m)."""
        p = self.project(lat, lon)[0]
        if eligible_only and len(self._eligible_idx):
            d, i = self._tree_eligible.query(p)
            return int(self._eligible_idx[i]), float(d)
        d, i = self._tree_all.query(p)
        return int(i), float(d)

    def node_xy(self, idx: np.ndarray) -> np.ndarray:
        return self._xy[idx]

    # ------------------------------------------------------------------ caminhos
    def shortest_from(
        self, sources: np.ndarray, weight: str = "time", predecessors: bool = False
    ):
        """N Dijkstras de uma vez (C, via SciPy). Devolve dist[N, V] (e pred[N, V])."""
        return dijkstra(
            self.csr(weight),
            directed=True,
            indices=np.asarray(sources, dtype=np.int32),
            return_predecessors=predecessors,
        )

    def path_cost(
        self, pred_row: np.ndarray, source: int, target: int, weight: str
    ) -> float:
        """Soma `weight` ao longo do caminho codificado em `pred_row` (de source até target)."""
        if source == target:
            return 0.0
        nodes = [target]
        cur = target
        while cur != source:
            cur = int(pred_row[cur])
            if cur < 0:
                return float("inf")
            nodes.append(cur)
        nodes.reverse()
        m = self.csr(weight)
        return float(np.asarray(m[nodes[:-1], nodes[1:]]).sum())

    # ------------------------------------------------------------------ cache em disco
    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path,
            lat=self.lat,
            lon=self.lon,
            src=self.src,
            dst=self.dst,
            time_s=self.time_s,
            length_m=self.length_m,
            eligible=self.eligible,
            street=np.asarray(self.street, dtype=str),
            edge_u=self.edge_u,
            edge_v=self.edge_v,
            edge_coords=self.edge_coords,
            edge_offsets=self.edge_offsets,
            boundary_coords=self.boundary_coords,
            boundary_offsets=self.boundary_offsets,
            format_version=np.int32(FORMAT_VERSION),
        )

    @classmethod
    def load(cls, path: Path) -> "RoadGraph":
        with np.load(path, allow_pickle=False) as z:
            version = int(z["format_version"]) if "format_version" in z.files else 1
            geo = {}
            if version >= 2:
                geo = {k: z[k] for k in (
                    "edge_u", "edge_v", "edge_coords", "edge_offsets",
                    "boundary_coords", "boundary_offsets",
                )}
            return cls(
                lat=z["lat"],
                lon=z["lon"],
                src=z["src"],
                dst=z["dst"],
                time_s=z["time_s"],
                length_m=z["length_m"],
                eligible=z["eligible"],
                street=z["street"].astype(object),
                format_version=version,
                **geo,
            )

    # ------------------------------------------------------------------ construção
    @classmethod
    def from_osmnx(cls, G, boundary=None) -> "RoadGraph":
        """Constrói a partir de um MultiDiGraph do OSMnx; `boundary` é um (Multi)Polygon opcional."""
        import osmnx as ox

        G = ox.truncate.largest_component(G, strongly=True)
        G = ox.add_edge_speeds(G)
        G = ox.add_edge_travel_times(G)

        nodes = list(G.nodes)
        index = {n: i for i, n in enumerate(nodes)}
        lat = np.array([G.nodes[n]["y"] for n in nodes], dtype=float)
        lon = np.array([G.nodes[n]["x"] for n in nodes], dtype=float)

        src, dst, t, l = [], [], [], []
        eligible = np.zeros(len(nodes), dtype=bool)
        street = np.full(len(nodes), "", dtype=object)
        seg_u, seg_v, seg_lines = [], [], []
        seen: set[tuple[int, int, float]] = set()
        for u, v, data in G.edges(data=True):
            i, j = index[u], index[v]
            # Mão dupla vira duas arestas dirigidas com a mesma geometria: desenha uma vez só.
            key = (min(i, j), max(i, j), round(float(data["length"]), 1))
            if i != j and key not in seen:
                seen.add(key)
                geom = data.get("geometry")
                if geom is not None:
                    coords = np.asarray(geom.coords, dtype=float)
                else:
                    coords = np.array([[lon[i], lat[i]], [lon[j], lat[j]]])
                seg_u.append(i)
                seg_v.append(j)
                seg_lines.append(coords)
            src.append(i)
            dst.append(j)
            t.append(float(data["travel_time"]) / URBAN_SPEED_FACTOR)
            l.append(float(data["length"]))
            hw = data.get("highway", "")
            hws = set(hw) if isinstance(hw, list) else {hw}
            if not hws <= EXPRESSWAYS:
                eligible[i] = eligible[j] = True
                name = data.get("name")
                if isinstance(name, list):
                    name = name[0] if name else None
                if name:
                    for k in (i, j):
                        if not street[k]:
                            street[k] = str(name)

        lat0 = float(np.mean(lat))
        edge_coords, edge_offsets = simplify_lines(seg_lines, SIMPLIFY_STREETS_M, lat0)
        rings = polygon_rings(boundary) if boundary is not None else []
        b_coords, b_offsets = simplify_lines(rings, SIMPLIFY_BOUNDARY_M, lat0)

        return cls(
            lat=lat,
            lon=lon,
            src=np.array(src, dtype=np.int32),
            dst=np.array(dst, dtype=np.int32),
            time_s=np.array(t),
            length_m=np.array(l),
            eligible=eligible,
            street=street,
            edge_u=np.array(seg_u, dtype=np.int32),
            edge_v=np.array(seg_v, dtype=np.int32),
            edge_coords=edge_coords,
            edge_offsets=edge_offsets,
            boundary_coords=b_coords,
            boundary_offsets=b_offsets,
        )


def polygon_rings(geom) -> list[np.ndarray]:
    """Anéis (externos e furos) de um Polygon/MultiPolygon do shapely, como arrays (lon, lat)."""
    polys = getattr(geom, "geoms", [geom])
    rings = []
    for p in polys:
        if not hasattr(p, "exterior"):
            continue
        rings.append(np.asarray(p.exterior.coords, dtype=float))
        rings.extend(np.asarray(r.coords, dtype=float) for r in p.interiors)
    return rings


def simplify_lines(
    lines: list[np.ndarray], tolerance_m: float, lat0: float
) -> tuple[np.ndarray, np.ndarray]:
    """Douglas-Peucker (em metros) numa lista de polilinhas (lon, lat), mantendo as pontas.

    Devolve (coords [P, 2] float32, offsets [len(lines)+1]) achatados.
    """
    if not lines:
        return np.zeros((0, 2), dtype=np.float32), np.zeros(1, dtype=np.int64)
    import shapely

    kx = EARTH_M_PER_DEG_LON_EQ * np.cos(np.radians(lat0))
    ky = EARTH_M_PER_DEG_LAT
    counts = np.array([len(c) for c in lines])
    flat = np.concatenate(lines) * [kx, ky]
    geoms = shapely.linestrings(flat, indices=np.repeat(np.arange(len(lines)), counts))
    geoms = shapely.simplify(geoms, tolerance_m, preserve_topology=False)
    coords, which = shapely.get_coordinates(geoms, return_index=True)
    offsets = np.zeros(len(lines) + 1, dtype=np.int64)
    np.add.at(offsets, which + 1, 1)
    offsets = np.cumsum(offsets)
    return (coords / [kx, ky]).astype(np.float32), offsets


def graph_cache_path(cache_dir: Path) -> Path:
    return cache_dir / "graph_drive.npz"


def load_or_build(place: str, cache_dir: Path, refresh: bool = False) -> RoadGraph:
    """Carrega o grafo do cache; se não existir, for de formato antigo ou refresh=True, baixa do OSM."""
    path = graph_cache_path(cache_dir)
    if path.exists() and not refresh:
        graph = RoadGraph.load(path)
        if graph.format_version == FORMAT_VERSION:
            return graph
        log.warning(
            "Cache do grafo no formato %d (atual: %d); refazendo.", graph.format_version, FORMAT_VERSION
        )

    import osmnx as ox

    ox.settings.use_cache = True
    ox.settings.cache_folder = str(cache_dir / "osmnx")
    log.info("Baixando malha viária de %r (pode levar alguns minutos)...", place)
    G = ox.graph_from_place(place, network_type="drive")
    boundary = ox.geocode_to_gdf(place).geometry.iloc[0]
    graph = RoadGraph.from_osmnx(G, boundary=boundary)
    graph.save(path)
    log.info("Grafo salvo em %s (%d nós, %d arestas)", path, graph.n_nodes, len(graph.src))
    return graph
