"""Orquestra: geocodificação → snap → pré-filtro local → refinamento ao vivo → top-K."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np

from . import criteria
from .geocode import CachedGeocoder, GeoPoint
from .graph import RoadGraph
from .providers import CostMatrix, LocalOSMProvider, Point, ProviderError

log = logging.getLogger(__name__)

OBJECTIVES = ("casa", "cidade")
METRICS = {"tempo": "time", "time": "time", "distancia": "length", "distância": "length",
           "distance": "length", "length": "length"}
# Snap a mais que isso do endereço indica endereço fora da malha (ou geocodificação errada).
SNAP_WARN_M = 1500.0
# Resolução do critério "igualitário" (ver criteria._equal).
EQUAL_RESOLUTION = {"time": 120.0, "length": 1000.0}


@dataclass
class Person:
    name: str
    address: str


@dataclass
class Request:
    people: list[Person]
    objective: str = "cidade"
    criterion: str = "justo"
    metric: str = "tempo"
    k: int = 5
    limit: float | None = None  # em segundos (tempo) ou metros (distância)
    m: int | None = None  # candidatos enviados ao estágio 2
    diversity_m: float = 400.0  # distância mínima entre candidatos no objetivo "cidade"
    prefilter_slack: float = 1.3  # folga do limite no pré-filtro (tempo local é estimativa)
    live: bool = True


@dataclass
class LocatedPerson:
    person: Person
    geo: GeoPoint
    node: int
    snap_m: float

    @property
    def point(self) -> Point:
        return Point(self.geo.lat, self.geo.lon, self.node)


@dataclass
class RankedPoint:
    rank: int
    lat: float
    lon: float
    node: int
    host: str | None  # objetivo "casa": nome do anfitrião
    street: str
    time_s: np.ndarray  # [N]
    dist_m: np.ndarray  # [N]
    live: np.ndarray  # [N] bool
    score: float
    tiebreak: float


@dataclass
class Solution:
    request: Request
    people: list[LocatedPerson]
    results: list[RankedPoint]
    criterion: criteria.Criterion
    live_used: bool
    n_candidates_local: int
    n_candidates_refined: int
    warnings: list[str] = field(default_factory=list)


def spatially_diverse(order: np.ndarray, xy: np.ndarray, m: int, min_dist: float) -> np.ndarray:
    """Percorre `order` (melhor primeiro) mantendo só pontos a >= min_dist dos já escolhidos."""
    chosen: list[int] = []
    pts = np.empty((0, 2))
    for idx in order:
        p = xy[idx]
        if len(pts) and np.min(np.hypot(*(pts - p).T)) < min_dist:
            continue
        chosen.append(int(idx))
        pts = np.vstack([pts, p])
        if len(chosen) >= m:
            break
    return np.array(chosen, dtype=np.int64)


class Solver:
    def __init__(self, graph: RoadGraph, geocoder: CachedGeocoder, live_provider=None, max_cells: int = 200):
        self.graph = graph
        self.geocoder = geocoder
        self.local = LocalOSMProvider(graph)
        self.live_provider = live_provider
        self.max_cells = max_cells

    # ------------------------------------------------------------------ etapas
    def locate(self, people: list[Person], warnings: list[str]) -> list[LocatedPerson]:
        located = []
        for p in people:
            geo = self.geocoder.geocode(p.address)
            node, d = self.graph.snap(geo.lat, geo.lon, eligible_only=True)
            if d > SNAP_WARN_M:
                warnings.append(
                    f"{p.name}: endereço a {d / 1000:.1f} km da via mais próxima da malha; "
                    "confira o endereço (ou está fora da área do grafo)."
                )
            located.append(LocatedPerson(p, geo, node, d))
        return located

    def _default_m(self, req: Request, n: int) -> int:
        if req.m:
            return max(req.m, req.k)
        if self._live_enabled(req):
            # Cabe numa única requisição síncrona (200 células no Freemium).
            return max(req.k, min(30, max(self.max_cells // n, 1)))
        return max(req.k, 30)

    def _live_enabled(self, req: Request) -> bool:
        return self.live_provider is not None and req.live

    def _params(self, req: Request, weight: str, *, prefilter: bool) -> dict:
        params: dict = {"resolution": EQUAL_RESOLUTION[weight]}
        if req.limit is not None:
            # A folga só faz sentido se o estágio 2 vai trocar a estimativa local pelo
            # trânsito real; offline, o filtro final é o mesmo do pré-filtro.
            slack = req.prefilter_slack if (prefilter and self._live_enabled(req)) else 1.0
            params["limit"] = req.limit * slack
        return params

    # ------------------------------------------------------------------ principal
    def solve(self, req: Request) -> Solution:
        if req.objective not in OBJECTIVES:
            raise ValueError(f"objetivo deve ser um de {OBJECTIVES}")
        if len(req.people) < 2:
            raise ValueError("informe pelo menos 2 pessoas")
        weight = METRICS.get(req.metric)
        if weight is None:
            raise ValueError(f"métrica desconhecida: {req.metric!r} (use tempo ou distancia)")
        crit = criteria.get(req.criterion)
        if crit.needs_limit and req.limit is None:
            raise ValueError(f"o critério {crit.name!r} exige --limite")

        warnings: list[str] = []
        people = self.locate(req.people, warnings)
        origins = [p.point for p in people]
        n = len(people)

        # Estágio 1: N Dijkstras no grafo local.
        dist, pred = self.local.full(origins, weight)

        hosts: dict[int, str] = {}
        if req.objective == "casa":
            for p in people:
                hosts[p.node] = f"{hosts[p.node]} / {p.person.name}" if p.node in hosts else p.person.name
            pool = np.array(list(hosts), dtype=np.int64)
            selected = pool  # poucos candidatos: vão todos para o estágio 2
        else:
            pool = np.flatnonzero(self.graph.eligible)
            primary, secondary = crit.score(dist[:, pool], **self._params(req, weight, prefilter=True))
            order = criteria.rank(primary, secondary)
            m = self._default_m(req, n)
            picked = spatially_diverse(order, self.graph.node_xy(pool), m, req.diversity_m)
            selected = pool[picked]
            if len(selected) == 0:
                return Solution(req, people, [], crit, False, len(pool), 0,
                                warnings + ["Nenhum candidato válido no pré-filtro local."])

        local_cm = self.local.matrix_from_full(origins, selected, dist, pred, weight)
        cand_points = [Point(float(self.graph.lat[c]), float(self.graph.lon[c]), int(c)) for c in selected]
        if req.objective == "casa":
            # Destino = endereço do anfitrião (não o nó do grafo), para a TomTom e o link do Maps.
            host_geo = {}
            for p in people:
                host_geo.setdefault(p.node, p.geo)
            cand_points = [Point(host_geo[c].lat, host_geo[c].lon, c) for c in (int(x) for x in selected)]

        # Estágio 2: trânsito ao vivo (com fallback para o local).
        cm: CostMatrix = local_cm
        live_used = False
        if self._live_enabled(req):
            try:
                cm = self.live_provider.matrix(origins, cand_points).merged_over(local_cm)
                live_used = bool(cm.live.any())
            except ProviderError as e:
                warnings.append(f"Trânsito ao vivo indisponível ({e}); usando estimativa local.")
        elif req.live:
            warnings.append("Sem TOMTOM_API_KEY: resultado só com estimativa local, sem trânsito.")

        primary, secondary = crit.score(cm.metric(weight), **self._params(req, weight, prefilter=False))
        order = criteria.rank(primary, secondary, req.k)

        results = [
            RankedPoint(
                rank=r + 1,
                lat=cand_points[j].lat,
                lon=cand_points[j].lon,
                node=int(selected[j]),
                host=hosts.get(int(selected[j])),
                street=str(self.graph.street[selected[j]] or ""),
                time_s=cm.time_s[:, j],
                dist_m=cm.dist_m[:, j],
                live=cm.live[:, j],
                score=float(primary[j]),
                tiebreak=float(secondary[j]),
            )
            for r, j in enumerate(order)
        ]
        if not results:
            msg = "Nenhum ponto atende ao critério"
            if crit.needs_limit:
                msg += " (ninguém consegue chegar dentro do limite; tente aumentá-lo)"
            warnings.append(msg + ".")
        return Solution(req, people, results, crit, live_used, len(pool), len(selected), warnings)
