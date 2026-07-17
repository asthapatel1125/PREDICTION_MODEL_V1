from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON,DateTime,Float,ForeignKey,Integer,String,Text,UniqueConstraint,select
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

    async def list_alerts(self,limit:int=100,offset:int=0)->list[Alert]:
        async with self.sessions() as s:
            rows=(await s.execute(select(AlertRow).order_by(AlertRow.timestamp.desc()).limit(limit).offset(offset))).scalars().all()
            return [Alert.model_validate(r.payload) for r in rows]

    async def latest_states(self,symbol:str,limit:int=100)->list[MarketState]:
        async with self.sessions() as s:
            rows=(await s.execute(select(MarketStateRow).where(MarketStateRow.symbol==symbol.upper()).order_by(MarketStateRow.timestamp.desc()).limit(limit))).scalars().all()
            return [MarketState.model_validate(r.payload) for r in rows]


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
