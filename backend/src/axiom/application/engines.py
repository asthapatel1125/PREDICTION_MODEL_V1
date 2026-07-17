from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime,timezone

from axiom.application.pipeline import DecisionPipeline
from axiom.domain.enums import Direction,EngineMode
from axiom.domain.models import Outcome,PipelineResult
from axiom.ports.interfaces import EventPublisherPort, MarketDataPort, RepositoryPort


@dataclass(frozen=True)
class ReplayRequest:
    symbol:str; start:datetime; end:datetime; bar_resolution_seconds:int; replay_speed:float=0


class _EngineRunner:
    def __init__(self,pipeline:DecisionPipeline,repository:RepositoryPort,publisher:EventPublisherPort):
        self.pipeline=pipeline;self.repository=repository;self.publisher=publisher;self._stop=asyncio.Event();self._pending=[]

    async def handle(self,bar,mode:EngineMode)->PipelineResult:
        result=self.pipeline.process(bar,mode); await self.repository.save_state(result.state)
        await self.publisher.publish("market_state",result.state.model_dump(mode="json"))
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


class TrainingEngine(_EngineRunner):
    def __init__(self,pipeline:DecisionPipeline,repository:RepositoryPort,publisher:EventPublisherPort,data:MarketDataPort):
        super().__init__(pipeline,repository,publisher);self.data=data

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
    def __init__(self,pipeline:DecisionPipeline,repository:RepositoryPort,publisher:EventPublisherPort,data:MarketDataPort):
        super().__init__(pipeline,repository,publisher);self.data=data
        self.running=False;self.symbol:str|None=None;self.resolution_seconds=5;self.started_at:datetime|None=None
        self.last_update:datetime|None=None;self.last_error:str|None=None;self.bars_processed=0;self.alerts_generated=0
        self.average_latency_ms=0.0;self.retries=0

    def status(self)->dict[str,object]:
        return {"running":self.running,"symbol":self.symbol,"resolution_seconds":self.resolution_seconds,
            "started_at":self.started_at.isoformat() if self.started_at else None,
            "last_update":self.last_update.isoformat() if self.last_update else None,"last_error":self.last_error,
            "bars_processed":self.bars_processed,"alerts_generated":self.alerts_generated,
            "average_latency_ms":self.average_latency_ms,"retries":self.retries}

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
                        result=await self.handle(bar,EngineMode.LIVE);self.bars_processed+=1
                        self.alerts_generated+=int(result.alert is not None);self.last_update=bar.timestamp;self.last_error=None
                        self.average_latency_ms+=(result.processing_latency_ms-self.average_latency_ms)/self.bars_processed
                        await self.publisher.publish("engine_status",self.status());backoff=1.0
                    backoff=1.0
                except asyncio.CancelledError: raise
                except Exception as exc:
                    self.last_error=str(exc);self.retries+=1
                    event={"level":"ERROR","component":"live_engine","message":str(exc),"retry_seconds":backoff,"timestamp":datetime.now(timezone.utc).isoformat()}
                    if hasattr(self.repository,"save_system_event"):await self.repository.save_system_event(event)
                    await self.publisher.publish("system_event",event);await self.publisher.publish("engine_status",self.status())
                    await asyncio.sleep(backoff);backoff=min(backoff*2,30)
        finally:
            self.running=False;await self.publisher.publish("engine_status",self.status())

    def stop(self)->None:
        super().stop();self.running=False
