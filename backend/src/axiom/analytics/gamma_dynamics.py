from __future__ import annotations

from collections.abc import Sequence

from axiom.domain.enums import Direction
from axiom.domain.models import GammaDynamics, Greeks


class GammaDynamicsQuartet:
    """Classifies relative Gamma dynamics without mixing incompatible Greek units."""

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

    def calculate(self, greeks: Greeks, history: Sequence[Greeks], source_symbol: str) -> GammaDynamics:
        inputs = {name: float(getattr(greeks, name)) for name in ("zomma", "speed", "color", "gamma")}
        samples = list(history)
        percentiles = {name: self._absolute_percentile(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        intensity = (percentiles["zomma"] + percentiles["color"]) / 2
        pressure_magnitude = (percentiles["speed"] + percentiles["gamma"]) / 2
        gamma_active = abs(inputs["gamma"]) > self.zero_tolerance
        aligned_up = inputs["speed"] > self.zero_tolerance and gamma_active
        aligned_down = inputs["speed"] < -self.zero_tolerance and gamma_active
        pressure = pressure_magnitude if aligned_up else -pressure_magnitude if aligned_down else 0.0
        warmed = len(samples) >= self.minimum_history
        qualified = warmed and intensity >= self.intensity_threshold and (aligned_up or aligned_down)
        decision = Direction.UP if qualified and aligned_up else Direction.DOWN if qualified and aligned_down else Direction.NEUTRAL
        if not warmed:
            explanation = f"Building a relative baseline: {len(samples)}/{self.minimum_history} observations."
        elif not gamma_active or abs(inputs["speed"]) <= self.zero_tolerance:
            explanation = "Gamma or Speed is effectively zero, so signed curvature pressure is not confirmed."
        elif intensity < self.intensity_threshold:
            explanation = "Gamma and Speed align, but Zomma/Color intensity is below its rolling threshold."
        else:
            direction = "upward" if aligned_up else "downward"
            explanation = f"Speed indicates {direction} curvature change while active Gamma supplies the curvature base and Zomma/Color show elevated sensitivity."
        return GammaDynamics(
            decision=decision, qualified=qualified, source_symbol=source_symbol, intensity=intensity,
            pressure=pressure, history_points=len(samples), intensity_threshold=self.intensity_threshold,
            inputs=inputs, percentiles=percentiles, explanation=explanation,
        )
