"""Dados da animação de "inundação": tempo de chegada de cada pessoa a cada nó.

Formato binário (`application/octet-stream`, little-endian), pensado para o navegador ler
direto em typed arrays, sem parsear meio milhão de números em JSON:

    bytes 0..3   magic b"ENCF"
    bytes 4..7   uint32: tamanho H do cabeçalho JSON (UTF-8, com espaços no fim até
                 alinhar o início dos arrays em 8 bytes)
    bytes 8..    cabeçalho JSON (ver `FloodData.header`)
    em seguida   arrival: uint16[N * V], linha a linha (pessoa 0 inteira, depois a 1, ...)

`arrival` está na unidade do cabeçalho ("s" para tempo, "m" para distância). O valor
`UNREACHED` (65535) quer dizer "não alcançado" ou "chega depois do fim da animação", o que
deixa a maior parte do array constante e comprime bem com gzip.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass

import numpy as np

from .solver import Solution

MAGIC = b"ENCF"
FORMAT_VERSION = 1
UNREACHED = 65535
MAX_VALUE = UNREACHED - 1  # ~18 h em segundos, ~65 km em metros
DEFAULT_MARGIN = 0.15


@dataclass
class FloodData:
    arrival: np.ndarray  # [N, V] uint16
    unit: str  # "s" | "m"
    t_star: float  # instante do encontro no 1º colocado (pela estimativa local)
    t_end: float  # fim da animação: t_star × (1 + margem)
    meeting_node: int | None  # nó do 1º colocado (None se não houve resultado)
    extra: dict | None = None  # anexado ao cabeçalho (ex.: o ranking de output.to_dict)
    # rotas[r][i]: nós do caminho (grafo local) da pessoa i até o resultado r (None = sem caminho)
    routes: list[list[list[int] | None]] | None = None

    @property
    def header(self) -> dict:
        n, v = self.arrival.shape
        h = {
            "versao": FORMAT_VERSION,
            "pessoas": n,
            "nos": v,
            "unidade": self.unit,
            "nao_alcancado": UNREACHED,
            "t_encontro": self.t_star,
            "t_fim": self.t_end,
            "no_encontro": self.meeting_node,
        }
        if self.extra is not None:
            h["resultado"] = self.extra
        if self.routes is not None:
            h["rotas"] = self.routes
        return h

    def encode(self) -> bytes:
        head = json.dumps(self.header, ensure_ascii=False, separators=(",", ":")).encode()
        pad = (-(8 + len(head))) % 8
        head += b" " * pad
        body = np.ascontiguousarray(self.arrival, dtype="<u2").tobytes()
        return MAGIC + struct.pack("<I", len(head)) + head + body


def decode(blob: bytes) -> FloodData:
    """Inverso de `FloodData.encode` (usado nos testes e em clientes Python)."""
    if blob[:4] != MAGIC:
        raise ValueError("não é um anexo de inundação (magic inválido)")
    (hlen,) = struct.unpack("<I", blob[4:8])
    header = json.loads(blob[8 : 8 + hlen].decode())
    n, v = header["pessoas"], header["nos"]
    arrival = np.frombuffer(blob, dtype="<u2", count=n * v, offset=8 + hlen).reshape(n, v)
    return FloodData(
        arrival=arrival,
        unit=header["unidade"],
        t_star=header["t_encontro"],
        t_end=header["t_fim"],
        meeting_node=header["no_encontro"],
        extra=header.get("resultado"),
        routes=header.get("rotas"),
    )


def meeting_time(sol: Solution) -> tuple[float, int | None]:
    """T*: quando a última pessoa chega ao 1º colocado, pelo grafo local.

    No critério "justo" é exatamente o maior deslocamento do vencedor, ou seja, o instante
    em que as frentes se encontram nele. Nos outros critérios a animação também vai até o
    vencedor (ver limitações no backlog).
    """
    if sol.dist is None:
        raise ValueError("a solução não traz o Dijkstra local (dist)")
    if not sol.results:
        finite = sol.dist[np.isfinite(sol.dist)]
        return (float(np.median(finite)) if finite.size else 0.0), None
    node = sol.results[0].node
    col = sol.dist[:, node]
    return float(col[np.isfinite(col)].max(initial=0.0)), node


def routes(sol: Solution) -> list[list[list[int] | None]]:
    """Caminho de cada pessoa até cada resultado, pelos predecessores do Dijkstra local.

    É o caminho mais rápido *sem trânsito*: com trânsito ao vivo, a TomTom pode preferir outro.
    """
    if sol.pred is None:
        return []
    from .graph import RoadGraph

    return [
        [RoadGraph.path_nodes(sol.pred[i], p.node, r.node) for i, p in enumerate(sol.people)]
        for r in sol.results
    ]


def build(sol: Solution, margin: float = DEFAULT_MARGIN, extra: dict | None = None) -> FloodData:
    t_star, node = meeting_time(sol)
    t_end = min(t_star * (1 + margin), float(MAX_VALUE))
    d = sol.dist
    arrival = np.full(d.shape, UNREACHED, dtype=np.uint16)
    ok = np.isfinite(d) & (d <= t_end)
    arrival[ok] = np.minimum(np.rint(d[ok]), MAX_VALUE).astype(np.uint16)
    unit = "s" if sol.weight == "time" else "m"
    return FloodData(arrival, unit, t_star, t_end, node, extra, routes(sol))
