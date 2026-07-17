from __future__ import annotations

from collections import Counter
from collections.abc import Sequence

import numpy as np

from axiom.config.schema import StrategyConfig
from axiom.domain.enums import Regime
from axiom.domain.models import MarketBar, ScoreResult


class RegimeClassifier:
    def __init__(self, config: StrategyConfig): self.config = config

    def classify(self, bars: Sequence[MarketBar], explosions: Sequence[ScoreResult]) -> tuple[Regime, float, str]:
        if len(bars) < 8: return Regime.CALM, 0.4, "Insufficient history; conservative CALM state."
        recent = bars[-20:]; exp = np.asarray([s.value for s in explosions[-8:]], dtype=float)
        gamma = np.asarray([b.greeks.gamma for b in recent]); returns = np.diff(np.log([b.close for b in recent]))
        spreads = np.asarray([b.bid_ask_spread for b in recent]); volumes = np.asarray([b.volume for b in recent])
        sign_flips = int(np.sum(np.abs(np.diff(np.sign(gamma))) == 2)); gamma_cv = float(np.std(gamma) / max(np.median(np.abs(gamma)), 1e-9))
        vol_ratio = float(np.std(returns[-5:]) / max(np.std(returns), 1e-9)); spread_ratio = float(spreads[-1] / max(np.median(spreads), 1e-9)); volume_ratio = float(volumes[-1] / max(np.median(volumes), 1e-9))
        efficiency = abs(recent[-1].close - recent[0].close) / max(sum(abs(b.close-a.close) for a,b in zip(recent,recent[1:])),1e-9)
        hedging = np.mean([abs(recent[-1].greeks.charm), abs(recent[-1].greeks.vanna), abs(recent[-1].greeks.color)]) / max(np.median([np.mean([abs(b.greeks.charm),abs(b.greeks.vanna),abs(b.greeks.color)]) for b in recent]),1e-9)
        candidates: list[tuple[Regime, float, str]] = []
        if vol_ratio >= 2.5: candidates.append((Regime.HIGH_VOLATILITY_EVENT, clamp01(vol_ratio/4), f"Volatility shock {vol_ratio:.2f}x."))
        if spread_ratio >= 2 and volume_ratio <= .35: candidates.append((Regime.LOW_LIQUIDITY, clamp01(spread_ratio/3), "Spread widened while volume collapsed."))
        if sign_flips >= 2 or gamma_cv >= 1.7: candidates.append((Regime.GAMMA_UNSTABLE, clamp01(gamma_cv/3), f"Gamma instability {gamma_cv:.2f}; {sign_flips} sign flips."))
        if hedging >= 1.3: candidates.append((Regime.HEDGING_ACTIVE, clamp01(hedging/2), f"Hedging Greeks {hedging:.2f}x baseline."))
        if len(exp) and (exp[-1] >= .58 or np.mean(np.diff(exp[-4:])) >= .02): candidates.append((Regime.EXPANSION, clamp01(exp[-1]), "ExplosionScore elevated or rising."))
        if efficiency >= .68: candidates.append((Regime.TRENDING, clamp01(efficiency), f"Path efficiency {efficiency:.0%}."))
        if efficiency <= .28 and vol_ratio > .8: candidates.append((Regime.CHOPPY, clamp01(1-efficiency), f"Low path efficiency {efficiency:.0%}."))
        return max(candidates, key=lambda x: x[1]) if candidates else (Regime.CALM, clamp01(1-float(exp[-1]) if len(exp) else .5), "Pressure remains below expansion thresholds.")


def clamp01(value: float) -> float: return max(0.0, min(1.0, value))
