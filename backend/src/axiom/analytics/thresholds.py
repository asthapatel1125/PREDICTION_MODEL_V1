from __future__ import annotations

import math
from dataclasses import dataclass

from axiom.config.schema import ProfileThresholds
from axiom.domain.enums import Regime


@dataclass(frozen=True)
class PerformanceWindow:
    precision: float = .65
    false_positive_rate: float = .25
    calibration_error: float = .08


class AdaptiveThresholdManager:
    def adapt(self, base: ProfileThresholds, realized_vol_ratio: float, regime: Regime, performance: PerformanceWindow) -> ProfileThresholds:
        regime_delta = {Regime.CALM:-.03,Regime.EXPANSION:0,Regime.GAMMA_UNSTABLE:.10,Regime.HEDGING_ACTIVE:.04,
            Regime.HIGH_VOLATILITY_EVENT:.12,Regime.LOW_LIQUIDITY:.15,Regime.TRENDING:-.02,Regime.CHOPPY:.08}[regime]
        quality_delta = max(-.04,min(.10,(.67-performance.precision)*.20 + performance.calibration_error*.15))
        vol_delta = .04 * math.log(max(.5,min(3.5,realized_vol_ratio)))
        return base.model_copy(update={
            "explosion_min": max(.30,min(.94,base.explosion_min+regime_delta+quality_delta+vol_delta)),
            "direction_min": 3 if regime in {Regime.GAMMA_UNSTABLE,Regime.HIGH_VOLATILITY_EVENT,Regime.LOW_LIQUIDITY} else base.direction_min,
            "confidence_min": max(.50,min(.95,base.confidence_min+quality_delta+regime_delta*.4)),
        })

