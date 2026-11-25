"""Linha de comando: `encontro buscar pessoas.yaml ...`."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import httpx
import typer
import yaml

from . import criteria, output
from .config import Settings
from .geocode import CachedGeocoder, GeocodeError, NominatimGeocoder, TomTomGeocoder
from .graph import load_or_build
from .providers import TomTomProvider
from .quota import QuotaTracker
from .solver import Person, Request, Solver

app = typer.Typer(add_completion=False, help="Melhor ponto de encontro de carro em São Paulo.")


def _read_people(file: Optional[Path], pessoas: list[str]) -> list[Person]:
    people: list[Person] = []
    if file:
        data = yaml.safe_load(file.read_text())
        items = data.get("pessoas", data) if isinstance(data, dict) else data
        for it in items:
            people.append(Person(str(it["nome"]), str(it["endereco"])))
    for p in pessoas:
        if "=" not in p:
            raise typer.BadParameter(f"use NOME=ENDEREÇO, recebi {p!r}", param_hint="--pessoa")
        name, addr = p.split("=", 1)
        people.append(Person(name.strip(), addr.strip()))
    return people


@app.command()
def buscar(
    arquivo: Optional[Path] = typer.Argument(None, exists=True, help="YAML com a lista `pessoas` (nome, endereco)."),
    pessoa: list[str] = typer.Option([], "--pessoa", "-p", help="NOME=ENDEREÇO (repetível). Aceita 'lat,lon'."),
    objetivo: str = typer.Option("cidade", "--objetivo", "-o", help="casa | cidade"),
    criterio: str = typer.Option("justo", "--criterio", "-c", help="justo | total | igualitario | limite"),
    limite: Optional[float] = typer.Option(None, "--limite", "-l", help="Critério limite (ou teto opcional no igualitario): minutos (tempo) ou km (distância)."),
    metrica: str = typer.Option("tempo", "--metrica", help="tempo | distancia"),
    k: int = typer.Option(5, "--k", "-k", min=1, help="Quantos resultados devolver."),
    m: Optional[int] = typer.Option(None, "--m", help="Candidatos do pré-filtro enviados ao trânsito ao vivo."),
    offline: bool = typer.Option(False, "--offline", help="Não usa a TomTom (só grafo local)."),
    as_json: bool = typer.Option(False, "--json", help="Saída em JSON."),
    sem_links: bool = typer.Option(False, "--sem-links", help="Omite os links do Google Maps no texto."),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
):
    """Calcula o ranking dos melhores pontos de encontro."""
    logging.basicConfig(level=logging.INFO if verbose else logging.WARNING, format="%(levelname)s %(message)s")
    settings = Settings.from_env()
    people = _read_people(arquivo, pessoa)
    if len(people) < 2:
        raise typer.BadParameter("informe pelo menos 2 pessoas (arquivo YAML ou --pessoa)")
    try:
        criteria.get(criterio)
    except KeyError as e:
        raise typer.BadParameter(str(e), param_hint="--criterio")

    limit = None
    if limite is not None:
        limit = limite * 60 if metrica in ("tempo", "time") else limite * 1000

    quota = QuotaTracker(settings.cache_dir / "quota.json", settings.tomtom_daily_limit)
    graph = load_or_build(settings.place, settings.cache_dir)

    with httpx.Client(timeout=settings.http_timeout_s) as client:
        geocoders = []
        if settings.tomtom_api_key and not offline:
            geocoders.append(TomTomGeocoder(settings.tomtom_api_key, client, quota))
        geocoders.append(NominatimGeocoder(client))
        geocoder = CachedGeocoder(geocoders, settings.cache_dir / "geocode.json")

        live = None
        if settings.tomtom_api_key and not offline:
            live = TomTomProvider(
                settings.tomtom_api_key,
                client,
                quota,
                max_cells=settings.tomtom_max_cells,
                count_cells=settings.tomtom_count_cells,
                cache_path=settings.cache_dir / "matrix_cache.json",
                cache_ttl_s=settings.matrix_cache_ttl_s,
            )

        solver = Solver(graph, geocoder, live, max_cells=settings.tomtom_max_cells)
        req = Request(
            people=people, objective=objetivo, criterion=criterio, metric=metrica,
            k=k, limit=limit, m=m, live=not offline,
        )
        try:
            sol = solver.solve(req)
        except (GeocodeError, ValueError) as e:
            typer.secho(f"Erro: {e}", fg=typer.colors.RED, err=True)
            raise typer.Exit(1)

    sol.warnings.extend(quota.warnings)
    if as_json:
        typer.echo(json.dumps(output.to_dict(sol), ensure_ascii=False, indent=2))
    else:
        typer.echo(output.to_text(sol, show_links=not sem_links))


@app.command("baixar-grafo")
def baixar_grafo(refresh: bool = typer.Option(False, "--refresh", help="Baixa de novo mesmo com cache.")):
    """Baixa (ou atualiza) a malha viária do OSM e grava o cache."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    settings = Settings.from_env()
    g = load_or_build(settings.place, settings.cache_dir, refresh=refresh)
    typer.echo(f"Grafo pronto: {g.n_nodes} nós, {len(g.src)} arestas, {int(g.eligible.sum())} candidatos.")


@app.command()
def cota():
    """Mostra o uso diário da cota gratuita da TomTom."""
    s = Settings.from_env()
    q = QuotaTracker(s.cache_dir / "quota.json", s.tomtom_daily_limit)
    unit = "células" if s.tomtom_count_cells else "requisições"
    typer.echo(f"TomTom hoje: {q.used()} de {s.tomtom_daily_limit} {unit} ({q.remaining()} restantes).")


@app.command()
def criterios():
    """Lista os critérios disponíveis."""
    for c in criteria.REGISTRY.values():
        typer.echo(f"{c.name:<12} {c.label}")


if __name__ == "__main__":
    app()
