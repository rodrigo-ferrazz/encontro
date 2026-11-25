"""Configuração lida do ambiente (.env) com valores padrão sensatos."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value not in (None, "") else default


@dataclass
class Settings:
    cache_dir: Path = field(default_factory=lambda: Path("cache"))
    place: str = "São Paulo, São Paulo, Brazil"
    tomtom_api_key: str | None = None
    # Free tier da TomTom: 2.500 requisições "non-tile" por dia.
    tomtom_daily_limit: int = 2500
    # Não está documentado se cada célula da matriz conta como uma transação.
    # Por precaução, o padrão é contar cada célula (1); use 0 para contar por requisição.
    tomtom_count_cells: bool = True
    # Freemium: no máximo 200 células por requisição síncrona da Matrix Routing v2.
    tomtom_max_cells: int = 200
    http_timeout_s: float = 15.0
    # Por quanto tempo uma resposta de matriz é reutilizada (trânsito muda rápido).
    matrix_cache_ttl_s: int = 300

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        return cls(
            cache_dir=Path(os.getenv("ENCONTRO_CACHE_DIR", "cache")),
            place=os.getenv("ENCONTRO_PLACE", "São Paulo, São Paulo, Brazil"),
            tomtom_api_key=os.getenv("TOMTOM_API_KEY") or None,
            tomtom_daily_limit=_env_int("TOMTOM_DAILY_LIMIT", 2500),
            tomtom_count_cells=os.getenv("TOMTOM_COUNT_CELLS", "1") not in ("0", "false", "False"),
            tomtom_max_cells=_env_int("TOMTOM_MAX_CELLS", 200),
            http_timeout_s=_env_float("ENCONTRO_HTTP_TIMEOUT", 15.0),
            matrix_cache_ttl_s=_env_int("ENCONTRO_MATRIX_TTL", 300),
        )
