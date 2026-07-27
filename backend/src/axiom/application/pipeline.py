from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Sequence
from datetime import datetime
from uuid import uuid4

import numpy as np

from axiom.analytics.confidence import AlertConfidenceScorer
from axiom.analytics.explanations import AlertExplanationEngine
from axiom.analytics.micro_range import MicroRangeBreakout
from axiom.analytics.profiles import AlertProfileSelector
from axiom.analytics.regime import RegimeClassifier
from axiom.analytics.risk import RiskScorer
from axiom.analytics.scores import DealerHedgingPressure, DirectionScore, ExplosionScore, MomentumConfirmation, PressureScore
from axiom.analytics.signal import TradeSignalGenerator
from axiom.analytics.thresholds import AdaptiveThresholdManager, PerformanceWindow
from axiom.analytics.timeframes import MultiTimeframeEngine
from axiom.config.schema import StrategyConfig
from axiom.domain.enums import Direction, EngineMode
from axiom.domain.models import Alert, GammaDynamics, Greeks, MarketBar, MarketState, MomentumTriad, PipelineResult

try:
    from axiom.analytics.gamma_dynamics import GammaDynamicsQuartet
    from axiom.analytics.momentum_triad import NQMomentumTriad
except ModuleNotFoundError:
    # Backward-compatible single-file implementations for deployments where
    # the optional analytics modules have not been added to GitHub yet.
    class NQMomentumTriad:
        def __init__(self,zero_tolerance:float=1e-12):self.zero_tolerance=zero_tolerance
        def calculate(self,greeks:Greeks,source_symbol:str)->MomentumTriad:
            values={"zomma":float(greeks.zomma),"speed":float(greeks.speed),"delta":float(greeks.delta)}
            votes={name:(1 if value>self.zero_tolerance else -1 if value< -self.zero_tolerance else 0) for name,value in values.items()}
            long=all(value==1 for value in votes.values());short=all(value==-1 for value in votes.values())
            decision=Direction.UP if long else Direction.DOWN if short else Direction.NEUTRAL
            explanation=("Zomma acceleration, Speed direction, and Delta confirmation are all positive." if long else
                "Zomma acceleration, Speed direction, and Delta confirmation are all negative." if short else
                "Zomma acceleration, Speed direction, and Delta confirmation are not aligned.")
            return MomentumTriad(decision=decision,aligned=long or short,source_symbol=source_symbol,
                acceleration=values["zomma"],direction=values["speed"],confirmation=values["delta"],votes=votes,explanation=explanation)

    class GammaDynamicsQuartet:
        def __init__(self,intensity_threshold:float=.65,minimum_history:int=20,zero_tolerance:float=1e-12):
            self.intensity_threshold=intensity_threshold;self.minimum_history=minimum_history;self.zero_tolerance=zero_tolerance
        @staticmethod
        def _percentile(current:float,values:Sequence[float])->float:
            samples=[abs(float(value)) for value in values]
            if not samples:return 0.0
            target=abs(float(current));return min(1.0,max(0.0,(sum(value<target for value in samples)+.5*sum(value==target for value in samples))/len(samples)))
        def calculate(self,greeks:Greeks,history:Sequence[Greeks],source_symbol:str)->GammaDynamics:
            inputs={name:float(getattr(greeks,name)) for name in ("zomma","speed","color","gamma")}
            percentiles={name:self._percentile(value,[getattr(item,name) for item in history]) for name,value in inputs.items()}
            intensity=(percentiles["zomma"]+percentiles["color"])/2;pressure_magnitude=(percentiles["speed"]+percentiles["gamma"])/2
            gamma_active=abs(inputs["gamma"])>self.zero_tolerance
            up=inputs["speed"]>self.zero_tolerance and gamma_active
            down=inputs["speed"]< -self.zero_tolerance and gamma_active
            warmed=len(history)>=self.minimum_history;qualified=warmed and intensity>=self.intensity_threshold and (up or down)
            decision=Direction.UP if qualified and up else Direction.DOWN if qualified and down else Direction.NEUTRAL
            pressure=pressure_magnitude if up else -pressure_magnitude if down else 0.0
            explanation=(f"Building a relative baseline: {len(history)}/{self.minimum_history} observations." if not warmed else
                "Gamma or Speed is effectively zero, so signed curvature pressure is not confirmed." if not (up or down) else
                "Gamma and Speed align, but Zomma/Color intensity is below its rolling threshold." if intensity<self.intensity_threshold else
                f"Speed indicates {'upward' if up else 'downward'} curvature change while active Gamma supplies the curvature base and Zomma/Color show elevated sensitivity.")
            return GammaDynamics(decision=decision,qualified=qualified,source_symbol=source_symbol,intensity=intensity,
                pressure=pressure,history_points=len(history),intensity_threshold=self.intensity_threshold,
                inputs=inputs,percentiles=percentiles,explanation=explanation)


class DecisionPipeline:
    """The single decision path used by both historical replay and live processing."""

    def __init__(self,config:StrategyConfig,market_timezone:str="America/New_York"):
        self.config=config; self.mtf=MultiTimeframeEngine(config.timeframes_seconds)
        self.explosion=ExplosionScore(config.score_weights["explosion"]); self.direction=DirectionScore()
        self.pressure=PressureScore(); self.hedging=DealerHedgingPressure(); self.momentum=MomentumConfirmation()
        self.regimes=RegimeClassifier(config); self.ranges=MicroRangeBreakout(); self.risk=RiskScorer(config)
        self.confidence=AlertConfidenceScorer(config.score_weights["confidence"]); self.thresholds=AdaptiveThresholdManager()
        self.profiles=AlertProfileSelector(market_timezone); self.signal=TradeSignalGenerator(); self.explanations=AlertExplanationEngine()
        self.momentum_triad=NQMomentumTriad()
        self.gamma_dynamics=GammaDynamicsQuartet()
        self._explosions:dict[str,deque]=defaultdict(lambda:deque(maxlen=1000)); self._performance=PerformanceWindow(); self._events:list[datetime]=[]

    def set_events(self,events:list[datetime])->None:self._events=events
    def set_performance(self,performance:PerformanceWindow)->None:self._performance=performance

    def process(self,bar:MarketBar,mode:EngineMode)->PipelineResult:
        started=time.perf_counter(); completed=self.mtf.update(bar); primary=completed.get(self.config.primary_timeframe_seconds)
        if primary is None: primary=bar
        history=self.mtf.bars(bar.symbol,self.config.primary_timeframe_seconds)
        sample=history[-self.config.score_history:]
        explosion=self.explosion.calculate(primary,sample); direction=self.direction.calculate(primary,sample)
        pressure=self.pressure.calculate(primary,sample); hedging=self.hedging.calculate(primary,sample); momentum=self.momentum.calculate(primary,sample)
        self._explosions[bar.symbol].append(explosion)
        returns=np.diff(np.log([b.close for b in sample[-30:]])) if len(sample)>2 else np.array([0.])
        vol_ratio=float(np.std(returns[-5:])/max(np.std(returns),1e-9))
        regime,regime_confidence,_=self.regimes.classify(sample,list(self._explosions[bar.symbol]))
        profile=self.profiles.select(bar.timestamp,self._events,vol_ratio); base=self.config.profiles[profile.value]
        dynamic=self.thresholds.adapt(base,vol_ratio,regime,self._performance)
        micro=self.ranges.calculate(sample+[primary],dynamic.micro_range_minutes)
        alignment=self.mtf.alignment(bar.symbol); risk=self.risk.calculate(primary,sample)
        confidence=self.confidence.calculate(explosion,direction,pressure,momentum,alignment)
        momentum_triad=self.momentum_triad.calculate(primary.greeks,bar.symbol)
        gamma_dynamics=self.gamma_dynamics.calculate(primary.greeks,[item.greeks for item in sample],bar.symbol)
        state=MarketState(timestamp=bar.timestamp,symbol=bar.symbol,regime=regime,profile=profile,explosion=explosion,direction=direction,
            pressure=pressure,dealer_hedging=hedging,momentum=momentum,confidence=confidence,risk=risk,micro_range=micro,
            timeframe_alignment=alignment,greeks=primary.greeks,momentum_triad=momentum_triad,gamma_dynamics=gamma_dynamics,supporting_indicators={"price":primary.close,"realized_vol_ratio":vol_ratio,"regime_confidence":regime_confidence,"spread":bar.bid_ask_spread,"volume":bar.volume,
                "contract_count":float(bar.contract_count),"open_interest_total":bar.open_interest,
                **{f"greek_{name}":float(getattr(primary.greeks,name)) for name in primary.greeks.model_fields}})
        fire,expected,failed=self.signal.should_alert(state,dynamic)
        options_confidence=self.signal.options_confidence(state)
        check_names=("explosion","direction","pressure_alignment","confidence","risk")
        state=state.model_copy(update={"signal_checks":{name:name not in failed for name in check_names},
            "supporting_indicators":{**state.supporting_indicators,"options_confidence":options_confidence},
            "active_thresholds":{"explosion_min":dynamic.explosion_min,"direction_min":float(dynamic.direction_min),
                "pressure_min":self.signal.pressure_min,"confidence_min":dynamic.confidence_min,"risk_max":.88},
            "options_bias":expected,"options_bias_qualified":fire})
        alert=None
        if fire:
            reasons,action,risk_level=self.explanations.explain(state,expected)
            expected_move=max(primary.close*(float(np.std(returns)) if len(returns) else .0001)*dynamic.expected_move_vol_multiple,primary.close*.0001)
            alert_indicators={**state.supporting_indicators,"pressure_score":pressure.value,
                "explosion_confidence":explosion.confidence,"direction_confidence":direction.confidence,
                "price_confirmation_required":1.0}
            alert=Alert(id=uuid4(),timestamp=bar.timestamp,symbol=bar.symbol,engine_mode=mode,direction=expected,confidence=options_confidence,
                explosion_score=explosion.value,direction_score=int(direction.value),regime=regime,profile=profile,micro_range=micro,reasoning=reasons,
                supporting_indicators=alert_indicators,recommended_action=action,risk_level=risk_level,price=primary.close,
                expected_move=expected_move,entry_price=None,invalidation_price=None,target_price=None,config_version=self.config.version)
        return PipelineResult(state=state,alert=alert,processing_latency_ms=(time.perf_counter()-started)*1000)
