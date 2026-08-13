from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime,timezone

try:
    from axiom.adapters.twelvedata import TwelveDataPriceClient
except ModuleNotFoundError:
    class TwelveDataPriceClient:
        def __init__(self,api_key:str|None,timeout_seconds:float=10):self.api_key=api_key
        @property
        def enabled(self)->bool:return False
        async def latest(self,symbol:str):return None

try:
    from axiom.analytics.outcome_attribution import OutcomeAttributionTracker
except ModuleNotFoundError:
    class OutcomeAttributionTracker:
        """No-op compatibility layer until optional attribution files are deployed."""
        def __init__(self,horizon_minutes:int=30,cooldown_seconds:int=300):pass
        def process(self,*args,**kwargs)->list[dict]:return []
        def finalize_active(self,*args,**kwargs)->list[dict]:return []
from axiom.application.pipeline import DecisionPipeline
from axiom.domain.enums import Direction,EngineMode
from axiom.domain.models import Outcome,PipelineResult
from axiom.ports.interfaces import EventPublisherPort, MarketDataPort, RepositoryPort


def _event_json(value):
    if isinstance(value,datetime):return value.isoformat()
    if isinstance(value,dict):return {key:_event_json(item) for key,item in value.items()}
    if isinstance(value,(list,tuple)):return [_event_json(item) for item in value]
    return value


@dataclass(frozen=True)
class ReplayRequest:
    symbol:str; start:datetime; end:datetime; bar_resolution_seconds:int; replay_speed:float=0


class _EngineRunner:
    def __init__(self,pipeline:DecisionPipeline,repository:RepositoryPort,publisher:EventPublisherPort,
        outcome_horizon_minutes:int=60,outcome_signal_cooldown_seconds:int=300,
        outcome_qqq_points_per_50_nq:float=1.235):
        self.pipeline=pipeline;self.repository=repository;self.publisher=publisher;self._stop=asyncio.Event();self._pending=[]
        self.attribution=OutcomeAttributionTracker(
            outcome_horizon_minutes,outcome_signal_cooldown_seconds,outcome_qqq_points_per_50_nq
        )

    async def handle(self,bar,mode:EngineMode,price_observation:dict|None=None)->PipelineResult:
        result=self.pipeline.process(bar,mode); await self.repository.save_state(result.state)
        # Raw per-contract chain persistence was removed with Daily
        # Microstructure. The live models use compact aggregate chain metrics.
        if hasattr(self.repository,"save_confluence"):
            await self.repository.save_confluence(result.state)
        # Daily microstructure is intentionally built off-process/on demand.
        # Loading an entire day of raw five-second chains into the live worker
        # creates a predictable out-of-memory path on small Render instances.
        await self.publisher.publish("market_state",result.state.model_dump(mode="json"))
        observation=price_observation or {"price":bar.close,"source":"THETADATA_REPLAY" if mode==EngineMode.TRAINING else "THETADATA_OPTIONS_UNDERLYING",
            "observed_at":datetime.now(timezone.utc),"source_timestamp":bar.timestamp}
        records=self.attribution.process(result.state,mode,float(observation["price"]),str(observation["source"]),
            observation["observed_at"],observation.get("source_timestamp"))
        for record in records:
            if hasattr(self.repository,"save_system_outcome"):await self.repository.save_system_outcome(record)
            await self.publisher.publish("system_outcome",_event_json(record))
        remaining=[]
        for alert,bars_left in self._pending:
            if bars_left>1:remaining.append((alert,bars_left-1));continue
            actual=bar.close-alert.price;correct=(alert.direction==Direction.UP and actual>0) or (alert.direction==Direction.DOWN and actual<0)
            magnitude=min(abs(actual)/max(alert.expected_move,1e-9),1.0) if correct else 0.0
            direction_accuracy=1.0 if correct else 0.0;timing_accuracy=1.0 if correct and magnitude>=.5 else .5 if correct else 0.0
            precision=.65*direction_accuracy+.25*magnitude+.10*timing_accuracy
            outcome=Outcome(alert_id=alert.id,evaluated_at=bar.timestamp,direction_accuracy=direction_accuracy,magnitude_accuracy=magnitude,
                timing_accuracy=timing_accuracy,precision=precision,actual_move=actual,lead_time_seconds=max(0,(bar.timestamp-alert.timestamp).total_seconds()),
                false_positive_reason=None if correct else "Direction reversed during the evaluation horizon",
                recommendation="Retain signal" if precision>=.7 else "Review threshold and regime filter")
            await self.repository.save_outcome(outcome);await self.publisher.publish("outcome",outcome.model_dump(mode="json"))
        self._pending=remaining
        if result.alert:
            await self.repository.save_alert(result.alert);await self.publisher.publish("alert",result.alert.model_dump(mode="json"))
            self._pending.append((result.alert,self.pipeline.config.evaluation_horizon_bars))
        return result

    def stop(self)->None:self._stop.set()

    async def finalize_attribution(self,reason:str)->None:
        records=self.attribution.finalize_active(reason,datetime.now(timezone.utc))
        for record in records:
            if hasattr(self.repository,"save_system_outcome"):await self.repository.save_system_outcome(record)
            await self.publisher.publish("system_outcome",_event_json(record))


class TrainingEngine(_EngineRunner):
    def __init__(self,pipeline:DecisionPipeline,repository:RepositoryPort,publisher:EventPublisherPort,data:MarketDataPort,
        outcome_horizon_minutes:int=60,outcome_signal_cooldown_seconds:int=300,
        outcome_qqq_points_per_50_nq:float=1.235):
        super().__init__(pipeline,repository,publisher,outcome_horizon_minutes,
            outcome_signal_cooldown_seconds,outcome_qqq_points_per_50_nq);self.data=data

    async def replay(self,request:ReplayRequest)->dict[str,float]:
        count=alerts=0;latency=0.0;previous=None
        async for bar in self.data.historical_bars(request.symbol,request.start,request.end,request.bar_resolution_seconds):
            if self._stop.is_set():break
            if request.replay_speed>0 and previous:
                delay=(bar.timestamp-previous).total_seconds()/request.replay_speed
                await asyncio.sleep(max(0,min(delay,2)))
            result=await self.handle(bar,EngineMode.TRAINING);count+=1;alerts+=int(result.alert is not None);latency+=result.processing_latency_ms;previous=bar.timestamp
        return {"bars":count,"alerts":alerts,"average_pipeline_latency_ms":latency/max(count,1)}


class LiveEngine(_EngineRunner):
    def __init__(self,pipeline:DecisionPipeline,repository:RepositoryPort,publisher:EventPublisherPort,data:MarketDataPort,
        price_data:TwelveDataPriceClient|None=None,price_poll_seconds:int=60,outcome_horizon_minutes:int=60,
        outcome_signal_cooldown_seconds:int=300,outcome_qqq_points_per_50_nq:float=1.235):
        super().__init__(pipeline,repository,publisher,outcome_horizon_minutes,
            outcome_signal_cooldown_seconds,outcome_qqq_points_per_50_nq);self.data=data
        self.price_data=price_data;self.price_poll_seconds=price_poll_seconds;self._price_observation=None;self._price_polled_at=None
        self.running=False;self.symbol:str|None=None;self.resolution_seconds=5;self.started_at:datetime|None=None
        self.last_update:datetime|None=None;self.last_error:str|None=None;self.bars_processed=0;self.alerts_generated=0
        self.average_latency_ms=0.0;self.retries=0

    def status(self)->dict[str,object]:
        return {"running":self.running,"symbol":self.symbol,"resolution_seconds":self.resolution_seconds,
            "started_at":self.started_at.isoformat() if self.started_at else None,
            "last_update":self.last_update.isoformat() if self.last_update else None,"last_error":self.last_error,
            "bars_processed":self.bars_processed,"alerts_generated":self.alerts_generated,
            "average_latency_ms":self.average_latency_ms,"retries":self.retries,
            "outcome_price_source":self._price_observation["source"] if self._price_observation else "THETADATA_OPTIONS_UNDERLYING",
            "outcome_price_observed_at":self._price_observation["observed_at"].isoformat() if self._price_observation else None}

    async def _outcome_price(self,bar)->dict:
        now=datetime.now(timezone.utc)
        # The ThetaData live bar closes arrive at the engine cadence (normally
        # every five seconds), which is required to form meaningful one-minute
        # highs and lows. A slower quote API remains a fallback only.
        bar_price=float(bar.close)
        if bar_price>0:
            return {"price":bar_price,"source":"THETADATA_OPTIONS_UNDERLYING",
                "observed_at":now,"source_timestamp":bar.timestamp}
        should_poll=self.price_data and self.price_data.enabled and (
            self._price_polled_at is None or (now-self._price_polled_at).total_seconds()>=self.price_poll_seconds
        )
        if should_poll:
            self._price_polled_at=now
            try:self._price_observation=await self.price_data.latest(bar.symbol)
            except Exception as exc:
                event={"level":"WARNING","component":"twelve_data","message":str(exc),"timestamp":now.isoformat()}
                if hasattr(self.repository,"save_system_event"):await self.repository.save_system_event(event)
                await self.publisher.publish("system_event",event)
        return self._price_observation or {"price":bar.close,"source":"THETADATA_OPTIONS_UNDERLYING",
            "observed_at":now,"source_timestamp":bar.timestamp}

    async def run(self,symbol:str,resolution_seconds:int)->None:
        self._stop.clear();self.running=True;self.symbol=symbol.upper();self.resolution_seconds=resolution_seconds
        self.started_at=datetime.now(timezone.utc);self.last_error=None;self.bars_processed=0;self.alerts_generated=0;self.average_latency_ms=0;self.retries=0
        await self.publisher.publish("engine_status",self.status())
        backoff=1.0
        try:
            while not self._stop.is_set():
                try:
                    async for bar in self.data.live_bars(symbol,resolution_seconds):
                        if self._stop.is_set():return
                        result=await self.handle(bar,EngineMode.LIVE,await self._outcome_price(bar));self.bars_processed+=1
                        self.alerts_generated+=int(result.alert is not None);self.last_update=bar.timestamp;self.last_error=None
                        self.average_latency_ms+=(result.processing_latency_ms-self.average_latency_ms)/self.bars_processed
                        await self.publisher.publish("engine_status",self.status());backoff=1.0
                    if not self._stop.is_set():await self.finalize_attribution("STREAM_INTERRUPTED")
                    backoff=1.0
                except asyncio.CancelledError: raise
                except Exception as exc:
                    self.last_error=str(exc);self.retries+=1
                    await self.finalize_attribution("ENGINE_ERROR")
                    event={"level":"ERROR","component":"live_engine","message":str(exc),"retry_seconds":backoff,"timestamp":datetime.now(timezone.utc).isoformat()}
                    if hasattr(self.repository,"save_system_event"):await self.repository.save_system_event(event)
                    await self.publisher.publish("system_event",event);await self.publisher.publish("engine_status",self.status())
                    await asyncio.sleep(backoff);backoff=min(backoff*2,30)
        finally:
            await self.finalize_attribution("ENGINE_STOPPED" if self._stop.is_set() else "STREAM_INTERRUPTED")
            self.running=False;await self.publisher.publish("engine_status",self.status())

    def stop(self)->None:
        super().stop();self.running=False
