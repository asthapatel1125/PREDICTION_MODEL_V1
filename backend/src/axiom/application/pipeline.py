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
from axiom.domain.enums import EngineMode
from axiom.domain.models import Alert, MarketBar, MarketState, PipelineResult


class DecisionPipeline:
    """The single decision path used by both historical replay and live processing."""

    def __init__(self,config:StrategyConfig,market_timezone:str="America/New_York"):
        self.config=config; self.mtf=MultiTimeframeEngine(config.timeframes_seconds)
        self.explosion=ExplosionScore(config.score_weights["explosion"]); self.direction=DirectionScore()
        self.pressure=PressureScore(); self.hedging=DealerHedgingPressure(); self.momentum=MomentumConfirmation()
        self.regimes=RegimeClassifier(config); self.ranges=MicroRangeBreakout(); self.risk=RiskScorer(config)
        self.confidence=AlertConfidenceScorer(config.score_weights["confidence"]); self.thresholds=AdaptiveThresholdManager()
        self.profiles=AlertProfileSelector(market_timezone); self.signal=TradeSignalGenerator(); self.explanations=AlertExplanationEngine()
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
        state=MarketState(timestamp=bar.timestamp,symbol=bar.symbol,regime=regime,profile=profile,explosion=explosion,direction=direction,
            pressure=pressure,dealer_hedging=hedging,momentum=momentum,confidence=confidence,risk=risk,micro_range=micro,
            timeframe_alignment=alignment,supporting_indicators={"realized_vol_ratio":vol_ratio,"regime_confidence":regime_confidence,"spread":bar.bid_ask_spread,"volume":bar.volume})
        fire,expected,_=self.signal.should_alert(state,dynamic); alert=None
        if fire:
            reasons,action,risk_level=self.explanations.explain(state,expected)
            expected_move=max(primary.close*(float(np.std(returns)) if len(returns) else .0001)*dynamic.expected_move_vol_multiple,primary.close*.0001)
            alert=Alert(id=uuid4(),timestamp=bar.timestamp,symbol=bar.symbol,engine_mode=mode,direction=expected,confidence=confidence.value,
                explosion_score=explosion.value,direction_score=int(direction.value),regime=regime,profile=profile,micro_range=micro,reasoning=reasons,
                supporting_indicators=state.supporting_indicators,recommended_action=action,risk_level=risk_level,price=primary.close,
                expected_move=expected_move,config_version=self.config.version)
        return PipelineResult(state=state,alert=alert,processing_latency_ms=(time.perf_counter()-started)*1000)

