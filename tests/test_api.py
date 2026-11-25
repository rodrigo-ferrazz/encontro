import gzip

import numpy as np
import pytest
from fastapi.testclient import TestClient

from encontro_sp import flood, mesh
from encontro_sp.api import create_app
from encontro_sp.config import Settings

from .conftest import grid_graph, node_coord

N = 11


@pytest.fixture
def client(geocoder, tmp_path):
    app = create_app(graph=grid_graph(N), geocoder=geocoder, settings=Settings(cache_dir=tmp_path))
    with TestClient(app) as c:
        yield c


def body(**kw):
    b = {
        "pessoas": [
            {"nome": "Ana", "endereco": node_coord(N, 0, 0)},
            {"nome": "Bia", "endereco": node_coord(N, 0, 10)},
            {"nome": "Caio", "endereco": node_coord(N, 10, 0)},
        ],
        "k": 3,
    }
    b.update(kw)
    return b


def test_saude(client):
    assert client.get("/saude").json() == {"ok": True, "nos": N * N, "trechos": 2 * N * (N - 1)}


def test_buscar_json_matches_cli_contract(client):
    r = client.post("/buscar", json=body())
    assert r.status_code == 200
    data = r.json()
    assert data["criterio"] == "justo"
    assert [x["rank"] for x in data["resultados"]] == [1, 2, 3]
    best = data["resultados"][0]
    assert max(d["tempo_s"] for d in best["deslocamentos"]) == pytest.approx(100.0)
    assert any("TOMTOM_API_KEY" in w for w in data["avisos"])


def test_buscar_limit_in_minutes_like_cli(client):
    r = client.post("/buscar", json=body(criterio="limite", limite=1))  # 60 s: ninguém chega
    assert r.status_code == 200
    assert r.json()["resultados"] == []
    r = client.post("/buscar", json=body(criterio="limite"))
    assert r.status_code == 400 and "limite" in r.json()["detail"]


@pytest.mark.parametrize("bad", [
    {"pessoas": [{"nome": "A", "endereco": "x"}]},
    {"criterio": "nada"},
    {"metrica": "litros"},
    {"objetivo": "praia"},
    {"k": 0},
])
def test_buscar_validation(client, bad):
    assert client.post("/buscar", json=body(**bad)).status_code == 422


def test_buscar_geocode_failure_is_422(client):
    b = body()
    b["pessoas"][0]["endereco"] = "Rua que não existe"
    r = client.post("/buscar", json=b)
    assert r.status_code == 422 and "geocodificar" in r.json()["detail"]


def test_buscar_flood_binary(client):
    r = client.post("/buscar?flood=1", json=body())
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    data = flood.decode(r.content)  # TestClient já descompacta o gzip
    assert data.arrival.shape == (3, N * N)
    assert data.t_star == pytest.approx(100.0)
    assert data.extra["resultados"][0]["rank"] == 1
    assert data.meeting_node is not None


def test_malha_binary_with_etag(client):
    r = client.get("/malha")
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    header, arrays = mesh.decode(r.content)
    assert header["trechos"] == 2 * N * (N - 1)
    assert "OpenStreetMap" in header["atribuicao"]
    assert len(arrays["offsets"]) == header["trechos"] + 1
    # grade: todo trecho tem 10 s nos dois sentidos e ~110 m
    assert np.all(arrays["seg_t_uv"] == 100) and np.all(arrays["seg_t_vu"] == 100)
    assert np.all(np.abs(arrays["seg_len"].astype(int) - 105) < 10)
    etag = r.headers["etag"]
    r2 = client.get("/malha", headers={"If-None-Match": etag})
    assert r2.status_code == 304


def test_malha_without_gzip(client):
    r = client.get("/malha", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in r.headers
    assert r.content[:4] == b"ENCM"


def test_geocode_endpoint(client):
    r = client.get("/geocode", params={"q": node_coord(N, 5, 5)})
    assert r.status_code == 200
    assert r.json()["fonte"] == "coordenadas"
    assert client.get("/geocode", params={"q": "lugar nenhum"}).status_code == 404
