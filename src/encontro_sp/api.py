"""API HTTP (FastAPI): `uv run encontro serve`.

- `POST /buscar`            mesmo contrato da CLI; devolve o JSON de `output.to_dict`.
- `POST /buscar?flood=1`    devolve o anexo binário da inundação (`flood.py`), com o
                            mesmo JSON dentro do cabeçalho.
- `GET  /malha`             geometria das ruas + contorno (`mesh.py`), com ETag e cache longo.
- `GET  /geocode?q=`        geocodificação pelo `CachedGeocoder` (Nominatim com throttle).

O grafo é carregado uma vez, no startup. As buscas são serializadas por um lock: cada uma
usa matrizes N×V de algumas centenas de MB no pior caso, a cota da TomTom é compartilhada e
o Nominatim só aceita 1 requisição por segundo, então rodar várias em paralelo não ajuda.
"""

from __future__ import annotations

import gzip
import logging
import threading
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import criteria, flood, mesh, output
from .config import Settings
from .geocode import CachedGeocoder, GeocodeError, NominatimGeocoder, TomTomGeocoder
from .graph import RoadGraph, load_or_build
from .providers import TomTomProvider
from .quota import QuotaTracker
from .solver import METRICS, Person, Request as SolveRequest, Solver

log = logging.getLogger(__name__)

# Front-end compilado (`npm run build` em web/). Se existir, é servido na raiz.
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"

MAX_PEOPLE = 12


class PessoaIn(BaseModel):
    nome: str = Field(min_length=1, max_length=60)
    endereco: str = Field(min_length=1, max_length=200)


class BuscaIn(BaseModel):
    pessoas: list[PessoaIn] = Field(min_length=2, max_length=MAX_PEOPLE)
    objetivo: Literal["casa", "cidade"] = "cidade"
    criterio: str = "justo"
    metrica: str = "tempo"
    k: int = Field(5, ge=1, le=20)
    limite: float | None = Field(None, gt=0, description="minutos (tempo) ou km (distância), como na CLI")
    m: int | None = Field(None, ge=1, le=200)
    ao_vivo: bool = True

    @field_validator("criterio")
    @classmethod
    def _criterio(cls, v: str) -> str:
        try:
            return criteria.get(v).name
        except KeyError as e:
            raise ValueError(str(e.args[0])) from None

    @field_validator("metrica")
    @classmethod
    def _metrica(cls, v: str) -> str:
        if v not in METRICS:
            raise ValueError("use tempo ou distancia")
        return v

    def to_request(self) -> SolveRequest:
        limit = None
        if self.limite is not None:
            limit = self.limite * 60 if METRICS[self.metrica] == "time" else self.limite * 1000
        return SolveRequest(
            people=[Person(p.nome.strip(), p.endereco.strip()) for p in self.pessoas],
            objective=self.objetivo,
            criterion=self.criterio,
            metric=self.metrica,
            k=self.k,
            limit=limit,
            m=self.m,
            live=self.ao_vivo,
        )


class LockedGeocoder:
    """Serializa a geocodificação: uma consulta externa por vez (e o cache em disco seguro)."""

    def __init__(self, inner: CachedGeocoder):
        self.inner = inner
        self._lock = threading.Lock()

    def geocode(self, address: str):
        with self._lock:
            return self.inner.geocode(address)


def _accepts_gzip(request: Request) -> bool:
    return "gzip" in request.headers.get("accept-encoding", "").lower()


def _binary(request: Request, body: bytes, gz: bytes | None = None, headers: dict | None = None) -> Response:
    headers = dict(headers or {})
    headers["Vary"] = "Accept-Encoding"
    if _accepts_gzip(request):
        headers["Content-Encoding"] = "gzip"
        body = gz if gz is not None else gzip.compress(body, 6)
    return Response(body, media_type="application/octet-stream", headers=headers)


def create_app(
    graph: RoadGraph | None = None,
    geocoder: CachedGeocoder | None = None,
    live_provider=None,
    quota: QuotaTracker | None = None,
    settings: Settings | None = None,
    web_dist: Path | None = WEB_DIST,
) -> FastAPI:
    """Monta a API. Sem `graph`, tudo é criado a partir das configurações no startup."""
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = None
        s = settings or Settings.from_env()
        g = graph if graph is not None else load_or_build(s.place, s.cache_dir)
        geo, live, q = geocoder, live_provider, quota
        if geo is None:
            q = q or QuotaTracker(s.cache_dir / "quota.json", s.tomtom_daily_limit)
            client = httpx.Client(timeout=s.http_timeout_s)
            geocoders = []
            if s.tomtom_api_key:
                geocoders.append(TomTomGeocoder(s.tomtom_api_key, client, q))
                live = TomTomProvider(
                    s.tomtom_api_key, client, q,
                    max_cells=s.tomtom_max_cells, count_cells=s.tomtom_count_cells,
                    cache_path=s.cache_dir / "matrix_cache.json", cache_ttl_s=s.matrix_cache_ttl_s,
                )
            geocoders.append(NominatimGeocoder(client))
            geo = CachedGeocoder(geocoders, s.cache_dir / "geocode.json")
        locked = LockedGeocoder(geo)
        m = mesh.encode(g)
        state.update(
            graph=g,
            geocoder=locked,
            quota=q,
            solver=Solver(g, locked, live, max_cells=s.tomtom_max_cells),
            solve_lock=threading.Lock(),
            mesh=m,
            mesh_gz=gzip.compress(m.blob, 9),
        )
        log.info("API pronta: %d nós, malha de %.1f MB", g.n_nodes, len(m.blob) / 1e6)
        try:
            yield
        finally:
            if client is not None:
                client.close()

    app = FastAPI(title="encontro-sp", lifespan=lifespan)

    @app.get("/saude")
    def saude():
        g = state["graph"]
        return {"ok": True, "nos": g.n_nodes, "trechos": g.n_segments}

    @app.post("/buscar")
    def buscar(body: BuscaIn, request: Request, flood_: bool = Query(False, alias="flood")):
        req = body.to_request()
        q: QuotaTracker | None = state["quota"]
        with state["solve_lock"]:
            n_warn = len(q.warnings) if q else 0
            try:
                sol = state["solver"].solve(req)
            except GeocodeError as e:
                raise HTTPException(422, detail=str(e))
            except ValueError as e:
                raise HTTPException(400, detail=str(e))
            if q:
                sol.warnings.extend(q.warnings[n_warn:])
        result = output.to_dict(sol)
        if not flood_:
            return JSONResponse(result)
        blob = flood.build(sol, extra=result).encode()
        return _binary(request, blob, headers={"Cache-Control": "no-store"})

    @app.get("/malha")
    def malha(request: Request):
        m: mesh.Mesh = state["mesh"]
        etag = f'"{m.etag}"'
        headers = {"ETag": etag, "Cache-Control": "public, max-age=86400"}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        return _binary(request, m.blob, state["mesh_gz"], headers)

    @app.get("/geocode")
    def geocode(q: str = Query(..., min_length=2, max_length=200)):
        try:
            p = state["geocoder"].geocode(q)
        except GeocodeError as e:
            raise HTTPException(404, detail=str(e))
        node, snap_m = state["graph"].snap(p.lat, p.lon, eligible_only=True)
        return {"lat": p.lat, "lon": p.lon, "rotulo": p.label, "fonte": p.source, "snap_m": round(snap_m, 1)}

    if web_dist is not None and (web_dist / "index.html").exists():
        app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")

    return app
