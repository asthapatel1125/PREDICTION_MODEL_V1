from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import date,datetime,time,timedelta,timezone
from pathlib import Path
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter,FastAPI,HTTPException,Query,WebSocket,WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel,Field

from axiom import __version__
from axiom.adapters.events import InMemoryEventBus
from axiom.adapters.thetadata import ThetaDataV3Client
from axiom.analytics.zone_intelligence import ZoneIntelligenceEngine
from axiom.application.engines import LiveEngine,ReplayRequest,TrainingEngine,TwelveDataPriceClient
from axiom.application.pipeline import DecisionPipeline
from axiom.config.schema import PlatformSettings,StrategyConfig
from axiom.infrastructure.database import SqlAlchemyRepository,create_database


INSTRUMENTS={
    "SPY":{"provider":"ThetaData OPRA options","available":True,"requirement":"Options Pro"},
    "QQQ":{"provider":"ThetaData OPRA options","available":True,"requirement":"Options Pro"},
    "NDX":{"provider":"ThetaData index options","available":True,"requirement":"Options Pro and NDX/index entitlement"},
    "NQ":{"provider":"CME futures","available":False,"requirement":"Separate licensed CME futures feed"},
    "ES":{"provider":"CME futures","available":False,"requirement":"Separate licensed CME futures feed"},
    "YM":{"provider":"CBOT futures","available":False,"requirement":"Separate licensed CME/CBOT futures feed"},
}
CHART_INTERVALS={5,15,60,180,300,720,900,1800,3600,14400,86400}


class ReplayRequestBody(BaseModel):
    symbol:str=Field(min_length=1,max_length=16)
    start:datetime
    end:datetime
    bar_resolution_seconds:int=Field(gt=0)
    replay_speed:float=Field(default=0,ge=0)


class LiveEngineRequest(BaseModel):
    symbol:str=Field(min_length=1,max_length=16)
    resolution_seconds:int=Field(default=5,gt=0)


class Container:
    settings:PlatformSettings;config:StrategyConfig;repository:SqlAlchemyRepository;bus:InMemoryEventBus
    data:ThetaDataV3Client;training:TrainingEngine;live:LiveEngine;live_task:asyncio.Task|None=None;auto_stream_task:asyncio.Task|None=None
    replay_runs:dict[str,dict[str,Any]];replay_tasks:set[asyncio.Task]


def create_app(settings:PlatformSettings|None=None)->FastAPI:
    cfg=settings or PlatformSettings();container=Container();container.settings=cfg

    @asynccontextmanager
    async def lifespan(app:FastAPI):
        config_path=Path(cfg.strategy_config_path)
        if not config_path.exists():config_path=Path(__file__).parents[4]/"config"/"strategy.yaml"
        container.config=StrategyConfig.from_yaml(config_path);_,container.repository=await create_database(cfg.database_url)
        container.bus=InMemoryEventBus(cfg.websocket_queue_size)
        api_key=cfg.thetadata_api_key.get_secret_value() if cfg.thetadata_api_key else None
        container.data=ThetaDataV3Client(cfg.thetadata_base_url,cfg.thetadata_timeout_seconds,api_key=api_key,
            transport=cfg.thetadata_transport,max_dte=cfg.thetadata_max_dte,strike_range=cfg.thetadata_strike_range,
            market_timezone=cfg.market_timezone,poll_seconds=cfg.thetadata_poll_seconds)
        twelve_key=cfg.twelve_data_api_key.get_secret_value() if cfg.twelve_data_api_key else None
        price_data=TwelveDataPriceClient(twelve_key)
        container.training=TrainingEngine(DecisionPipeline(container.config,cfg.market_timezone),container.repository,container.bus,container.data,
            cfg.outcome_horizon_minutes,cfg.outcome_signal_cooldown_seconds,cfg.outcome_qqq_points_per_50_nq)
        container.live=LiveEngine(DecisionPipeline(container.config,cfg.market_timezone),container.repository,container.bus,container.data,
            price_data,cfg.outcome_price_poll_seconds,cfg.outcome_horizon_minutes,
            cfg.outcome_signal_cooldown_seconds,cfg.outcome_qqq_points_per_50_nq)
        # Rehydrate compact Greek/chain histories before the automatic stream
        # begins. This preserves the model warm-up through a Render restart.
        container.live.pipeline.restore_history(await container.repository.stream_archive("QQQ",9_000))
        # Resume persisted active-call lifecycles after a Render restart.
        container.live.attribution.restore_active(await container.repository.active_system_outcomes())
        container.replay_runs={};container.replay_tasks=set()
        async def automatic_live_stream()->None:
            """Keep the licensed QQQ stream active on market weekdays, 7:00 AM–6:00 PM Eastern."""
            market_tz=ZoneInfo(cfg.market_timezone)
            while True:
                now=datetime.now(market_tz)
                within_window=now.weekday()<5 and time(7,0)<=now.time()<time(18,0)
                running=container.live_task and not container.live_task.done()
                if within_window and not running:
                    container.live_task=asyncio.create_task(container.live.run("QQQ",5),name="live-QQQ-auto")
                elif not within_window and running:
                    container.live.stop()
                await asyncio.sleep(15)
        container.auto_stream_task=asyncio.create_task(automatic_live_stream(),name="automatic-live-stream")
        yield
        if container.auto_stream_task:container.auto_stream_task.cancel()
        if container.live_task:container.live_task.cancel()
        for task in container.replay_tasks:task.cancel()

    app=FastAPI(title="Axiom Pressure Intelligence API",version=__version__,lifespan=lifespan,docs_url="/api/docs",openapi_url="/api/openapi.json")
    app.add_middleware(CORSMiddleware,allow_origins=cfg.cors_origins,allow_credentials=True,allow_methods=["*"],allow_headers=["*"])
    api=APIRouter(prefix="/api/v1")

    @api.get("/health")
    async def health()->dict[str,str]:
        database="connected" if await container.repository.ping() else "disconnected"
        return {"status":"healthy" if database=="connected" else "degraded",
            "database":database,"event_bus":"connected","version":__version__}

    @api.get("/alerts")
    async def alerts(limit:int=Query(100,ge=1,le=1000),offset:int=Query(0,ge=0)):return await container.repository.list_alert_views(limit,offset)

    @api.get("/history/{symbol}")
    async def history(symbol:str,limit:int=Query(100,ge=1,le=5000)):return await container.repository.latest_states(symbol,limit)

    @api.get("/dynamics-session/{symbol}")
    async def dynamics_session(symbol:str,session_date:date|None=Query(None)):
        """Return every persisted snapshot in the 07:00–18:00 Eastern stream window.

        A five-second stream produces up to 7,920 records in this window, so
        this endpoint deliberately does not inherit the dashboard's short
        history limit. Each state contains Delta and both Gamma model outputs.
        """
        market_tz=ZoneInfo(cfg.market_timezone)
        day=session_date or datetime.now(market_tz).date()
        start=datetime.combine(day,time(7,0),tzinfo=market_tz)
        end=datetime.combine(day,time(18,0),tzinfo=market_tz)
        rows=await container.repository.states_between(symbol,start.astimezone(timezone.utc),end.astimezone(timezone.utc),10_000)
        return {"symbol":symbol.upper(),"market_timezone":cfg.market_timezone,"start":start,"end":end,"count":len(rows),"rows":rows}

    @api.get("/dynamics-history/{symbol}")
    async def dynamics_history(symbol:str,limit:int=Query(720,ge=1,le=5_000)):
        """Return a bounded chart window ordered from the first retained tick.

        The full archive remains in Supabase.  Returning an unbounded archive
        on every browser load can deserialize hundreds of thousands of nested
        market-state payloads and exhaust small production instances.
        """
        rows=await container.repository.stream_archive(symbol,limit)
        return {"symbol":symbol.upper(),"source":"PERSISTED_LIVE_STREAM_ARCHIVE","bounded":True,"count":len(rows),"rows":rows}

    @api.get("/delta-dynamics/history/{symbol}")
    async def delta_dynamics_history(symbol:str,start_date:date=Query(date(2026,8,4)),
        end_date:date=Query(date(2026,8,4)),start_time:time=Query(time(9,0)),
        end_time:time=Query(time(17,0)),limit:int=Query(10000,ge=1,le=10000)):
        market_tz=ZoneInfo(cfg.market_timezone)
        start=datetime.combine(start_date,start_time,tzinfo=market_tz)
        end=datetime.combine(end_date,end_time,tzinfo=market_tz)
        if end<start:raise HTTPException(422,"The end of the Delta Dynamics audit range must not precede its start")
        if (end-start).total_seconds()>7*86400:raise HTTPException(422,"Delta Dynamics audit ranges are limited to seven days")
        rows=await container.repository.states_between(symbol,start.astimezone(timezone.utc),end.astimezone(timezone.utc),limit)
        if rows:
            return {"symbol":symbol.upper(),"source":"PERSISTED_THETADATA_STREAM","market_timezone":cfg.market_timezone,
                "start":start,"end":end,"count":len(rows),"rows":rows}
        zone_engine=ZoneIntelligenceEngine(market_timezone=cfg.market_timezone)
        greek_history=[];historical=[]
        try:
            async for bar in container.data.historical_bars(symbol,start,end,60):
                zone=zone_engine.calculate(bar.greeks,greek_history,bar.timestamp,bar.symbol)
                historical.append({"timestamp":bar.timestamp,"symbol":bar.symbol,"greeks":bar.greeks,
                    "zone_intelligence":zone,"supporting_indicators":{"price":bar.close}})
                greek_history.append(bar.greeks)
                if len(historical)>=limit:break
        except Exception as exc:
            raise HTTPException(502,f"ThetaData historical Greek retrieval failed: {exc}") from exc
        return {"symbol":symbol.upper(),"source":"THETADATA_HISTORY_1_MINUTE","market_timezone":cfg.market_timezone,
            "start":start,"end":end,"count":len(historical),"rows":historical}

    @api.get("/configuration")
    async def configuration():return container.config.model_dump(mode="json")

    @api.get("/instruments")
    async def instruments():return [{"symbol":symbol,**details} for symbol,details in INSTRUMENTS.items()]

    @api.get("/chart/{symbol}")
    async def chart(symbol:str,interval_seconds:int=Query(300),limit:int=Query(240,ge=30,le=1000),before:datetime|None=None):
        if interval_seconds not in CHART_INTERVALS:raise HTTPException(422,"Unsupported chart interval")
        return await container.repository.chart_points(symbol,interval_seconds,limit,before)

    @api.get("/engine/status")
    async def engine_status():return container.live.status()

    @api.get("/dashboard/{symbol}")
    async def dashboard(symbol:str,limit:int=Query(100,ge=1,le=500)):
        states=await container.repository.latest_states(symbol,limit)
        alerts=[alert for alert in await container.repository.list_alert_views(limit,0) if alert["symbol"]==symbol.upper()]
        return {"server_time":datetime.now(timezone.utc),"engine":container.live.status(),
            "state":states[0] if states else None,"history":list(reversed(states)),"alerts":alerts,
            "performance":await container.repository.performance_summary()}

    @api.get("/performance")
    async def performance():return await container.repository.performance_summary()

    @api.get("/outcome-attribution/{symbol}")
    async def outcome_attribution(symbol:str):
        return await container.repository.outcome_attribution(symbol,3)

    @api.get("/system-outcomes/{call_id}")
    async def system_outcome(call_id:str):
        record=await container.repository.system_outcome_by_call_id(call_id)
        if record is None:raise HTTPException(status_code=404,detail="Stored call ID not found")
        return record

    @api.get("/system")
    async def system():return {"server_time":datetime.now(timezone.utc),"database_connected":await container.repository.ping(),
        "engine":container.live.status(),"events":await container.repository.list_system_events(25),
        "theta_transport":cfg.thetadata_transport,"theta_poll_seconds":cfg.thetadata_poll_seconds,
        "outcome_price_provider":"TWELVE_DATA" if cfg.twelve_data_api_key else "THETADATA_OPTIONS_UNDERLYING",
        "outcome_horizon_minutes":cfg.outcome_horizon_minutes,
        "outcome_qqq_points_per_50_nq":cfg.outcome_qqq_points_per_50_nq,
        "outcome_target_note":"Estimated QQQ proxy until a synchronized licensed NQ feed is connected."}

    def _wall_time(value:datetime|None)->datetime|None:
        return value.astimezone(timezone.utc) if value else None

    @api.get("/walls/spectrum")
    async def wall_spectrum(symbol:str="QQQ",start:datetime|None=None,end:datetime|None=None,wall_type:str|None=None,tiers:str|None=None):
        rows=await container.repository.wall_intelligence_points(symbol,_wall_time(start),_wall_time(end),720)
        requested_types={item.strip().upper() for item in wall_type.split(",")} if wall_type else None
        requested_tiers={item.strip().upper() for item in tiers.split(",")} if tiers else None
        # Filter individual walls without discarding their shared market point.
        for row in rows:
            row["walls"]={name:value for name,value in row.get("walls",{}).items()
                if (not requested_types or name in requested_types) and (not requested_tiers or str(value.get("tier","")) in requested_tiers)}
        return {"symbol":symbol.upper(),"market_timezone":cfg.market_timezone,"rows":rows,"is_point_in_time":True,"is_estimated_oi_delayed":True,
            "disclaimer":"Estimated wall: delayed OI x Greek. DealerFlow is a proxy, not tape."}

    @api.get("/walls/day-levels")
    async def wall_day_levels(symbol:str="QQQ",session_date:date|None=None,display_bucket_seconds:int=60,since:datetime|None=None):
        """Return the compact Wall Intelligence stream for one 07:00-18:00 ET session.

        This purpose-built endpoint avoids loading nested MarketState payloads
        just to draw a price-and-level chart. It defaults to compact one-minute
        display bars; the Zero-Gamma chart requests five-second bars and then
        polls only the observations newer than its last received timestamp.
        """
        market_tz=ZoneInfo(cfg.market_timezone)
        day=session_date or datetime.now(market_tz).date()
        session_start=datetime.combine(day,time(7,0),tzinfo=market_tz).astimezone(timezone.utc)
        end=datetime.combine(day,time(18,0),tzinfo=market_tz).astimezone(timezone.utc)
        requested_bucket=5 if int(display_bucket_seconds)<=5 else 60
        requested_since=_wall_time(since)
        start=max(session_start,requested_since) if requested_since else session_start
        rows=await container.repository.wall_intelligence_points(symbol,start,end,8_000)
        def observed_at(row:dict[str,Any])->datetime:
            return datetime.fromisoformat(str(row["timestamp"]).replace("Z","+00:00")).astimezone(market_tz)

        # The database retains each five-second observation.  The default
        # response remains one-minute compact data; callers that need an exact
        # short-range view can explicitly request the stored five-second bars.
        minute_buckets:dict[str,dict[str,Any]]={}
        for row in rows:
            observed=observed_at(row)
            bucket_second=(observed.second//requested_bucket)*requested_bucket
            bucket_key=observed.replace(second=bucket_second,microsecond=0).isoformat()
            wall_subset={key:row.get("walls",{}).get(key,{}) for key in ("CALL_WALL","PUT_WALL","ZERO_GAMMA","SUPPORT","RESISTANCE","DELTA_WALL","ZERO_DELTA")}
            existing=minute_buckets.get(bucket_key)
            compact_row={"timestamp":row.get("timestamp"),"spot":row.get("spot"),"walls":wall_subset,"volume":float(row.get("volume") or 0.0)}
            if existing is None:
                minute_buckets[bucket_key]=compact_row
            else:
                compact_row["volume"]=float(existing.get("volume") or 0.0)+compact_row["volume"]
                minute_buckets[bucket_key]=compact_row
        # Preserve every five-second observation, but derive a stable reference
        # for each market phase from its first five minutes.  This is not a
        # blunt median: the anchor is the weighted median of the most persistent
        # half-dollar level, with higher-weighted strong walls, higher exposure,
        # nearby-to-spot levels, and slightly newer observations.  That keeps a
        # short chain/OI jump from redefining a market-condition reference while
        # avoiding an average of unrelated wall regimes.
        phase_specs=(
            ("PREMARKET",time(7,0),time(9,30)),
            ("OPENING",time(9,30),time(10,0)),
            ("MORNING",time(10,0),time(12,0)),
            ("MIDDAY",time(12,0),time(14,0)),
            ("AFTERNOON",time(14,0),time(15,0)),
            ("POWER_HOUR",time(15,0),time(16,0)),
            ("AFTER_HOURS",time(16,0),time(18,0)),
        )
        phase_anchors=[]
        for name,phase_start,phase_end in phase_specs:
            anchor_start=datetime.combine(day,phase_start,tzinfo=market_tz)
            anchor_end=min(anchor_start.replace(second=0,microsecond=0)+timedelta(minutes=5),datetime.combine(day,phase_end,tzinfo=market_tz))
            sample=[row for row in rows if anchor_start<=observed_at(row)<anchor_end]
            if not sample:
                continue
            def wall_condition_anchor(key:str)->dict[str,Any]|None:
                observations=[]
                tier_weights={"STRONGEST":5.0,"STRONG":3.5,"NORMAL":2.25,"WEAK":1.5,"WEAKEST":1.0}
                for index,row in enumerate(sample):
                    wall=row.get("walls",{}).get(key,{}) or {}
                    try:
                        strike=float(wall.get("strike"))
                        spot=float(row.get("spot"))
                    except (TypeError,ValueError):
                        continue
                    if strike<=0 or spot<=0:
                        continue
                    tier=str(wall.get("tier") or "WEAKEST").upper()
                    try:
                        percentile=max(0.0,min(100.0,float(wall.get("percentile") or 0.0)))
                        dollar=abs(float(wall.get("dollar") or wall.get("gex_dollar") or 0.0))
                    except (TypeError,ValueError):
                        percentile,dollar=0.0,0.0
                    recency=0.70+0.30*(index/max(len(sample)-1,1))
                    proximity=1.0/(1.0+abs(strike-spot)/max(spot*0.015,1.0))
                    exposure=1.0+min(0.35,(dollar/1_000_000_000.0)*0.10)
                    weight=tier_weights.get(tier,1.0)*(1.0+percentile/400.0)*recency*(0.55+0.45*proximity)*exposure
                    observations.append((strike,weight))
                if not observations:
                    return None
                buckets:dict[float,float]={}
                for strike,weight in observations:
                    bucket=round(strike*2.0)/2.0
                    buckets[bucket]=buckets.get(bucket,0.0)+weight
                dominant_bucket,dominant_weight=max(buckets.items(),key=lambda item:item[1])
                selected=[item for item in observations if abs(item[0]-dominant_bucket)<=0.251] or observations
                selected.sort(key=lambda item:item[0])
                total_weight=sum(weight for _,weight in selected)
                cumulative=0.0
                anchor=selected[-1][0]
                for strike,weight in selected:
                    cumulative+=weight
                    if cumulative>=total_weight/2.0:
                        anchor=strike
                        break
                return {"value":float(anchor),"method":"dominant_weighted_median","dominant_level":float(dominant_bucket),
                    "dominant_share":float(dominant_weight/max(sum(buckets.values()),1e-9)),"sample_count":len(observations)}
            anchor_meta={key:wall_condition_anchor(key) for key in ("CALL_WALL","PUT_WALL","ZERO_GAMMA","SUPPORT","RESISTANCE")}
            phase_anchors.append({"phase":name,"start":anchor_start,"end":datetime.combine(day,phase_end,tzinfo=market_tz),
                "sample_start":sample[0].get("timestamp"),"sample_count":len(sample),
                "levels":{key:(anchor_meta[key] or {}).get("value") for key in anchor_meta},"anchor_meta":anchor_meta})
        return {"symbol":symbol.upper(),"market_timezone":cfg.market_timezone,"start":start,"end":end,
            "count":len(rows),"display_count":len(minute_buckets),"rows":list(minute_buckets.values()),"cadence_seconds":5,"display_bucket_seconds":requested_bucket,
            "phase_anchor_window_seconds":300,"phase_anchors":phase_anchors,
            "disclaimer":"Solid phase levels use a condition-aware weighted median from the first five minutes of each market phase: the dominant persistent level receives more weight when its wall is stronger, larger, nearer spot, and more recent. Faint dashed levels are 5-second point-in-time estimates from delayed OI and current Greeks; volume is aggregated option-chain observation volume."}

    @api.get("/walls/dealerflow")
    async def wall_dealerflow(symbol:str="QQQ",start:datetime|None=None,end:datetime|None=None):
        rows=await container.repository.wall_intelligence_points(symbol,_wall_time(start),_wall_time(end),720)
        fields=("timestamp","spot","dex","vol_hack","dealer_flow","pos_inventory","neg_inventory","tw_gex","gex_density","gex_dollar_density","spoof_score","edge","liquidity","vix","regime","is_point_in_time","is_estimated_oi_delayed")
        return {"symbol":symbol.upper(),"market_timezone":cfg.market_timezone,"rows":[{key:row.get(key) for key in fields} for row in rows],"is_point_in_time":True,"is_estimated_oi_delayed":True}

    @api.get("/walls/breaks")
    async def wall_breaks(symbol:str="QQQ",start:datetime|None=None,end:datetime|None=None,wall_type:str|None=None,tiers:str|None=None,min_volume_surge:float=0,edge_min:float=0):
        types=[item.strip().upper() for item in wall_type.split(",")] if wall_type else None;requested_tiers=[item.strip().upper() for item in tiers.split(",")] if tiers else None
        rows=await container.repository.wall_break_events(symbol,_wall_time(start),_wall_time(end),types,requested_tiers)
        rows=[row for row in rows if float(row.get("volume_surge",0))>=min_volume_surge and float(row.get("edge",0))>=edge_min]
        return {"symbol":symbol.upper(),"market_timezone":cfg.market_timezone,"rows":rows,"edge_min":edge_min,"is_point_in_time":True,"is_estimated_oi_delayed":True}

    @api.get("/walls/summary-history")
    async def wall_summary_history(symbol:str="QQQ"):
        rows=await container.repository.wall_summary_history(symbol,240)
        return {"symbol":symbol.upper(),"market_timezone":cfg.market_timezone,"cadence_seconds":30,"rows":rows,"is_point_in_time":True,"is_estimated_oi_delayed":True}

    async def execute_replay(run_id:str,request:ReplayRequest)->None:
        try:
            result=await container.training.replay(request);container.replay_runs[run_id]={"id":run_id,"status":"completed",**result}
        except Exception as exc:
            container.replay_runs[run_id]={"id":run_id,"status":"failed","error":str(exc)}
        await container.bus.publish("replay_status",container.replay_runs[run_id])

    @api.post("/replay",status_code=202)
    async def replay(body:ReplayRequestBody):
        if body.end<=body.start:raise HTTPException(422,"end must be after start")
        request=ReplayRequest(body.symbol,body.start,body.end,body.bar_resolution_seconds,body.replay_speed)
        run_id=str(uuid4());container.replay_runs[run_id]={"id":run_id,"status":"running","bars":0,"alerts":0}
        task=asyncio.create_task(execute_replay(run_id,request),name=f"replay-{run_id}");container.replay_tasks.add(task)
        task.add_done_callback(container.replay_tasks.discard);return container.replay_runs[run_id]

    @api.get("/replay/{run_id}")
    async def replay_status(run_id:str):
        if run_id not in container.replay_runs:raise HTTPException(404,"Replay run not found")
        return container.replay_runs[run_id]

    @api.post("/live/start",status_code=202)
    async def start_live(body:LiveEngineRequest):
        instrument=INSTRUMENTS.get(body.symbol.upper())
        if not instrument:raise HTTPException(422,"Unsupported instrument")
        if not instrument["available"]:raise HTTPException(422,f"{body.symbol.upper()} requires a separate licensed futures feed")
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
