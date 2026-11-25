"""Malha viária: download via OSMnx, limpeza, pesos e cache compacto em disco.

O grafo é guardado como arrays NumPy (arestas + coordenadas dos nós) num `.npz`, o que
carrega em menos de um segundo, contra dezenas de segundos de um GraphML.
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

    def __post_init__(self) -> None:
        if self.street is None:
            self.street = np.full(len(self.lat), "", dtype=object)
        self._dedupe_edges()

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
        )

    @classmethod
    def load(cls, path: Path) -> "RoadGraph":
        with np.load(path, allow_pickle=False) as z:
            return cls(
                lat=z["lat"],
                lon=z["lon"],
                src=z["src"],
                dst=z["dst"],
                time_s=z["time_s"],
                length_m=z["length_m"],
                eligible=z["eligible"],
                street=z["street"].astype(object),
            )

    # ------------------------------------------------------------------ construção
    @classmethod
    def from_osmnx(cls, G) -> "RoadGraph":
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
        for u, v, data in G.edges(data=True):
            i, j = index[u], index[v]
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

        return cls(
            lat=lat,
            lon=lon,
            src=np.array(src, dtype=np.int32),
            dst=np.array(dst, dtype=np.int32),
            time_s=np.array(t),
            length_m=np.array(l),
            eligible=eligible,
            street=street,
        )


def graph_cache_path(cache_dir: Path) -> Path:
    return cache_dir / "graph_drive.npz"


def load_or_build(place: str, cache_dir: Path, refresh: bool = False) -> RoadGraph:
    """Carrega o grafo do cache; se não existir (ou refresh=True), baixa do OSM."""
    path = graph_cache_path(cache_dir)
    if path.exists() and not refresh:
        return RoadGraph.load(path)

    import osmnx as ox

    ox.settings.use_cache = True
    ox.settings.cache_folder = str(cache_dir / "osmnx")
    log.info("Baixando malha viária de %r (pode levar alguns minutos)...", place)
    G = ox.graph_from_place(place, network_type="drive")
    graph = RoadGraph.from_osmnx(G)
    graph.save(path)
    log.info("Grafo salvo em %s (%d nós, %d arestas)", path, graph.n_nodes, len(graph.src))
    return graph
