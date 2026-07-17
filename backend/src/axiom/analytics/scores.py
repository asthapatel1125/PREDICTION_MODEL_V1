from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from axiom.domain.models import MarketBar, ScoreResult

from .base import AnalyticsModule, clamp, robust_intensity


class ExplosionScore(AnalyticsModule):
    def __init__(self, weights: dict[str, float]):
        if not math.isclose(sum(weights.values()), 1.0, abs_tol=1e-6):
            raise ValueError("ExplosionScore weights must total 1.0")
        self.weights = weights

    def calculate(self, current: MarketBar, history: Sequence[MarketBar]) -> ScoreResult:
        components = {
            name: robust_intensity(getattr(current.greeks, name), [getattr(b.greeks, name) for b in history])
            for name in self.weights
        }
        acceleration = np.mean([
            abs(getattr(current.greeks, name)) / max(np.median([abs(getattr(b.greeks, name)) for b in history[-50:]]), 1e-9)
            for name in ("ultima", "color", "speed", "zomma")
        ]) if history else 1.0
        value = clamp(sum(self.weights[n] * components[n] for n in self.weights) + 0.08 * math.tanh(max(0.0, acceleration - 1)))
        return ScoreResult(name="explosion", value=value, confidence=clamp(len(history) / 100),
            inputs={n: getattr(current.greeks, n) for n in self.weights}, configuration={"weights": self.weights},
            explanation=f"Volatility-curvature energy is {value:.1%}; acceleration ratio {acceleration:.2f}x.", components=components)


class DirectionScore(AnalyticsModule):
    names = ("gamma", "vanna", "charm")

    def calculate(self, current: MarketBar, history: Sequence[MarketBar]) -> ScoreResult:
        values = {n: getattr(current.greeks, n) for n in self.names}
        signs = {n: int(v > 0) - int(v < 0) for n, v in values.items()}
        raw = sum(signs.values())
        clarity = 1.0 if raw in (-3, 3) else abs(raw) / 3
        stability = np.mean([sum((int(getattr(b.greeks, n) > 0) - int(getattr(b.greeks, n) < 0)) for n in self.names) == raw for b in history[-8:]]) if history else 0.0
        return ScoreResult(name="direction", value=float(raw), confidence=clamp(0.65 * clarity + 0.35 * stability),
            inputs=values, configuration={"range": [-3, 3], "clarity_requires_same_sign": True},
            explanation=f"Gamma, Vanna and Charm produce {raw:+d}; sign stability is {stability:.0%}.", components={k: float(v) for k, v in signs.items()})


class PressureScore(AnalyticsModule):
    def calculate(self, current: MarketBar, history: Sequence[MarketBar]) -> ScoreResult:
        g = current.greeks
        directional = np.mean([np.sign(g.gamma), np.sign(g.vanna), np.sign(g.charm)])
        curvature = np.mean([abs(g.speed), abs(g.zomma), abs(g.color), abs(g.ultima)])
        baseline = np.median([np.mean([abs(b.greeks.speed), abs(b.greeks.zomma), abs(b.greeks.color), abs(b.greeks.ultima)]) for b in history[-100:]]) if history else 1.0
        ratio = curvature / max(baseline, 1e-9)
        signed = float(np.tanh(ratio - 1) * directional)
        return ScoreResult(name="pressure", value=signed, confidence=clamp(abs(signed)),
            inputs={"curvature": curvature, "baseline": baseline, "directional_alignment": directional},
            configuration={"normalization": "rolling_median"}, explanation=f"Signed dealer pressure is {signed:+.2f} at {ratio:.2f}x baseline.", components={"ratio": ratio})


class DealerHedgingPressure(AnalyticsModule):
    def calculate(self, current: MarketBar, history: Sequence[MarketBar]) -> ScoreResult:
        g = current.greeks
        signed = float(np.tanh(g.gamma + 0.7 * g.charm + 0.6 * g.vanna + 0.35 * g.color))
        agreement = abs(np.mean([np.sign(g.gamma), np.sign(g.charm), np.sign(g.vanna)]))
        return ScoreResult(name="dealer_hedging", value=signed, confidence=clamp(agreement),
            inputs={"gamma": g.gamma, "charm": g.charm, "vanna": g.vanna, "color": g.color},
            configuration={"gamma": 1.0, "charm": 0.7, "vanna": 0.6, "color": 0.35},
            explanation=f"Estimated signed hedge demand is {signed:+.2f} with {agreement:.0%} agreement.")


class MomentumConfirmation(AnalyticsModule):
    def calculate(self, current: MarketBar, history: Sequence[MarketBar]) -> ScoreResult:
        closes = [b.close for b in history[-12:]] + [current.close]
        if len(closes) < 3:
            slope, efficiency = 0.0, 0.0
        else:
            slope = (closes[-1] - closes[0]) / closes[0]
            path = sum(abs(b - a) for a, b in zip(closes, closes[1:]))
            efficiency = abs(closes[-1] - closes[0]) / max(path, 1e-9)
        signed = float(np.sign(slope) * efficiency)
        return ScoreResult(name="momentum", value=signed, confidence=clamp(efficiency), inputs={"return": slope, "efficiency": efficiency},
            configuration={"lookback_bars": 12}, explanation=f"Price confirmation efficiency is {efficiency:.0%}; price remains confirmatory, not causal.")

