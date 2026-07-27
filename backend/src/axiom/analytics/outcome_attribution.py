from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

from axiom.domain.enums import Direction, EngineMode
from axiom.domain.models import MarketState


SYSTEM_GREEKS = {
    "PRIMARY_OPTIONS": ("gamma", "vanna", "charm", "speed", "zomma", "color", "ultima"),
    "MOMENTUM_TRIAD": ("zomma", "speed", "delta"),
    "GAMMA_DYNAMICS": ("zomma", "color", "speed", "gamma"),
}


class OutcomeAttributionTracker:
    """Tracks observed excursions after qualified, independent system decisions."""

    def __init__(self, horizon_minutes: int = 30, cooldown_seconds: int = 300):
        self.horizon = timedelta(minutes=horizon_minutes)
        self.cooldown = timedelta(seconds=cooldown_seconds)
        self._active: dict[str, dict[str, Any]] = {}
        self._last_signal: dict[tuple[str, str], datetime] = {}
        self._history: dict[str, dict[str, deque[float]]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=100))
        )

    @staticmethod
    def _direction_sign(direction: Direction) -> int:
        return 1 if direction == Direction.UP else -1

    @staticmethod
    def _qualified_systems(state: MarketState) -> list[tuple[str, Direction]]:
        systems: list[tuple[str, Direction]] = []
        if state.options_bias_qualified and state.options_bias != Direction.NEUTRAL:
            systems.append(("PRIMARY_OPTIONS", state.options_bias))
        triad = state.momentum_triad
        if triad and triad.aligned and triad.decision != Direction.NEUTRAL:
            systems.append(("MOMENTUM_TRIAD", triad.decision))
        gamma = state.gamma_dynamics
        if gamma and gamma.qualified and gamma.decision != Direction.NEUTRAL:
            systems.append(("GAMMA_DYNAMICS", gamma.decision))
        return systems

    def _relative_scores(self, symbol: str, system: str, state: MarketState, direction: Direction) -> dict[str, float]:
        greeks = state.greeks
        if greeks is None:
            return {}
        direction_sign = self._direction_sign(direction)
        scores: dict[str, float] = {}
        for name in SYSTEM_GREEKS[system]:
            value = float(getattr(greeks, name))
            samples = list(self._history[symbol][name])
            magnitude = abs(value)
            percentile = (
                (sum(item < magnitude for item in samples) + 0.5 * sum(item == magnitude for item in samples))
                / len(samples)
                if samples else 0.5
            )
            sign = 1 if value > 0 else -1 if value < 0 else 0
            scores[name] = direction_sign * sign * percentile
        return scores

    @staticmethod
    def _leaders(scores: dict[str, float]) -> tuple[str | None, str | None]:
        if not scores:
            return None, None
        return max(scores, key=scores.get), min(scores, key=scores.get)

    def process(
        self,
        state: MarketState,
        mode: EngineMode,
        price: float,
        price_source: str,
        price_observed_at: datetime,
        price_source_timestamp: datetime | None = None,
    ) -> list[dict[str, Any]]:
        now = state.timestamp
        symbol = state.symbol.upper()
        updates: list[dict[str, Any]] = []

        # First update all open windows with an observed price and current Greeks.
        for signal_id, record in list(self._active.items()):
            if record["symbol"] != symbol:
                continue
            scores = self._relative_scores(symbol, record["system"], state, Direction(record["direction"]))
            if price > record["highest_price"]:
                record["highest_price"] = price
                record["highest_at"] = now
                record["greek_scores_at_high"] = scores
            if price < record["lowest_price"]:
                record["lowest_price"] = price
                record["lowest_at"] = now
                record["greek_scores_at_low"] = scores
            sign = 1 if record["direction"] == Direction.UP.value else -1
            record["favorable_points"] = (
                record["highest_price"] - record["entry_price"]
                if sign > 0 else record["entry_price"] - record["lowest_price"]
            )
            record["adverse_points"] = (
                record["lowest_price"] - record["entry_price"]
                if sign > 0 else record["entry_price"] - record["highest_price"]
            )
            favorable_scores = record["greek_scores_at_high"] if sign > 0 else record["greek_scores_at_low"]
            baseline = record["greek_scores_at_signal"]
            if baseline and favorable_scores:
                record["decay_greek"] = max(
                    baseline, key=lambda name: baseline[name] - favorable_scores.get(name, baseline[name])
                )
            record["price_source"] = price_source
            record["price_observed_at"] = price_observed_at
            record["price_source_timestamp"] = price_source_timestamp
            if now >= record["expires_at"]:
                record["status"] = "COMPLETE"
                del self._active[signal_id]
            updates.append(dict(record))

        # Create one event per system after cooldown; this prevents five-second duplicates.
        for system, direction in self._qualified_systems(state):
            key = (symbol, system)
            if key in self._last_signal and now - self._last_signal[key] < self.cooldown:
                continue
            scores = self._relative_scores(symbol, system, state, direction)
            strongest, weakest = self._leaders(scores)
            signal_id = str(uuid4())
            record = {
                "id": signal_id,
                "system": system,
                "mode": mode.value,
                "symbol": symbol,
                "proxy_for": "NQ" if system == "MOMENTUM_TRIAD" else None,
                "direction": direction.value,
                "alerted_at": now,
                "expires_at": now + self.horizon,
                "status": "TRACKING",
                "entry_price": price,
                "highest_price": price,
                "highest_at": now,
                "lowest_price": price,
                "lowest_at": now,
                "favorable_points": 0.0,
                "adverse_points": 0.0,
                "seconds_to_high": 0.0,
                "seconds_to_low": 0.0,
                "strongest_greek": strongest,
                "weakest_greek": weakest,
                "decay_greek": weakest,
                "greek_scores_at_signal": scores,
                "greek_scores_at_high": scores,
                "greek_scores_at_low": scores,
                "greek_values_at_signal": {
                    name: float(getattr(state.greeks, name)) for name in SYSTEM_GREEKS[system]
                } if state.greeks else {},
                "price_source": price_source,
                "price_observed_at": price_observed_at,
                "price_source_timestamp": price_source_timestamp,
                "nq_price": price if symbol == "NQ" else None,
                "qqq_price": price if symbol == "QQQ" else None,
            }
            self._active[signal_id] = record
            self._last_signal[key] = now
            updates.append(dict(record))

        for record in updates:
            record["seconds_to_high"] = max(
                0.0, (record["highest_at"] - record["alerted_at"]).total_seconds()
            )
            record["seconds_to_low"] = max(
                0.0, (record["lowest_at"] - record["alerted_at"]).total_seconds()
            )

        if state.greeks:
            for name in state.greeks.model_fields:
                self._history[symbol][name].append(abs(float(getattr(state.greeks, name))))
        return updates
