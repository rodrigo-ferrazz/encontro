"""Custos estimados no grafo local (sem trânsito)."""

from __future__ import annotations

import numpy as np

from ..graph import RoadGraph
from .base import CostMatrix, Point


class LocalOSMProvider:
    name = "local"

    def __init__(self, graph: RoadGraph):
        self.graph = graph

    def full(self, origins: list[Point], weight: str = "time"):
        """Dijkstra de cada origem para TODOS os nós: (dist[N, V], pred[N, V])."""
        sources = np.array([o.node for o in origins], dtype=np.int32)
        return self.graph.shortest_from(sources, weight, predecessors=True)

    def matrix_from_full(
        self,
        origins: list[Point],
        candidate_nodes: np.ndarray,
        dist: np.ndarray,
        pred: np.ndarray,
        weight: str = "time",
    ) -> CostMatrix:
        """Monta a matriz N×C reaproveitando um Dijkstra já feito.

        A métrica otimizada sai direto do Dijkstra; a outra é somada ao longo do mesmo
        caminho (distância do caminho mais rápido, e não o caminho mais curto).
        """
        candidate_nodes = np.asarray(candidate_nodes, dtype=np.int64)
        primary = dist[:, candidate_nodes]
        other_w = "length" if weight == "time" else "time"
        other = np.empty_like(primary)
        for i, o in enumerate(origins):
            for j, c in enumerate(candidate_nodes):
                other[i, j] = self.graph.path_cost(pred[i], o.node, int(c), other_w)
        time_s, dist_m = (primary, other) if weight == "time" else (other, primary)
        return CostMatrix(time_s=time_s, dist_m=dist_m, live=np.zeros(primary.shape, dtype=bool))

    def matrix(self, origins: list[Point], candidates: list[Point], weight: str = "time") -> CostMatrix:
        dist, pred = self.full(origins, weight)
        nodes = np.array([c.node for c in candidates], dtype=np.int64)
        return self.matrix_from_full(origins, nodes, dist, pred, weight)
