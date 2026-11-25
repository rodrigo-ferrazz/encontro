import datetime as dt
import json

import httpx
import numpy as np
import pytest

from encontro_sp.geocode import CachedGeocoder, GeocodeError, NominatimGeocoder, TomTomGeocoder
from encontro_sp.providers import Point, ProviderError, TomTomProvider
from encontro_sp.quota import QuotaExceeded, QuotaTracker


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def matrix_handler(log):
    def handler(request: httpx.Request):
        body = json.loads(request.content)
        log.append(body)
        assert body["options"]["traffic"] == "live" and body["options"]["departAt"] == "now"
        data = []
        for i, _ in enumerate(body["origins"]):
            for j, d in enumerate(body["destinations"]):
                data.append({
                    "originIndex": i, "destinationIndex": j,
                    "routeSummary": {"travelTimeInSeconds": 100 * i + j, "lengthInMeters": 1000 + j},
                })
        return httpx.Response(200, json={"data": data})
    return handler


def pts(n, base=0.0):
    return [Point(-23.5 + base + i * 0.01, -46.6) for i in range(n)]


def test_tomtom_chunks_to_200_cells(tmp_path):
    log = []
    quota = QuotaTracker(tmp_path / "q.json", 2500)
    p = TomTomProvider("k", client_for(matrix_handler(log)), quota, max_cells=200)
    cm = p.matrix(pts(7), pts(40, 1))
    assert [len(b["destinations"]) for b in log] == [28, 12]  # 7×28=196 ≤ 200
    assert cm.live.all()
    assert cm.time_s[2, 30] == 200 + 2  # índice local 2 no segundo bloco
    assert quota.used() == 7 * 40


def test_tomtom_short_cache(tmp_path):
    log = []
    now = [1000.0]
    quota = QuotaTracker(tmp_path / "q.json", 2500)
    p = TomTomProvider("k", client_for(matrix_handler(log)), quota,
                       cache_path=tmp_path / "m.json", cache_ttl_s=300, clock=lambda: now[0])
    p.matrix(pts(2), pts(3, 1))
    p.matrix(pts(2), pts(3, 1))
    assert len(log) == 1
    now[0] += 301
    p.matrix(pts(2), pts(3, 1))
    assert len(log) == 2


def test_tomtom_quota_blocks_before_calling(tmp_path):
    log = []
    quota = QuotaTracker(tmp_path / "q.json", 10)
    p = TomTomProvider("k", client_for(matrix_handler(log)), quota)
    with pytest.raises(ProviderError):
        p.matrix(pts(3), pts(5, 1))
    assert log == []


@pytest.mark.parametrize("status", [403, 429, 500])
def test_tomtom_http_errors(tmp_path, status):
    quota = QuotaTracker(tmp_path / "q.json", 2500)
    p = TomTomProvider("k", client_for(lambda r: httpx.Response(status, text="x")), quota)
    with pytest.raises(ProviderError):
        p.matrix(pts(2), pts(2, 1))


def test_tomtom_timeout(tmp_path):
    def boom(request):
        raise httpx.ReadTimeout("lento", request=request)
    p = TomTomProvider("k", client_for(boom), QuotaTracker(tmp_path / "q.json", 2500))
    with pytest.raises(ProviderError, match="timeout"):
        p.matrix(pts(2), pts(2, 1))


def test_tomtom_cell_errors_become_nan(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"data": [
            {"originIndex": 0, "destinationIndex": 0, "routeSummary": {"travelTimeInSeconds": 5, "lengthInMeters": 50}},
            {"originIndex": 0, "destinationIndex": 1, "detailedError": {"code": "NO_ROUTE"}},
        ]})
    p = TomTomProvider("k", client_for(handler), QuotaTracker(tmp_path / "q.json", 2500))
    cm = p.matrix(pts(1), pts(2, 1))
    assert cm.live.tolist() == [[True, False]]
    assert np.isnan(cm.time_s[0, 1])


def test_quota_warns_at_80_percent(tmp_path):
    q = QuotaTracker(tmp_path / "q.json", 100, today=lambda: dt.date(2026, 11, 24))
    q.add(79)
    assert q.warnings == []
    q.add(1)
    assert q.warnings and "80%" in q.warnings[0]
    with pytest.raises(QuotaExceeded):
        q.check(21)
    q2 = QuotaTracker(tmp_path / "q.json", 100, today=lambda: dt.date(2026, 11, 25))
    assert q2.used() == 0


def test_geocoder_fallback_and_cache(tmp_path):
    calls = []

    def handler(request: httpx.Request):
        calls.append(request.url.host)
        if request.url.host == "api.tomtom.com":
            return httpx.Response(429)
        assert "User-Agent" in request.headers
        return httpx.Response(200, json=[{"lat": "-23.56", "lon": "-46.65", "display_name": "Av. Paulista"}])

    client = client_for(handler)
    quota = QuotaTracker(tmp_path / "q.json", 2500)
    nom = NominatimGeocoder(client, sleep=lambda s: None)
    g = CachedGeocoder([TomTomGeocoder("k", client, quota), nom], tmp_path / "geo.json")
    p = g.geocode("Av. Paulista, 1000")
    assert (p.lat, p.source) == (-23.56, "nominatim")
    assert calls == ["api.tomtom.com", "nominatim.openstreetmap.org"]
    g2 = CachedGeocoder([], tmp_path / "geo.json")
    assert g2.geocode("av.  paulista, 1000").source == "nominatim (cache)"


def test_nominatim_throttles(tmp_path):
    t = [0.0]
    slept = []
    NominatimGeocoder._last_call = -10.0
    nom = NominatimGeocoder(
        client_for(lambda r: httpx.Response(200, json=[])),
        sleep=lambda s: (slept.append(s), t.__setitem__(0, t[0] + s)),
        clock=lambda: t[0],
    )
    nom.geocode("a")
    nom.geocode("b")
    assert slept == [pytest.approx(1.0)]


def test_geocoder_coordinates_and_failure(tmp_path):
    g = CachedGeocoder([], tmp_path / "geo.json")
    assert g.geocode("-23.5, -46.6").lat == -23.5
    with pytest.raises(GeocodeError):
        g.geocode("lugar nenhum")
