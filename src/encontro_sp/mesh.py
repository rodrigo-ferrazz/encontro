"""Malha para desenho no navegador (`GET /malha`): geometria das ruas + contorno, em binário.

Formato (little-endian), no mesmo espírito do anexo da inundação (`flood.py`):

    bytes 0..3   magic b"ENCM"
    bytes 4..7   uint32: tamanho H do cabeçalho JSON (com espaços até alinhar em 8 bytes)
    bytes 8..    cabeçalho JSON: contagens, bbox, escalas e a lista `arrays` com
                 (nome, dtype, shape, offset em bytes a partir do fim do cabeçalho)
    em seguida   os arrays, cada um começando num múltiplo de 8 bytes

Arrays:
    coords      uint16 [P, 2]  lon/lat quantizados no bbox: lon = lon_min + q / 65535 * (lon_max - lon_min)
    offsets     uint32 [S+1]   início de cada trecho em `coords`
    seg_u       uint32 [S]     nó da primeira ponta (onde a polilinha começa)
    seg_v       uint32 [S]     nó da última ponta
    seg_t_uv    uint16 [S]     tempo para percorrer u→v em décimos de segundo (65535 = contramão)
    seg_t_vu    uint16 [S]     idem, v→u
    seg_len     uint16 [S]     comprimento em metros
    ring_coords uint16 [Q, 2]  contorno do município, mesma quantização
    ring_offsets uint32 [R+1]

Quantizar em 16 bits dá ~1 m de resolução no bbox de SP e corta o tamanho pela metade.
"""

from __future__ import annotations

import hashlib
import json
import struct
from dataclasses import dataclass

import numpy as np

from .graph import RoadGraph

MAGIC = b"ENCM"
FORMAT_VERSION = 1
NO_WAY = 65535
ATTRIBUTION = "© OpenStreetMap contributors"


def _quantize(coords: np.ndarray, bbox: tuple[float, float, float, float]) -> np.ndarray:
    lon0, lat0, lon1, lat1 = bbox
    q = np.empty(coords.shape, dtype=np.uint16)
    if len(coords):
        q[:, 0] = np.rint((coords[:, 0] - lon0) / max(lon1 - lon0, 1e-12) * 65535)
        q[:, 1] = np.rint((coords[:, 1] - lat0) / max(lat1 - lat0, 1e-12) * 65535)
    return q


def segment_times(graph: RoadGraph) -> tuple[np.ndarray, np.ndarray]:
    """Tempo (s) de cada trecho nos dois sentidos; `inf` onde o sentido não existe."""
    m = graph.csr("time")
    u, v = graph.edge_u, graph.edge_v
    t_uv = np.asarray(m[u, v]).ravel().astype(float)
    t_vu = np.asarray(m[v, u]).ravel().astype(float)
    t_uv[t_uv == 0] = np.inf
    t_vu[t_vu == 0] = np.inf
    return t_uv, t_vu


def segment_lengths(graph: RoadGraph) -> np.ndarray:
    """Comprimento de cada trecho pela polilinha (metros)."""
    xy = graph.project(graph.edge_coords[:, 1], graph.edge_coords[:, 0])
    step = np.hypot(*np.diff(xy, axis=0).T)
    # zera os "saltos" entre o fim de um trecho e o início do próximo
    starts = graph.edge_offsets[1:-1]
    step[starts - 1] = 0.0
    cum = np.concatenate([[0.0], np.cumsum(step)])
    return cum[graph.edge_offsets[1:] - 1] - cum[graph.edge_offsets[:-1]]


def _deciseconds(t: np.ndarray) -> np.ndarray:
    out = np.full(len(t), NO_WAY, dtype=np.uint16)
    ok = np.isfinite(t)
    out[ok] = np.clip(np.rint(t[ok] * 10), 1, NO_WAY - 1)
    return out


@dataclass
class Mesh:
    blob: bytes
    etag: str


def encode(graph: RoadGraph) -> Mesh:
    all_pts = np.concatenate([graph.edge_coords, graph.boundary_coords]).astype(float)
    lon0, lat0 = all_pts.min(axis=0)
    lon1, lat1 = all_pts.max(axis=0)
    bbox = (float(lon0), float(lat0), float(lon1), float(lat1))

    t_uv, t_vu = segment_times(graph)
    arrays = {
        "coords": _quantize(graph.edge_coords, bbox),
        "offsets": graph.edge_offsets.astype("<u4"),
        "seg_u": graph.edge_u.astype("<u4"),
        "seg_v": graph.edge_v.astype("<u4"),
        "seg_t_uv": _deciseconds(t_uv),
        "seg_t_vu": _deciseconds(t_vu),
        "seg_len": np.clip(np.rint(segment_lengths(graph)), 0, NO_WAY - 1).astype("<u2"),
        "ring_coords": _quantize(graph.boundary_coords, bbox),
        "ring_offsets": graph.boundary_offsets.astype("<u4"),
    }

    layout, chunks, pos = [], [], 0
    for name, arr in arrays.items():
        raw = np.ascontiguousarray(arr).tobytes()
        layout.append({"nome": name, "dtype": arr.dtype.str, "shape": list(arr.shape), "offset": pos})
        pad = (-len(raw)) % 8
        chunks.append(raw + b"\0" * pad)
        pos += len(raw) + pad

    header = {
        "versao": FORMAT_VERSION,
        "nos": graph.n_nodes,
        "trechos": graph.n_segments,
        "aneis": len(graph.boundary_offsets) - 1,
        "bbox": bbox,  # lon_min, lat_min, lon_max, lat_max
        "lat_ref": float(np.mean(graph.lat)),
        "sem_sentido": NO_WAY,
        "atribuicao": ATTRIBUTION,
        "arrays": layout,
    }
    head = json.dumps(header, separators=(",", ":")).encode()
    head += b" " * ((-(8 + len(head))) % 8)
    blob = MAGIC + struct.pack("<I", len(head)) + head + b"".join(chunks)
    return Mesh(blob, hashlib.sha256(blob).hexdigest()[:20])


def decode(blob: bytes) -> tuple[dict, dict[str, np.ndarray]]:
    """Inverso de `encode` (para testes e clientes Python)."""
    if blob[:4] != MAGIC:
        raise ValueError("não é uma malha (magic inválido)")
    (hlen,) = struct.unpack("<I", blob[4:8])
    header = json.loads(blob[8 : 8 + hlen])
    base = 8 + hlen
    out = {}
    for a in header["arrays"]:
        dt = np.dtype(a["dtype"])
        count = int(np.prod(a["shape"])) if a["shape"] else 1
        out[a["nome"]] = np.frombuffer(blob, dtype=dt, count=count, offset=base + a["offset"]).reshape(a["shape"])
    return header, out


def dequantize(q: np.ndarray, bbox) -> np.ndarray:
    lon0, lat0, lon1, lat1 = bbox
    return np.column_stack([lon0 + q[:, 0] / 65535 * (lon1 - lon0), lat0 + q[:, 1] / 65535 * (lat1 - lat0)])
