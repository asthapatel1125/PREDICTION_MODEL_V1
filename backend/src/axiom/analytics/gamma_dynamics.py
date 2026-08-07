from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, time
from math import sqrt
from zoneinfo import ZoneInfo

from axiom.domain.enums import Direction
from axiom.domain.models import GammaDynamics, Greeks


GAMMA_DYNAMICS_V1_GREEKS = ("zomma", "color", "speed", "gamma")
GAMMA_DYNAMICS_V2_GREEKS = (*GAMMA_DYNAMICS_V1_GREEKS, "vomma", "ultima")
GAMMA_DYNAMICS_V2_IDEALS = {
    "zomma": 0.40,
    "color": 0.35,
    "speed": 0.30,
    "gamma": 0.25,
    "vomma": 0.30,
    "ultima": 0.40,
}


class GammaDynamicsSix:
    """Gamma Dynamics 2.0: chain-level dealer-positioning model.

    The public result continues to expose the six native Greeks for the live
    stream and event log. Qualification itself is calculated from the
    contract-level, open-interest-weighted features in the supplied spec.
    """

    feature_weights = {
        "gamma_squeeze_score": 0.35,
        "weighted_charm": 0.20,
        "weighted_speed": 0.15,
        "weighted_vanna": 0.15,
        "weighted_color": 0.10,
        "net_dealer_delta": 0.10,
    }

    def __init__(self, intensity_threshold: float = 0.65, minimum_history: int = 20,
                 zero_tolerance: float = 1e-12, speed_threshold: float = 0.30,
                 color_threshold: float = -0.35, cooldown_seconds: int = 600,
                 market_timezone: str = "America/New_York"):
        self.intensity_threshold = intensity_threshold
        self.minimum_history = minimum_history
        self.zero_tolerance = zero_tolerance
        self.speed_threshold = speed_threshold
        self.color_threshold = color_threshold
        self.cooldown_seconds = cooldown_seconds
        self.market_tz = ZoneInfo(market_timezone)
        self._last_alert: dict[str, datetime] = {}

    @staticmethod
    def _absolute_percentile(current: float, values: Sequence[float]) -> float:
        finite = [abs(float(value)) for value in values]
        if not finite:
            return 0.0
        target = abs(float(current))
        below = sum(value < target for value in finite)
        equal = sum(value == target for value in finite)
        return min(1.0, max(0.0, (below + 0.5 * equal) / len(finite)))

    def _scaled(self, current: float, values: Sequence[float]) -> float:
        samples = [float(value) for value in values]
        if not samples:
            return 0.0
        mean = sum(samples) / len(samples)
        variance = sum((value - mean) ** 2 for value in samples) / len(samples)
        standard_deviation = sqrt(variance)
        # Greek units span many orders of magnitude. An absolute 1e-12 floor
        # incorrectly flattened real variation in small higher-order Greeks.
        # Only treat dispersion at machine precision relative to the series
        # level as constant; otherwise apply the requested z-score formula.
        numerical_floor = max(abs(mean) * 1e-15, 1e-18)
        if standard_deviation <= numerical_floor:
            return 0.0
        return max(-3.0, min(3.0, (float(current) - mean) / standard_deviation)) / 3.0

    def calculate(self, greeks: Greeks, history: Sequence[Greeks], source_symbol: str,
                  chain_metrics: dict[str, float] | None = None,
                  metric_history: Sequence[dict[str, float]] = (),
                  timestamp: datetime | None = None) -> GammaDynamics:
        inputs = {name: float(getattr(greeks, name)) for name in GAMMA_DYNAMICS_V2_GREEKS}
        samples = list(history)
        percentiles = {name: self._absolute_percentile(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        normalized = {name: self._scaled(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        metrics = {name: float(value) for name, value in (chain_metrics or {}).items()}
        metric_samples = list(metric_history)
        # Primary bars are one minute, so five earlier observations represent
        # the specification's t - 300 second ATM-IV reference point.
        previous_iv = metric_samples[-5].get("atm_iv", 0.0) if len(metric_samples) >= 5 else 0.0
        iv_available = metrics.get("atm_iv_available", 0.0) > 0 and previous_iv > self.zero_tolerance
        metrics["iv_expansion"] = (metrics.get("atm_iv", 0.0) - previous_iv) / previous_iv if iv_available else 0.0
        metrics["iv_expansion_available"] = float(iv_available)
        normalized_features = {
            name: self._scaled(metrics.get(name, 0.0), [item.get(name, 0.0) for item in metric_samples])
            for name in self.feature_weights
        }
        squeeze_score = sum(self.feature_weights[name] * normalized_features[name] for name in self.feature_weights)
        probability = min(0.95, max(0.0, 0.50 + squeeze_score / 20.0))
        direction_value = metrics.get("net_dealer_delta", 0.0) + metrics.get("weighted_charm", 0.0)
        direction = Direction.UP if direction_value > self.zero_tolerance else Direction.DOWN if direction_value < -self.zero_tolerance else Direction.NEUTRAL
        observed_at = timestamp.astimezone(self.market_tz) if timestamp else None
        active_window = bool(observed_at and (
            time(9, 45) <= observed_at.time() <= time(11, 30)
            or time(14, 30) <= observed_at.time() <= time(16, 0)
        ))
        previous_alert = self._last_alert.get(source_symbol)
        cooldown_ok = previous_alert is None or timestamp is None or (timestamp - previous_alert).total_seconds() >= self.cooldown_seconds
        warmed = len(metric_samples) >= self.minimum_history
        checks = {
            "chain_available": metrics.get("chain_available", 0.0) > 0,
            "baseline": warmed,
            "squeeze": squeeze_score > self.intensity_threshold,
            "speed": abs(normalized_features["weighted_speed"]) > self.speed_threshold,
            "color": normalized_features["weighted_color"] < self.color_threshold,
            "liquidity": metrics.get("liquidity_available", 0.0) > 0 and metrics.get("bad_liquidity", 1.0) == 0.0,
            "active_window": active_window,
            "cooldown": cooldown_ok,
            "atm_spread": metrics.get("atm_spread", float("inf")) <= 0.20,
            "direction": direction != Direction.NEUTRAL,
        }
        qualified = all(checks.values())
        if qualified and timestamp is not None:
            self._last_alert[source_symbol] = timestamp
        decision = direction if qualified else Direction.NEUTRAL
        pressure = (1.0 if direction == Direction.UP else -1.0 if direction == Direction.DOWN else 0.0) * min(1.0, abs(squeeze_score) / 3.0)
        intensity = probability
        contributions = {name: self.feature_weights[name] * normalized_features[name] for name in self.feature_weights}
        ideal_ranges = {
            "zomma": "native stream display; chain model uses OI-weighted features",
            "color": "normalized weighted Color < -0.35",
            "speed": "|normalized weighted Speed| > 0.30",
            "gamma": "Net GEX determines the Key Fault Line",
            "ultima": "native stream display; preserved for the six-Greek engine",
            "vomma": "native stream display; preserved for the six-Greek engine",
        }
        if not checks["chain_available"]:
            explanation = "Waiting for a contract-level option-chain snapshot; aggregate Greeks alone cannot calculate Gamma Dynamics 2.0."
        elif not warmed:
            explanation = f"Building the chain-feature baseline: {len(metric_samples)}/{self.minimum_history} observations."
        elif not qualified:
            failed = ", ".join(name.replace("_", " ") for name, passed in checks.items() if not passed)
            explanation = f"Chain model is not actionable: {failed} gate{'s' if ',' in failed else ''} not satisfied."
        else:
            explanation = (
                f"OI-weighted Charm plus Net Dealer Delta establish {direction.value.lower()} direction; "
                f"GEX fault-line pressure, Speed, Color, liquidity, spread, time, and cooldown all qualify."
            )
        return GammaDynamics(
            decision=decision, qualified=qualified, source_symbol=source_symbol, intensity=intensity,
            pressure=pressure, history_points=len(metric_samples), intensity_threshold=self.intensity_threshold,
            inputs=inputs, percentiles=percentiles, normalized=normalized,
            contributions=contributions, ideal_ranges=ideal_ranges, chain_metrics=metrics,
            normalized_features=normalized_features, squeeze_score=squeeze_score,
            probability=probability,
            target_price=(metrics.get("spot", 0.0) + 0.75 * (1 if direction == Direction.UP else -1)) if metrics.get("spot", 0.0) > 0 and direction != Direction.NEUTRAL else None,
            alert_checks=checks, explanation=explanation,
        )


class GammaDynamicsQuartet(GammaDynamicsSix):
    """Original Gamma Dynamics 1.0: Zomma, Color, Speed, and Gamma."""

    def calculate(self, greeks: Greeks, history: Sequence[Greeks], source_symbol: str) -> GammaDynamics:
        inputs = {name: float(getattr(greeks, name)) for name in GAMMA_DYNAMICS_V1_GREEKS}
        samples = list(history)
        percentiles = {name: self._absolute_percentile(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        normalized = {name: self._scaled(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        intensity = (abs(normalized["zomma"]) + abs(normalized["color"])) / 2
        pressure_magnitude = (abs(normalized["speed"]) + abs(normalized["gamma"])) / 2
        gamma_active = abs(inputs["gamma"]) > self.zero_tolerance
        aligned_up = inputs["speed"] > self.zero_tolerance and gamma_active
        aligned_down = inputs["speed"] < -self.zero_tolerance and gamma_active
        pressure = pressure_magnitude if aligned_up else -pressure_magnitude if aligned_down else 0.0
        warmed = len(samples) >= self.minimum_history
        qualified = warmed and intensity >= self.intensity_threshold and (aligned_up or aligned_down)
        decision = Direction.UP if qualified and aligned_up else Direction.DOWN if qualified and aligned_down else Direction.NEUTRAL
        contributions = {
            "zomma": .5 * abs(normalized["zomma"]), "color": .5 * abs(normalized["color"]),
            "speed": .5 * abs(normalized["speed"]) * (1 if aligned_up else -1 if aligned_down else 0),
            "gamma": .5 * abs(normalized["gamma"]),
        }
        ideal_ranges = {
            "zomma":"|normalized| >= 0.30",
            "color":"|normalized| >= 0.30",
            "speed":"|normalized| >= 0.30 and signed with the call direction",
            "gamma":"|normalized| >= 0.30; active curvature base",
        }
        if not warmed:
            explanation=f"Building a relative baseline: {len(samples)}/{self.minimum_history} observations."
        elif not gamma_active or abs(inputs["speed"])<=self.zero_tolerance:
            explanation="Gamma or Speed is effectively zero, so signed curvature pressure is not confirmed."
        elif intensity<self.intensity_threshold:
            explanation="Gamma and Speed align, but average |normalized| Zomma/Color intensity is below 0.65."
        else:
            explanation=f"Speed indicates {'upward' if aligned_up else 'downward'} curvature change while Gamma supplies the base and Zomma/Color confirm intensity."
        return GammaDynamics(
            decision=decision,qualified=qualified,source_symbol=source_symbol,intensity=intensity,
            pressure=pressure,history_points=len(samples),intensity_threshold=self.intensity_threshold,
            inputs=inputs,percentiles=percentiles,normalized=normalized,
            contributions=contributions,ideal_ranges=ideal_ranges,explanation=explanation,
        )
