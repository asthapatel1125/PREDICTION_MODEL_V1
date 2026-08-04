from __future__ import annotations

from collections.abc import Sequence
from math import sqrt

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
    """Classifies six-Greek Gamma dynamics without mixing incompatible Greek units.

    Speed is the directional term. Gamma is the curvature base, while Zomma,
    Color, Ultima, and Vomma describe how that curvature can change with
    volatility and time. Each native value is normalized against its own
    rolling distribution before the terms are combined.
    """

    def __init__(self, intensity_threshold: float = 0.65, minimum_history: int = 20, zero_tolerance: float = 1e-12):
        self.intensity_threshold = intensity_threshold
        self.minimum_history = minimum_history
        self.zero_tolerance = zero_tolerance

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

    def calculate(self, greeks: Greeks, history: Sequence[Greeks], source_symbol: str) -> GammaDynamics:
        inputs = {name: float(getattr(greeks, name)) for name in GAMMA_DYNAMICS_V2_GREEKS}
        samples = list(history)
        percentiles = {name: self._absolute_percentile(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        normalized = {name: self._scaled(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        # Zomma, Color, Vomma, and Ultima are volatility/time context gates. Their
        # signs depend on the option surface, so their magnitudes confirm that the
        # regime is active. Speed and Gamma must agree in sign to establish the
        # prospective underlying direction.
        intensity_weights = {"zomma": .30, "color": .25, "ultima": .25, "vomma": .20}
        intensity = sum(abs(normalized[name]) * weight for name, weight in intensity_weights.items())
        pressure_weights = {"speed": .45, "gamma": .30, "zomma": .15, "vomma": .10}
        pressure_magnitude = sum(abs(normalized[name]) * weight for name, weight in pressure_weights.items())
        context_confirmed = all(
            abs(normalized[name]) >= GAMMA_DYNAMICS_V2_IDEALS[name]
            for name in ("zomma", "color", "vomma", "ultima")
        )
        aligned_up = (
            normalized["speed"] >= GAMMA_DYNAMICS_V2_IDEALS["speed"]
            and normalized["gamma"] >= GAMMA_DYNAMICS_V2_IDEALS["gamma"]
            and inputs["speed"] > self.zero_tolerance
            and inputs["gamma"] > self.zero_tolerance
        )
        aligned_down = (
            normalized["speed"] <= -GAMMA_DYNAMICS_V2_IDEALS["speed"]
            and normalized["gamma"] <= -GAMMA_DYNAMICS_V2_IDEALS["gamma"]
            and inputs["speed"] < -self.zero_tolerance
            and inputs["gamma"] < -self.zero_tolerance
        )
        pressure = pressure_magnitude if aligned_up else -pressure_magnitude if aligned_down else 0.0
        warmed = len(samples) >= self.minimum_history
        qualified = warmed and context_confirmed and intensity >= self.intensity_threshold and (aligned_up or aligned_down)
        decision = Direction.UP if qualified and aligned_up else Direction.DOWN if qualified and aligned_down else Direction.NEUTRAL
        contributions = {
            "speed": pressure_weights["speed"] * abs(normalized["speed"]) * (1 if aligned_up else -1 if aligned_down else 0),
            "gamma": pressure_weights["gamma"] * abs(normalized["gamma"]),
            "zomma": intensity_weights["zomma"] * abs(normalized["zomma"]),
            "color": intensity_weights["color"] * abs(normalized["color"]),
            "ultima": intensity_weights["ultima"] * abs(normalized["ultima"]),
            "vomma": intensity_weights["vomma"] * abs(normalized["vomma"]),
        }
        ideal_ranges = {
            "zomma": "|normalized| >= 0.40; IV-to-Gamma regime confirmation",
            "color": "|normalized| >= 0.35; time-to-Gamma regime confirmation",
            "speed": "LONG >= +0.30 / SHORT <= -0.30; directional acceleration",
            "gamma": "LONG >= +0.25 / SHORT <= -0.25; signed curvature agreement",
            "ultima": "|normalized| >= 0.40; volatility-instability confirmation",
            "vomma": "|normalized| >= 0.30; volatility-convexity confirmation",
        }
        if not warmed:
            explanation = f"Building a relative baseline: {len(samples)}/{self.minimum_history} observations."
        elif not (aligned_up or aligned_down):
            explanation = "Speed and Gamma have not reached their signed long/short thresholds in the same direction."
        elif not context_confirmed:
            explanation = "Directional curvature is present, but the Zomma/Color/Vomma/Ultima context gates are not all confirmed."
        elif intensity < self.intensity_threshold:
            explanation = "Gamma and Speed align, but weighted |normalized| Zomma/Color/Ultima/Vomma intensity is below 0.65."
        else:
            direction = "upward" if aligned_up else "downward"
            explanation = f"Speed indicates {direction} curvature change, Gamma supplies the active curvature base, and Zomma/Color/Ultima/Vomma confirm elevated volatility-time sensitivity."
        return GammaDynamics(
            decision=decision, qualified=qualified, source_symbol=source_symbol, intensity=intensity,
            pressure=pressure, history_points=len(samples), intensity_threshold=self.intensity_threshold,
            inputs=inputs, percentiles=percentiles, normalized=normalized,
            contributions=contributions, ideal_ranges=ideal_ranges, explanation=explanation,
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
