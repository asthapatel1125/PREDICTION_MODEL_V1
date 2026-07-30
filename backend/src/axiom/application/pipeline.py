from __future__ import annotations

import json
import time
from collections import defaultdict, deque
from collections.abc import Sequence
from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

import numpy as np

from axiom.analytics.confidence import AlertConfidenceScorer
from axiom.analytics.explanations import AlertExplanationEngine
from axiom.analytics.micro_range import MicroRangeBreakout
from axiom.analytics.profiles import AlertProfileSelector
from axiom.analytics.regime import RegimeClassifier
from axiom.analytics.risk import RiskScorer
from axiom.analytics.scores import DealerHedgingPressure, DirectionScore, ExplosionScore, MomentumConfirmation, PressureScore
from axiom.analytics.session_classifier import IntradaySessionClassifier
from axiom.analytics.signal import TradeSignalGenerator
from axiom.analytics.thresholds import AdaptiveThresholdManager, PerformanceWindow
from axiom.analytics.timeframes import MultiTimeframeEngine
from axiom.analytics.zone_intelligence import ZoneIntelligenceEngine
from axiom.config.schema import StrategyConfig
from axiom.domain.enums import Direction, EngineMode
from axiom.domain.models import Alert, GammaDynamics, Greeks, MarketBar, MarketState, PipelineResult, ScoreResult

try:
    from axiom.analytics.gamma_dynamics import GammaDynamicsQuartet
except ModuleNotFoundError:
    # Backward-compatible single-file implementations for deployments where
    # the optional analytics modules have not been added to GitHub yet.
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
        self.gamma_dynamics=GammaDynamicsQuartet()
        self.zone_intelligence=ZoneIntelligenceEngine(market_timezone=market_timezone)
        self.sessions=IntradaySessionClassifier(config.session_model,market_timezone)
        self._explosions:dict[str,deque]=defaultdict(lambda:deque(maxlen=1000)); self._performance=PerformanceWindow(); self._events:list[datetime]=[]
        self._signal_episodes:dict[str,dict]=defaultdict(lambda:{
            "direction":Direction.NEUTRAL,"candidate":Direction.NEUTRAL,
            "candidate_count":0,"exit_count":0,"activated_at":None,
        })
        self.signal_entry_confirmations=3
        self.signal_exit_confirmations=3
        self.signal_min_hold_seconds=60

    def set_events(self,events:list[datetime])->None:self._events=events
    def set_performance(self,performance:PerformanceWindow)->None:self._performance=performance

    @staticmethod
    def _display_id(timestamp:datetime,stream:int=0)->str:
        eastern=timestamp.astimezone(ZoneInfo("America/New_York"))
        return f"{eastern:%Y%m%d%H%M%S}{eastern.microsecond//1000:03d}{stream:02d}"

    def _update_signal_episode(self,symbol:str,timestamp:datetime,raw_qualified:bool,
        raw_direction:Direction)->tuple[Direction,bool,bool,dict]:
        """Debounce entries and apply hysteresis so the displayed bias is stable."""
        episode=self._signal_episodes[symbol]
        active=episode["direction"]
        entered=False
        if active==Direction.NEUTRAL:
            episode["exit_count"]=0
            if raw_qualified and raw_direction!=Direction.NEUTRAL:
                if episode["candidate"]==raw_direction:episode["candidate_count"]+=1
                else:
                    episode["candidate"]=raw_direction
                    episode["candidate_count"]=1
                if episode["candidate_count"]>=self.signal_entry_confirmations:
                    active=raw_direction
                    episode.update(direction=active,candidate=Direction.NEUTRAL,
                        candidate_count=0,exit_count=0,activated_at=timestamp)
                    entered=True
            else:
                episode.update(candidate=Direction.NEUTRAL,candidate_count=0)
        else:
            activated_at=episode["activated_at"] or timestamp
            age=max(0.0,(timestamp-activated_at).total_seconds())
            if raw_qualified and raw_direction==active:
                episode.update(candidate=Direction.NEUTRAL,candidate_count=0,exit_count=0)
            elif age<self.signal_min_hold_seconds:
                episode.update(candidate=Direction.NEUTRAL,candidate_count=0,exit_count=0)
            elif raw_qualified and raw_direction not in (Direction.NEUTRAL,active):
                episode["exit_count"]=0
                if episode["candidate"]==raw_direction:episode["candidate_count"]+=1
                else:
                    episode["candidate"]=raw_direction
                    episode["candidate_count"]=1
                if episode["candidate_count"]>=self.signal_entry_confirmations:
                    active=raw_direction
                    episode.update(direction=active,candidate=Direction.NEUTRAL,
                        candidate_count=0,exit_count=0,activated_at=timestamp)
                    entered=True
            else:
                episode.update(candidate=Direction.NEUTRAL,candidate_count=0)
                episode["exit_count"]+=1
                if episode["exit_count"]>=self.signal_exit_confirmations:
                    active=Direction.NEUTRAL
                    episode.update(direction=active,exit_count=0,activated_at=None)
        active=episode["direction"]
        activated_at=episode["activated_at"]
        age=max(0.0,(timestamp-activated_at).total_seconds()) if activated_at else 0.0
        raw_aligned=raw_qualified and raw_direction==active and active!=Direction.NEUTRAL
        lifecycle=("CONFIRMING" if active==Direction.NEUTRAL and episode["candidate_count"] else
            "ACTIVE" if raw_aligned else "MINIMUM_HOLD" if active!=Direction.NEUTRAL and age<self.signal_min_hold_seconds else
            "REVERSAL_PENDING" if episode["candidate_count"] else
            "EXIT_PENDING" if active!=Direction.NEUTRAL and episode["exit_count"] else "WAIT")
        details={"signal_lifecycle":lifecycle,"signal_age_seconds":age,
            "signal_entry_progress":episode["candidate_count"],
            "signal_entry_required":self.signal_entry_confirmations,
            "signal_exit_progress":episode["exit_count"],
            "signal_exit_required":self.signal_exit_confirmations,
            "signal_min_hold_seconds":self.signal_min_hold_seconds,
            "signal_raw_qualified":raw_qualified,
            "signal_raw_direction":raw_direction.value}
        return active,active!=Direction.NEUTRAL,entered,details

    def process(self,bar:MarketBar,mode:EngineMode)->PipelineResult:
        started=time.perf_counter(); completed=self.mtf.update(bar); primary=completed.get(self.config.primary_timeframe_seconds)
        if primary is None: primary=bar
        history=self.mtf.bars(bar.symbol,self.config.primary_timeframe_seconds)
        sample=history[-self.config.score_history:]
        session_analysis=self.sessions.calculate(primary,sample)
        explosion=self.explosion.calculate(primary,sample)
        session_direction_value=(3*float(session_analysis["active_greek_score"])
            if session_analysis["directional_qualified"] else 0.0)
        direction=ScoreResult(name="direction",value=session_direction_value,
            confidence=min(1.0,float(session_analysis["transition_confidence"])/100),
            inputs={name:float(getattr(primary.greeks,name)) for name in ("gamma","vanna","charm")},
            configuration={"range":[-3,3],"model":"ACTIVE_SESSION_ALERT",
                "session":session_analysis["detected_session"],
                "weights":session_analysis["active_alert_weights"],
                "effective_directional_weights":session_analysis["effective_directional_weights"],
                "initial_hypothesis":True},
            explanation=(f"{session_analysis['detected_session'].replace('_',' ').title()} weighted Greek score "
                f"{session_direction_value:+.2f}/3; two-Greek agreement and price confirmation are "
                f"{'present' if session_analysis['directional_qualified'] else 'not both present'}."),
            components={name:float(value) for name,value in session_analysis["directional_votes"].items()})
        pressure=self.pressure.calculate(primary,sample,session_analysis["effective_directional_weights"])
        hedging=self.hedging.calculate(primary,sample); momentum=self.momentum.calculate(primary,sample)
        self._explosions[bar.symbol].append(explosion)
        returns=np.diff(np.log([b.close for b in sample[-30:]])) if len(sample)>2 else np.array([0.])
        vol_ratio=float(np.std(returns[-5:])/max(np.std(returns),1e-9))
        regime,regime_confidence,_=self.regimes.classify(sample,list(self._explosions[bar.symbol]))
        profile=self.profiles.select(bar.timestamp,self._events,vol_ratio); base=self.config.profiles[profile.value]
        dynamic=self.thresholds.adapt(base,vol_ratio,regime,self._performance)
        micro=self.ranges.calculate(sample+[primary],dynamic.micro_range_minutes)
        alignment=self.mtf.alignment(bar.symbol); risk=self.risk.calculate(primary,sample)
        confidence=self.confidence.calculate(explosion,direction,pressure,momentum,alignment)
        gamma_dynamics=self.gamma_dynamics.calculate(primary.greeks,[item.greeks for item in sample],bar.symbol)
        zone_intelligence=self.zone_intelligence.calculate(primary.greeks,[item.greeks for item in sample],bar.timestamp,bar.symbol)
        state=MarketState(timestamp=bar.timestamp,symbol=bar.symbol,regime=regime,profile=profile,explosion=explosion,direction=direction,
            pressure=pressure,dealer_hedging=hedging,momentum=momentum,confidence=confidence,risk=risk,micro_range=micro,
            timeframe_alignment=alignment,greeks=primary.greeks,gamma_dynamics=gamma_dynamics,zone_intelligence=zone_intelligence,
            session_analysis=session_analysis,supporting_indicators={"price":primary.close,"realized_vol_ratio":vol_ratio,"regime_confidence":regime_confidence,"spread":bar.bid_ask_spread,"volume":bar.volume,
                "contract_count":float(bar.contract_count),"open_interest_total":bar.open_interest,
                "clock_session":session_analysis["clock_session"],
                "detected_session":session_analysis["detected_session"],
                "session_state":session_analysis["session_state"],
                "transition_confidence":float(session_analysis["transition_confidence"]),
                "active_greek_score":float(session_analysis["active_greek_score"]),
                "session_gamma_weight":float(session_analysis["active_alert_weights"].get("gamma",0)),
                "session_vanna_weight":float(session_analysis["active_alert_weights"].get("vanna",0)),
                "session_charm_weight":float(session_analysis["active_alert_weights"].get("charm",0)),
                "session_weight_status":session_analysis["weight_status"],
                "session_alerts":json.dumps(session_analysis["alerts"]),
                **{f"greek_{name}":float(getattr(primary.greeks,name)) for name in primary.greeks.model_fields}})
        fire,expected,failed=self.signal.should_alert(state,dynamic)
        options_confidence=self.signal.options_confidence(state)
        active_direction,episode_qualified,entered,episode_details=self._update_signal_episode(
            bar.symbol,bar.timestamp,fire,expected
        )
        check_names=("explosion","direction","pressure_alignment","confidence","risk")
        state=state.model_copy(update={"signal_checks":{name:name not in failed for name in check_names},
            "supporting_indicators":{**state.supporting_indicators,"options_confidence":options_confidence,**episode_details},
            "active_thresholds":{"explosion_min":dynamic.explosion_min,"direction_min":float(dynamic.direction_min),
                "pressure_min":self.signal.pressure_min,"confidence_min":dynamic.confidence_min,"risk_max":.88},
            "options_bias":active_direction,"options_bias_qualified":episode_qualified})
        alert=None
        if entered:
            reasons,action,risk_level=self.explanations.explain(state,active_direction)
            reasons=[*reasons,*session_analysis["explanation"][-2:]]
            expected_move=max(primary.close*(float(np.std(returns)) if len(returns) else .0001)*dynamic.expected_move_vol_multiple,primary.close*.0001)
            alert_indicators={**state.supporting_indicators,"pressure_score":pressure.value,
                "explosion_confidence":explosion.confidence,"direction_confidence":direction.confidence,
                "price_confirmation_required":1.0}
            alert=Alert(id=uuid4(),display_id=self._display_id(bar.timestamp),timestamp=bar.timestamp,symbol=bar.symbol,engine_mode=mode,direction=active_direction,confidence=options_confidence,
                explosion_score=explosion.value,direction_score=int(direction.value),regime=regime,profile=profile,micro_range=micro,reasoning=reasons,
                supporting_indicators=alert_indicators,recommended_action=action,risk_level=risk_level,price=primary.close,
                expected_move=expected_move,entry_price=None,invalidation_price=None,target_price=None,config_version=self.config.version)
        return PipelineResult(state=state,alert=alert,processing_latency_ms=(time.perf_counter()-started)*1000)
