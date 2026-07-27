from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON,DateTime,Float,ForeignKey,Integer,String,Text,UniqueConstraint,func,select,text
from sqlalchemy.ext.asyncio import AsyncSession,async_sessionmaker,create_async_engine
from sqlalchemy.orm import DeclarativeBase,Mapped,mapped_column,relationship
from sqlalchemy.pool import NullPool

from axiom.domain.models import Alert,MarketState,Outcome


class Base(DeclarativeBase):pass


class ConfigurationRow(Base):
    __tablename__="configurations";id:Mapped[int]=mapped_column(primary_key=True);version:Mapped[str]=mapped_column(String(80),unique=True,index=True)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True));created_by:Mapped[str]=mapped_column(String(120));payload:Mapped[dict[str,Any]]=mapped_column(JSON);parent_version:Mapped[str|None]=mapped_column(String(80));active:Mapped[bool]=mapped_column(default=False)


class AlertRow(Base):
    __tablename__="alerts";id:Mapped[str]=mapped_column(String(36),primary_key=True);channel:Mapped[str]=mapped_column(String(16),index=True)
    timestamp:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True);symbol:Mapped[str]=mapped_column(String(16),index=True);direction:Mapped[str]=mapped_column(String(8));confidence:Mapped[float]=mapped_column(Float)
    explosion_score:Mapped[float]=mapped_column(Float);direction_score:Mapped[int]=mapped_column(Integer);regime:Mapped[str]=mapped_column(String(40),index=True);profile:Mapped[str]=mapped_column(String(40),index=True)
    price:Mapped[float]=mapped_column(Float);expected_move:Mapped[float]=mapped_column(Float);risk_level:Mapped[str]=mapped_column(String(16));config_version:Mapped[str]=mapped_column(String(80));payload:Mapped[dict[str,Any]]=mapped_column(JSON)


class HistoricalAlertRow(Base):
    __tablename__="historical_alerts";id:Mapped[int]=mapped_column(primary_key=True);alert_id:Mapped[str]=mapped_column(ForeignKey("alerts.id",ondelete="CASCADE"),unique=True);replay_run_id:Mapped[str]=mapped_column(String(36),index=True);source_timestamp:Mapped[datetime]=mapped_column(DateTime(timezone=True))


class LiveAlertRow(Base):
    __tablename__="live_alerts";id:Mapped[int]=mapped_column(primary_key=True);alert_id:Mapped[str]=mapped_column(ForeignKey("alerts.id",ondelete="CASCADE"),unique=True);received_at:Mapped[datetime]=mapped_column(DateTime(timezone=True));transport_latency_ms:Mapped[float]=mapped_column(Float,default=0)


class MarketStateRow(Base):
    __tablename__="market_states";id:Mapped[int]=mapped_column(primary_key=True);timestamp:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True);symbol:Mapped[str]=mapped_column(String(16),index=True);regime:Mapped[str]=mapped_column(String(40),index=True);profile:Mapped[str]=mapped_column(String(40));payload:Mapped[dict[str,Any]]=mapped_column(JSON)
    __table_args__=(UniqueConstraint("timestamp","symbol",name="uq_state_time_symbol"),)


class MetricRow(Base):
    __tablename__="metrics";id:Mapped[int]=mapped_column(primary_key=True);timestamp:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True);symbol:Mapped[str]=mapped_column(String(16),index=True);name:Mapped[str]=mapped_column(String(64),index=True);value:Mapped[float]=mapped_column(Float);timeframe_seconds:Mapped[int]=mapped_column(Integer);dimensions:Mapped[dict[str,Any]]=mapped_column(JSON,default=dict)


class RegimeRow(Base):
    __tablename__="regimes";id:Mapped[int]=mapped_column(primary_key=True);symbol:Mapped[str]=mapped_column(String(16),index=True);regime:Mapped[str]=mapped_column(String(40));started_at:Mapped[datetime]=mapped_column(DateTime(timezone=True));ended_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True));confidence:Mapped[float]=mapped_column(Float);explanation:Mapped[str]=mapped_column(Text)


class PerformanceRow(Base):
    __tablename__="performance";id:Mapped[int]=mapped_column(primary_key=True);alert_id:Mapped[str]=mapped_column(ForeignKey("alerts.id",ondelete="CASCADE"),unique=True);evaluated_at:Mapped[datetime]=mapped_column(DateTime(timezone=True));precision:Mapped[float]=mapped_column(Float,index=True);direction_accuracy:Mapped[float]=mapped_column(Float);magnitude_accuracy:Mapped[float]=mapped_column(Float);timing_accuracy:Mapped[float]=mapped_column(Float);payload:Mapped[dict[str,Any]]=mapped_column(JSON)


class SystemOutcomeRow(Base):
    __tablename__="system_outcomes"
    id:Mapped[str]=mapped_column(String(36),primary_key=True)
    system:Mapped[str]=mapped_column(String(32),index=True)
    mode:Mapped[str]=mapped_column(String(16),index=True)
    symbol:Mapped[str]=mapped_column(String(16),index=True)
    direction:Mapped[str]=mapped_column(String(8))
    alerted_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True)
    expires_at:Mapped[datetime]=mapped_column(DateTime(timezone=True))
    status:Mapped[str]=mapped_column(String(16),index=True)
    entry_price:Mapped[float]=mapped_column(Float)
    highest_price:Mapped[float]=mapped_column(Float)
    lowest_price:Mapped[float]=mapped_column(Float)
    favorable_points:Mapped[float]=mapped_column(Float,index=True)
    adverse_points:Mapped[float]=mapped_column(Float,index=True)
    payload:Mapped[dict[str,Any]]=mapped_column(JSON)


class TradeRow(Base):
    __tablename__="trades";id:Mapped[str]=mapped_column(String(36),primary_key=True);alert_id:Mapped[str|None]=mapped_column(ForeignKey("alerts.id"));symbol:Mapped[str]=mapped_column(String(16),index=True);side:Mapped[str]=mapped_column(String(8));quantity:Mapped[float]=mapped_column(Float);entry_price:Mapped[float]=mapped_column(Float);exit_price:Mapped[float|None]=mapped_column(Float);opened_at:Mapped[datetime]=mapped_column(DateTime(timezone=True));closed_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True));status:Mapped[str]=mapped_column(String(16));payload:Mapped[dict[str,Any]]=mapped_column(JSON,default=dict)


class SystemEventRow(Base):
    __tablename__="system_events";id:Mapped[int]=mapped_column(primary_key=True);timestamp:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True);level:Mapped[str]=mapped_column(String(16),index=True);component:Mapped[str]=mapped_column(String(80),index=True);message:Mapped[str]=mapped_column(Text);details:Mapped[dict[str,Any]]=mapped_column(JSON,default=dict)


class ModelVersionRow(Base):
    __tablename__="model_versions";id:Mapped[int]=mapped_column(primary_key=True);name:Mapped[str]=mapped_column(String(80));version:Mapped[str]=mapped_column(String(80));created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True));formula_hash:Mapped[str]=mapped_column(String(64));parameters:Mapped[dict[str,Any]]=mapped_column(JSON);metrics:Mapped[dict[str,Any]]=mapped_column(JSON);active:Mapped[bool]=mapped_column(default=False)
    __table_args__=(UniqueConstraint("name","version",name="uq_model_name_version"),)


class SqlAlchemyRepository:
    def __init__(self,session_factory:async_sessionmaker[AsyncSession]):self.sessions=session_factory

    async def save_state(self,state:MarketState)->None:
        async with self.sessions() as s:
            s.add(MarketStateRow(timestamp=state.timestamp,symbol=state.symbol,regime=state.regime.value,profile=state.profile.value,payload=state.model_dump(mode="json")))
            for score in (state.explosion,state.direction,state.pressure,state.dealer_hedging,state.momentum,state.confidence,state.risk):
                s.add(MetricRow(timestamp=state.timestamp,symbol=state.symbol,name=score.name,value=score.value,timeframe_seconds=60,dimensions={"confidence":score.confidence}))
            await s.commit()

    async def save_alert(self,alert:Alert)->None:
        async with self.sessions() as s:
            s.add(AlertRow(id=str(alert.id),channel=alert.engine_mode.value,timestamp=alert.timestamp,symbol=alert.symbol,direction=alert.direction.value,
                confidence=alert.confidence,explosion_score=alert.explosion_score,direction_score=alert.direction_score,regime=alert.regime.value,profile=alert.profile.value,
                price=alert.price,expected_move=alert.expected_move,risk_level=alert.risk_level.value,config_version=alert.config_version,payload=alert.model_dump(mode="json")))
            if alert.engine_mode.value=="LIVE":s.add(LiveAlertRow(alert_id=str(alert.id),received_at=alert.timestamp,transport_latency_ms=0))
            else:s.add(HistoricalAlertRow(alert_id=str(alert.id),replay_run_id="default",source_timestamp=alert.timestamp))
            await s.commit()

    async def save_outcome(self,outcome:Outcome)->None:
        async with self.sessions() as s:
            s.add(PerformanceRow(alert_id=str(outcome.alert_id),evaluated_at=outcome.evaluated_at,precision=outcome.precision,direction_accuracy=outcome.direction_accuracy,
                magnitude_accuracy=outcome.magnitude_accuracy,timing_accuracy=outcome.timing_accuracy,payload=outcome.model_dump(mode="json")));await s.commit()

    @staticmethod
    def _json_ready(value:Any)->Any:
        if isinstance(value,datetime):return value.isoformat()
        if isinstance(value,dict):return {key:SqlAlchemyRepository._json_ready(item) for key,item in value.items()}
        if isinstance(value,(list,tuple)):return [SqlAlchemyRepository._json_ready(item) for item in value]
        return value

    async def save_system_outcome(self,record:dict[str,Any])->None:
        payload=self._json_ready(record)
        async with self.sessions() as s:
            row=await s.get(SystemOutcomeRow,record["id"])
            values=dict(system=record["system"],mode=record["mode"],symbol=record["symbol"],direction=record["direction"],
                alerted_at=record["alerted_at"],expires_at=record["expires_at"],status=record["status"],
                entry_price=record["entry_price"],highest_price=record["highest_price"],lowest_price=record["lowest_price"],
                favorable_points=record["favorable_points"],adverse_points=record["adverse_points"],payload=payload)
            if row is None:s.add(SystemOutcomeRow(id=record["id"],**values))
            else:
                for key,value in values.items():setattr(row,key,value)
            await s.commit()

    async def outcome_attribution(self,symbol:str,per_group:int=3)->dict[str,Any]:
        async with self.sessions() as s:
            rows=(await s.execute(select(SystemOutcomeRow).where(SystemOutcomeRow.symbol==symbol.upper())
                .order_by(SystemOutcomeRow.alerted_at.desc()).limit(1000))).scalars().all()
        systems={}
        for system in ("PRIMARY_OPTIONS","MOMENTUM_TRIAD","GAMMA_DYNAMICS"):
            items=[dict(row.payload) for row in rows if row.system==system]
            # MFE ranks the strongest direction-adjusted follow-through. MAE is
            # negative; ascending order ranks the deepest adverse excursion.
            systems[system]={
                "highest":sorted(items,key=lambda item:float(item.get("favorable_points",0)),reverse=True)[:per_group],
                "lowest":sorted(items,key=lambda item:float(item.get("adverse_points",0)))[:per_group],
                "calls":items[:50],
                "tracking":sum(item.get("status")=="TRACKING" for item in items),
                "total":len(items),
            }
        return {"symbol":symbol.upper(),"systems":systems}

    async def list_alerts(self,limit:int=100,offset:int=0)->list[Alert]:
        async with self.sessions() as s:
            rows=(await s.execute(select(AlertRow).order_by(AlertRow.timestamp.desc()).limit(limit).offset(offset))).scalars().all()
            return [Alert.model_validate(r.payload) for r in rows]

    async def list_alert_views(self,limit:int=100,offset:int=0)->list[dict[str,Any]]:
        async with self.sessions() as s:
            rows=(await s.execute(select(AlertRow,PerformanceRow).outerjoin(PerformanceRow,PerformanceRow.alert_id==AlertRow.id)
                .order_by(AlertRow.timestamp.desc()).limit(limit).offset(offset))).all()
            result=[]
            for alert,outcome in rows:
                payload=dict(alert.payload);payload["result"]="PENDING" if outcome is None else ("SUCCESS" if outcome.precision>=.7 else "FAILURE")
                payload["precision"]=None if outcome is None else outcome.precision
                result.append(payload)
            return result

    async def latest_states(self,symbol:str,limit:int=100)->list[MarketState]:
        async with self.sessions() as s:
            rows=(await s.execute(select(MarketStateRow).where(MarketStateRow.symbol==symbol.upper()).order_by(MarketStateRow.timestamp.desc()).limit(limit))).scalars().all()
            return [MarketState.model_validate(r.payload) for r in rows]

    async def ping(self)->bool:
        try:
            async with self.sessions() as s:await s.execute(text("select 1"))
            return True
        except Exception:return False

    async def save_system_event(self,event:dict[str,Any])->None:
        timestamp=event.get("timestamp")
        if isinstance(timestamp,str):timestamp=datetime.fromisoformat(timestamp.replace("Z","+00:00"))
        async with self.sessions() as s:
            s.add(SystemEventRow(timestamp=timestamp or datetime.now().astimezone(),level=str(event.get("level","INFO")),
                component=str(event.get("component","platform")),message=str(event.get("message","")),details=event));await s.commit()

    async def list_system_events(self,limit:int=25)->list[dict[str,Any]]:
        async with self.sessions() as s:
            rows=(await s.execute(select(SystemEventRow).order_by(SystemEventRow.timestamp.desc()).limit(limit))).scalars().all()
            return [{"timestamp":r.timestamp,"level":r.level,"component":r.component,"message":r.message,"details":r.details} for r in rows]

    async def performance_summary(self)->dict[str,Any]:
        async with self.sessions() as s:
            total=int((await s.scalar(select(func.count()).select_from(AlertRow))) or 0)
            live=int((await s.scalar(select(func.count()).select_from(AlertRow).where(AlertRow.channel=="LIVE"))) or 0)
            historical=total-live
            evaluated=int((await s.scalar(select(func.count()).select_from(PerformanceRow))) or 0)
            precision=float((await s.scalar(select(func.avg(PerformanceRow.precision)))) or 0)
            regime_rows=(await s.execute(select(AlertRow.regime,func.count()).group_by(AlertRow.regime))).all()
            direction_rows=(await s.execute(select(AlertRow.direction,func.count()).group_by(AlertRow.direction))).all()
            return {"total_alerts":total,"live_alerts":live,"historical_alerts":historical,"evaluated_alerts":evaluated,
                "pending_alerts":max(total-evaluated,0),"precision":precision,
                "by_regime":{str(name):int(count) for name,count in regime_rows},
                "by_direction":{str(name):int(count) for name,count in direction_rows}}

    async def chart_points(self,symbol:str,interval_seconds:int,limit:int=240,before:datetime|None=None)->list[dict[str,Any]]:
        before_clause="and timestamp < :before" if before else ""
        statement=text(f"""
            with source as (
                select timestamp,(payload->'supporting_indicators'->>'price')::double precision as price
                from market_states
                where symbol=:symbol {before_clause}
                  and payload->'supporting_indicators'->>'price' is not null
            ), buckets as (
                select date_bin((:interval_seconds * interval '1 second'),timestamp,timestamptz '2000-01-01') as bucket,
                       (array_agg(price order by timestamp asc))[1] as open,
                       max(price) as high,min(price) as low,
                       (array_agg(price order by timestamp desc))[1] as close,
                       count(*) as samples
                from source group by bucket
            )
            select bucket,open,high,low,close,samples from buckets order by bucket desc limit :limit
        """)
        params={"symbol":symbol.upper(),"interval_seconds":interval_seconds,"limit":limit}
        if before:params["before"]=before
        async with self.sessions() as s:
            rows=(await s.execute(statement,params)).mappings().all()
            return list(reversed([{"timestamp":row["bucket"],"open":float(row["open"]),"high":float(row["high"]),
                "low":float(row["low"]),"close":float(row["close"]),"samples":int(row["samples"])} for row in rows]))


async def create_database(url:str)->tuple[async_sessionmaker[AsyncSession],SqlAlchemyRepository]:
    # Supabase's transaction pooler (port 6543) cannot retain prepared
    # statements. Render normally uses the session pooler on port 5432, but
    # this keeps the application safe if transaction mode is selected.
    kwargs:dict[str,Any]={"pool_pre_ping":True}
    if ":6543/" in url:
        kwargs.update(poolclass=NullPool,connect_args={"statement_cache_size":0})
    engine=create_async_engine(url,**kwargs)
    async with engine.begin() as connection:await connection.run_sync(Base.metadata.create_all)
    factory=async_sessionmaker(engine,expire_on_commit=False);return factory,SqlAlchemyRepository(factory)
