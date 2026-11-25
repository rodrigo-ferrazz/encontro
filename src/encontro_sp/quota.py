"""Contador diário de chamadas às APIs, persistido em `cache/quota.json`."""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

log = logging.getLogger(__name__)

WARN_FRACTION = 0.8


class QuotaExceeded(RuntimeError):
    pass


class QuotaTracker:
    def __init__(self, path: Path, daily_limit: int, today: callable = dt.date.today):
        self.path = path
        self.daily_limit = daily_limit
        self._today = today
        self.warnings: list[str] = []

    def _load(self) -> dict:
        try:
            return json.loads(self.path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, indent=2, sort_keys=True))

    def used(self, service: str = "tomtom") -> int:
        return int(self._load().get(str(self._today()), {}).get(service, 0))

    def remaining(self, service: str = "tomtom") -> int:
        return max(self.daily_limit - self.used(service), 0)

    def check(self, units: int, service: str = "tomtom") -> None:
        """Levanta QuotaExceeded se `units` não cabem no que resta do dia."""
        if units > self.remaining(service):
            raise QuotaExceeded(
                f"cota diária de {service} insuficiente: precisa de {units}, "
                f"restam {self.remaining(service)} de {self.daily_limit}"
            )

    def add(self, units: int, service: str = "tomtom") -> None:
        data = self._load()
        today = str(self._today())
        # Mantém só os últimos dias para o arquivo não crescer para sempre.
        data = {k: v for k, v in data.items() if k >= str(self._today() - dt.timedelta(days=7))}
        day = data.setdefault(today, {})
        day[service] = int(day.get(service, 0)) + units
        self._save(data)
        used = day[service]
        if used >= WARN_FRACTION * self.daily_limit:
            msg = (
                f"Atenção: {used}/{self.daily_limit} unidades de {service} usadas hoje "
                f"({used / self.daily_limit:.0%} da cota gratuita)."
            )
            log.warning(msg)
            if msg not in self.warnings:
                self.warnings.append(msg)
