from __future__ import annotations

from collections.abc import Sequence
from math import sqrt

from axiom.domain.enums import Direction
from axiom.domain.models import GammaDynamics, Greeks


GAMMA_DYNAMICS_V1_GREEKS = ("zomma", "color", "speed", "gamma")
GAMMA_DYNAMICS_V2_GREEKS = (*GAMMA_DYNAMICS_V1_GREEKS, "vomma", "ultima")


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
        if standard_deviation <= self.zero_tolerance:
            return 0.0
        return max(-3.0, min(3.0, (float(current) - mean) / standard_deviation)) / 3.0

    def calculate(self, greeks: Greeks, history: Sequence[Greeks], source_symbol: str) -> GammaDynamics:
        inputs = {name: float(getattr(greeks, name)) for name in GAMMA_DYNAMICS_V2_GREEKS}
        samples = list(history)
        percentiles = {name: self._absolute_percentile(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        normalized = {name: self._scaled(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        # Volatility curvature is deliberately magnitude-based: without an IV
        # direction or moneyness surface, the signs of Vomma/Ultima/Zomma/Color
        # are not a reliable price-direction signal. Speed remains directional.
        intensity_weights = {"zomma": .30, "color": .25, "ultima": .25, "vomma": .20}
        intensity = sum(percentiles[name] * weight for name, weight in intensity_weights.items())
        pressure_weights = {"speed": .45, "gamma": .30, "zomma": .15, "vomma": .10}
        pressure_magnitude = sum(percentiles[name] * weight for name, weight in pressure_weights.items())
        gamma_active = abs(inputs["gamma"]) > self.zero_tolerance
        aligned_up = inputs["speed"] > self.zero_tolerance and gamma_active
        aligned_down = inputs["speed"] < -self.zero_tolerance and gamma_active
        pressure = pressure_magnitude if aligned_up else -pressure_magnitude if aligned_down else 0.0
        warmed = len(samples) >= self.minimum_history
        qualified = warmed and intensity >= self.intensity_threshold and (aligned_up or aligned_down)
        decision = Direction.UP if qualified and aligned_up else Direction.DOWN if qualified and aligned_down else Direction.NEUTRAL
        contributions = {
            "speed": pressure_weights["speed"] * percentiles["speed"] * (1 if aligned_up else -1 if aligned_down else 0),
            "gamma": pressure_weights["gamma"] * percentiles["gamma"],
            "zomma": intensity_weights["zomma"] * percentiles["zomma"],
            "color": intensity_weights["color"] * percentiles["color"],
            "ultima": intensity_weights["ultima"] * percentiles["ultima"],
            "vomma": intensity_weights["vomma"] * percentiles["vomma"],
        }
        ideal_ranges = {
            "zomma": "magnitude percentile >= 0.65; elevated IV-to-Gamma sensitivity",
            "color": "magnitude percentile >= 0.65; elevated time-to-Gamma sensitivity",
            "speed": "non-zero and signed with the call direction",
            "gamma": "non-zero curvature base; magnitude percentile >= 0.50 preferred",
            "ultima": "magnitude percentile >= 0.65; elevated volatility-instability context",
            "vomma": "magnitude percentile >= 0.65; elevated volatility-convexity context",
        }
        if not warmed:
            explanation = f"Building a relative baseline: {len(samples)}/{self.minimum_history} observations."
        elif not gamma_active or abs(inputs["speed"]) <= self.zero_tolerance:
            explanation = "Gamma or Speed is effectively zero, so signed curvature pressure is not confirmed."
        elif intensity < self.intensity_threshold:
            explanation = "Gamma and Speed align, but normalized Zomma/Color/Ultima/Vomma intensity is below its rolling threshold."
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
        intensity = (percentiles["zomma"] + percentiles["color"]) / 2
        pressure_magnitude = (percentiles["speed"] + percentiles["gamma"]) / 2
        gamma_active = abs(inputs["gamma"]) > self.zero_tolerance
        aligned_up = inputs["speed"] > self.zero_tolerance and gamma_active
        aligned_down = inputs["speed"] < -self.zero_tolerance and gamma_active
        pressure = pressure_magnitude if aligned_up else -pressure_magnitude if aligned_down else 0.0
        warmed = len(samples) >= self.minimum_history
        qualified = warmed and intensity >= self.intensity_threshold and (aligned_up or aligned_down)
        decision = Direction.UP if qualified and aligned_up else Direction.DOWN if qualified and aligned_down else Direction.NEUTRAL
        contributions = {
            "zomma": .5 * percentiles["zomma"], "color": .5 * percentiles["color"],
            "speed": .5 * percentiles["speed"] * (1 if aligned_up else -1 if aligned_down else 0),
            "gamma": .5 * percentiles["gamma"],
        }
        ideal_ranges = {
            "zomma":"combines with Color for intensity >= 0.65",
            "color":"combines with Zomma for intensity >= 0.65",
            "speed":"non-zero and signed with the call direction",
            "gamma":"non-zero curvature base; magnitude strengthens pressure",
        }
        if not warmed:
            explanation=f"Building a relative baseline: {len(samples)}/{self.minimum_history} observations."
        elif not gamma_active or abs(inputs["speed"])<=self.zero_tolerance:
            explanation="Gamma or Speed is effectively zero, so signed curvature pressure is not confirmed."
        elif intensity<self.intensity_threshold:
            explanation="Gamma and Speed align, but Zomma/Color intensity is below its rolling threshold."
        else:
            explanation=f"Speed indicates {'upward' if aligned_up else 'downward'} curvature change while Gamma supplies the base and Zomma/Color confirm intensity."
        return GammaDynamics(
            decision=decision,qualified=qualified,source_symbol=source_symbol,intensity=intensity,
            pressure=pressure,history_points=len(samples),intensity_threshold=self.intensity_threshold,
            inputs=inputs,percentiles=percentiles,normalized=normalized,
            contributions=contributions,ideal_ranges=ideal_ranges,explanation=explanation,
        )
