from __future__ import annotations

from datetime import datetime, timedelta
from math import inf, isfinite
from zoneinfo import ZoneInfo


class MaxTrackerToday:
    """Monotonic intraday extrema reset at 04:00 America/New_York."""

    METRICS = (
        "speed", "zomma", "dex", "gex", "dealer_flow", "zero_gamma",
        "pressure_flow", "roc", "div", "cvd_proxy",
    )

    def __init__(self, timezone_name: str = "America/New_York") -> None:
        self.tz = ZoneInfo(timezone_name)
        self.session = None
        self.maxima: dict[str, float] = {name: 0.0 for name in self.METRICS}
        self.min_qqq = inf
        self.max_qqq = -inf

    def _session_key(self, timestamp: datetime):
        local = timestamp.astimezone(self.tz)
        return (local - timedelta(days=1)).date() if local.hour < 4 else local.date()

    def ensure_session(self, timestamp: datetime) -> None:
        key = self._session_key(timestamp)
        if self.session != key:
            self.reset()
            self.session = key

    def reset(self) -> None:
        self.maxima = {name: 0.0 for name in self.METRICS}
        self.min_qqq, self.max_qqq = inf, -inf

    def update(self, metric: str, value: float, timestamp: datetime) -> float:
        self.ensure_session(timestamp)
        clean = float(value) if isfinite(float(value)) else 0.0
        self.maxima[metric] = max(self.maxima.get(metric, 0.0), abs(clean))
        return self.maxima[metric]

    def update_qqq(self, value: float, timestamp: datetime) -> tuple[float, float]:
        self.ensure_session(timestamp)
        clean = float(value)
        if isfinite(clean):
            self.min_qqq = min(self.min_qqq, clean)
            self.max_qqq = max(self.max_qqq, clean)
        return self.min_qqq, self.max_qqq

    def percent(self, metric: str, value: float, timestamp: datetime) -> float:
        maximum = self.update(metric, value, timestamp)
        return min(100.0, abs(float(value)) / maximum * 100.0) if maximum > 0 else 0.0

    def qqq_percent(self, value: float, timestamp: datetime) -> float:
        low, high = self.update_qqq(value, timestamp)
        return max(0.0, min(100.0, (float(value) - low) / (high - low) * 100.0)) if high > low else 50.0
