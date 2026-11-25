"""Formatação da saída: texto legível e JSON, com links do Google Maps."""

from __future__ import annotations

import urllib.parse

import numpy as np

from .solver import Solution


def fmt_time(s: float) -> str:
    if not np.isfinite(s):
        return "—"
    m = round(s / 60)
    return f"{m} min" if m < 60 else f"{m // 60}h{m % 60:02d}"


def fmt_dist(m: float) -> str:
    if not np.isfinite(m):
        return "—"
    return f"{m / 1000:.1f} km".replace(".", ",")


def maps_point(lat: float, lon: float) -> str:
    return "https://www.google.com/maps/search/?" + urllib.parse.urlencode(
        {"api": 1, "query": f"{lat:.6f},{lon:.6f}"}
    )


def maps_route(o_lat: float, o_lon: float, d_lat: float, d_lon: float) -> str:
    return "https://www.google.com/maps/dir/?" + urllib.parse.urlencode(
        {
            "api": 1,
            "origin": f"{o_lat:.6f},{o_lon:.6f}",
            "destination": f"{d_lat:.6f},{d_lon:.6f}",
            "travelmode": "driving",
        }
    )


def _score_text(sol: Solution, value: float) -> str:
    weight = "time" if sol.request.metric in ("tempo", "time") else "length"
    if sol.criterion.name == "igualitario":
        unit = "2 min" if weight == "time" else "1 km"
        return f"faixa de diferença {int(value)} (×{unit})"
    return fmt_time(value) if weight == "time" else fmt_dist(value)


def to_text(sol: Solution, show_links: bool = True) -> str:
    req = sol.request
    lines = []
    lines.append(f"Critério: {sol.criterion.label}")
    lines.append(
        f"Objetivo: {'casa de alguém' if req.objective == 'casa' else 'qualquer ponto da cidade'}"
        f" · métrica: {req.metric}"
        + (f" · limite: {_score_text(sol, req.limit)}" if req.limit is not None else "")
    )
    lines.append(
        "Fonte: "
        + ("trânsito ao vivo (TomTom, saindo agora)" if sol.live_used else "estimativa local (OSM, sem trânsito)")
        + f" · candidatos: {sol.n_candidates_local} no grafo → {sol.n_candidates_refined} refinados"
    )
    lines.append("")
    lines.append("Pessoas:")
    for p in sol.people:
        lines.append(f"  {p.person.name}: {p.geo.label}  [{p.geo.source}]")
    lines.append("")

    if not sol.results:
        lines.append("Nenhum resultado.")
    for r in sol.results:
        title = f"Casa de {r.host}" if r.host else (r.street or "Ponto sem nome")
        lines.append(f"#{r.rank}  {title}  ({r.lat:.5f}, {r.lon:.5f})")
        lines.append(f"    pontuação: {_score_text(sol, r.score)}")
        if show_links:
            lines.append(f"    mapa: {maps_point(r.lat, r.lon)}")
        width = max(len(p.person.name) for p in sol.people)
        for i, p in enumerate(sol.people):
            tag = "ao vivo" if r.live[i] else "estimativa"
            lines.append(
                f"    {p.person.name:<{width}}  {fmt_time(r.time_s[i]):>7}  {fmt_dist(r.dist_m[i]):>8}  [{tag}]"
            )
            if show_links:
                lines.append(f"      {maps_route(p.geo.lat, p.geo.lon, r.lat, r.lon)}")
        lines.append("")

    for w in sol.warnings:
        lines.append(f"⚠ {w}")
    return "\n".join(lines).rstrip() + "\n"


def to_dict(sol: Solution) -> dict:
    def num(x: float) -> float | None:
        return float(x) if np.isfinite(x) else None

    return {
        "criterio": sol.criterion.name,
        "objetivo": sol.request.objective,
        "metrica": sol.request.metric,
        "transito_ao_vivo": sol.live_used,
        "pessoas": [
            {"nome": p.person.name, "endereco": p.person.address, "lat": p.geo.lat,
             "lon": p.geo.lon, "geocoder": p.geo.source, "snap_m": round(p.snap_m, 1)}
            for p in sol.people
        ],
        "resultados": [
            {
                "rank": r.rank,
                "lat": r.lat,
                "lon": r.lon,
                "anfitriao": r.host,
                "via": r.street or None,
                "pontuacao": num(r.score),
                "mapa": maps_point(r.lat, r.lon),
                "deslocamentos": [
                    {
                        "nome": p.person.name,
                        "tempo_s": num(r.time_s[i]),
                        "distancia_m": num(r.dist_m[i]),
                        "fonte": "ao_vivo" if r.live[i] else "estimativa_local",
                        "rota": maps_route(p.geo.lat, p.geo.lon, r.lat, r.lon),
                    }
                    for i, p in enumerate(sol.people)
                ],
            }
            for r in sol.results
        ],
        "avisos": sol.warnings,
    }
