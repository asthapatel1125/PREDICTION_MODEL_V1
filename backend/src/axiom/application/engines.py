from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime

from axiom.application.pipeline import DecisionPipeline
from axiom.domain.enums import EngineMode
from axiom.domain.models import PipelineResult
from axiom.ports.interfaces import EventPublisherPort, MarketDataPort, RepositoryPort


@dataclass(frozen=True)
class ReplayRequest:
    symbol:str; start:datetime; end:datetime; bar_resolution_seconds:int; replay_speed:float=0


class _EngineRunner:
    def __init__(self,pipeline:DecisionPipeline,repository:RepositoryPort,publisher:EventPublisherPort):
        self.pipeline=pipeline;self.repository=repository;self.publisher=publisher;self._stop=asyncio.Event()

    async def handle(self,bar,mode:EngineMode)->PipelineResult:
        result=self.pipeline.process(bar,mode); await self.repository.save_state(result.state)
        await self.publisher.publish("market_state",result.state.model_dump(mode="json"))
        if result.alert:
            await self.repository.save_alert(result.alert);await self.publisher.publish("alert",result.alert.model_dump(mode="json"))
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

    async def run(self,symbol:str,resolution_seconds:int)->None:
        self._stop.clear()
        backoff=1.0
        while not self._stop.is_set():
            try:
                async for bar in self.data.live_bars(symbol,resolution_seconds):
                    if self._stop.is_set():return
                    await self.handle(bar,EngineMode.LIVE)
                backoff=1.0
            except asyncio.CancelledError: raise
            except Exception as exc:
                await self.publisher.publish("system_event",{"level":"ERROR","component":"live_engine","message":str(exc),"retry_seconds":backoff})
                await asyncio.sleep(backoff);backoff=min(backoff*2,30)
