from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter,FastAPI,HTTPException,Query,WebSocket,WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from axiom import __version__
from axiom.adapters.events import InMemoryEventBus
from axiom.adapters.thetadata import ThetaDataV3Client
from axiom.api.schemas import HealthResponse,LiveEngineRequest,ReplayRequestBody
from axiom.application.engines import LiveEngine,ReplayRequest,TrainingEngine
from axiom.application.pipeline import DecisionPipeline
from axiom.config.schema import PlatformSettings,StrategyConfig
from axiom.infrastructure.database import SqlAlchemyRepository,create_database


class Container:
    settings:PlatformSettings;config:StrategyConfig;repository:SqlAlchemyRepository;bus:InMemoryEventBus
    training:TrainingEngine;live:LiveEngine;live_task:asyncio.Task|None=None


def create_app(settings:PlatformSettings|None=None)->FastAPI:
    cfg=settings or PlatformSettings();container=Container();container.settings=cfg

    @asynccontextmanager
    async def lifespan(app:FastAPI):
        config_path=Path(cfg.strategy_config_path)
        if not config_path.exists():config_path=Path(__file__).parents[4]/"config"/"strategy.yaml"
        container.config=StrategyConfig.from_yaml(config_path);_,container.repository=await create_database(cfg.database_url)
        container.bus=InMemoryEventBus(cfg.websocket_queue_size);data=ThetaDataV3Client(cfg.thetadata_base_url,cfg.thetadata_timeout_seconds)
        container.training=TrainingEngine(DecisionPipeline(container.config,cfg.market_timezone),container.repository,container.bus,data)
        container.live=LiveEngine(DecisionPipeline(container.config,cfg.market_timezone),container.repository,container.bus,data)
        yield
        if container.live_task:container.live_task.cancel()

    app=FastAPI(title="Axiom Pressure Intelligence API",version=__version__,lifespan=lifespan,docs_url="/api/docs",openapi_url="/api/openapi.json")
    app.add_middleware(CORSMiddleware,allow_origins=cfg.cors_origins,allow_credentials=True,allow_methods=["*"],allow_headers=["*"])
    api=APIRouter(prefix="/api/v1")

    @api.get("/health",response_model=HealthResponse)
    async def health()->HealthResponse:return HealthResponse(status="healthy",database="connected",event_bus="connected",version=__version__)

    @api.get("/alerts")
    async def alerts(limit:int=Query(100,ge=1,le=1000),offset:int=Query(0,ge=0)):return await container.repository.list_alerts(limit,offset)

    @api.get("/history/{symbol}")
    async def history(symbol:str,limit:int=Query(100,ge=1,le=5000)):return await container.repository.latest_states(symbol,limit)

    @api.get("/configuration")
    async def configuration():return container.config.model_dump(mode="json")

    @api.post("/replay",status_code=202)
    async def replay(body:ReplayRequestBody):
        if body.end<=body.start:raise HTTPException(422,"end must be after start")
        request=ReplayRequest(body.symbol,body.start,body.end,body.bar_resolution_seconds,body.replay_speed)
        return await container.training.replay(request)

    @api.post("/live/start",status_code=202)
    async def start_live(body:LiveEngineRequest):
        if container.live_task and not container.live_task.done():raise HTTPException(409,"Live engine already running")
        container.live_task=asyncio.create_task(container.live.run(body.symbol,body.resolution_seconds),name=f"live-{body.symbol}")
        return {"status":"started","symbol":body.symbol.upper()}

    @api.post("/live/stop")
    async def stop_live():container.live.stop();return {"status":"stopping"}

    @app.websocket("/api/v1/stream")
    async def stream(websocket:WebSocket):
        await websocket.accept();queue=container.bus.subscribe()
        try:
            while True:await websocket.send_json(await queue.get())
        except WebSocketDisconnect:pass
        finally:container.bus.unsubscribe(queue)

    app.include_router(api);return app


app=create_app()

