from __future__ import annotations

from datetime import datetime,timezone
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
    zone_name:Mapped[str|None]=mapped_column(String(40),index=True,nullable=True)
    zone_score:Mapped[float|None]=mapped_column(Float,index=True,nullable=True)
    zone_confidence:Mapped[float|None]=mapped_column(Float,nullable=True)
    zone_qualified:Mapped[bool|None]=mapped_column(nullable=True,index=True)
    zone_direction:Mapped[str|None]=mapped_column(String(8),nullable=True,index=True)
    zone_normalized_greeks:Mapped[dict[str,Any]|None]=mapped_column(JSON,nullable=True)
    zone_greek_bands:Mapped[dict[str,Any]|None]=mapped_column(JSON,nullable=True)
    zone_rule_checks:Mapped[dict[str,Any]|None]=mapped_column(JSON,nullable=True)
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
            zone=state.zone_intelligence
            s.add(MarketStateRow(timestamp=state.timestamp,symbol=state.symbol,regime=state.regime.value,profile=state.profile.value,payload=state.model_dump(mode="json"),
                zone_name=zone.zone if zone else None,zone_score=zone.score if zone else None,
                zone_confidence=zone.confidence if zone else None,zone_qualified=zone.qualified if zone else None,
                zone_direction=zone.direction.value if zone else None,zone_normalized_greeks=zone.normalized if zone else None,
                zone_greek_bands=zone.bands if zone else None,zone_rule_checks=zone.rule_checks if zone else None))
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

    async def active_system_outcomes(self)->list[dict[str,Any]]:
        """Load unresolved call paths so a restarted live engine can resume them."""
        async with self.sessions() as s:
            rows=(await s.execute(select(SystemOutcomeRow).where(SystemOutcomeRow.status=="TRACKING")
                .order_by(SystemOutcomeRow.alerted_at.asc()))).scalars().all()
            return [dict(row.payload) for row in rows]

    @staticmethod
    def _reconcile_expired_outcome(row:SystemOutcomeRow,now:datetime)->bool:
        """Finalize an overdue persisted call after a service restart."""
        expires_at=row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
        alerted_at=row.alerted_at if row.alerted_at.tzinfo else row.alerted_at.replace(tzinfo=timezone.utc)
        payload=dict(row.payload)
        stored_status=str(payload.get("status") or row.status or "TRACKING").upper()
        if stored_status in {"EXPIRED","COMPLETE","INTERRUPTED"} or payload.get("target_reached_at") is not None or expires_at>now:
            return False
        bars=payload.get("minute_bars") or []
        final_price=float(payload.get("current_price")
            or (bars[-1].get("close") if bars else None)
            or payload.get("entry_price",row.entry_price))
        entry=float(payload.get("entry_price",row.entry_price))
        target=float(payload.get("target_price",
            entry+(50 if row.direction=="UP" else -50)))
        shortfall=max(0.0,target-final_price if row.direction=="UP" else final_price-target)
        favorable=max(0.0,float(payload.get("favorable_points",0.0)))
        target_points=float(payload.get("target_points",abs(target-entry)))
        partial_threshold=float(payload.get("partial_target_points",target_points*0.6))
        directional_success=row.system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"} and (
            final_price>entry if row.direction=="UP" else final_price<entry)
        failure_scores=dict(payload.get("greek_scores_current") or {})
        ordered=[name for name,_ in sorted(failure_scores.items(),key=lambda item:(-float(item[1]),item[0]))]
        failure_rankings={
            "strongest":ordered[:1],"strong":ordered[1:2],"normal":ordered[2:4],
            "weak":ordered[4:5],"weakest":ordered[5:6],
        }
        payload.update(
            status="EXPIRED",completion_reason="HORIZON_EXPIRED",
            outcome_grade="SUCCESS" if directional_success else "PARTIAL" if favorable>=partial_threshold else "FAILED",
            success_basis="DIRECTIONAL_FINAL" if directional_success else None,
            final_favorable_points=favorable,
            expired_at=expires_at.isoformat(),final_price=final_price,
            final_price_at=payload.get("current_price_at",expires_at.isoformat()),
            current_price=final_price,
            seconds_observed=max(0.0,(expires_at-alerted_at).total_seconds()),
            target_shortfall_points=shortfall,
            dynamic_high=float(payload.get("dynamic_high",payload.get("highest_price",row.highest_price))),
            dynamic_low=float(payload.get("dynamic_low",payload.get("lowest_price",row.lowest_price))),
            strongest_greek_current=payload.get("strongest_greek_current",payload.get("strongest_greek")),
            weakest_greek_current=payload.get("weakest_greek_current",payload.get("weakest_greek")),
            greek_scores_at_failure=failure_scores,
            greek_rankings_at_failure=failure_rankings,
            greek_values_at_failure=dict(payload.get("greek_values_current") or {}),
        )
        row.status="EXPIRED"
        row.payload=payload
        return True

    @staticmethod
    def _reconcile_interrupted_gamma_outcome(row:SystemOutcomeRow,now:datetime,stale_seconds:int=90)->bool:
        """Stop Gamma calls whose persisted stream has stopped advancing."""
        if row.system not in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"}:
            return False
        payload=dict(row.payload)
        if str(payload.get("status") or row.status or "TRACKING").upper()!="TRACKING":
            return False
        raw_last=payload.get("current_price_at") or payload.get("price_observed_at") or payload.get("alerted_at")
        if not raw_last:return False
        last_observed=datetime.fromisoformat(str(raw_last).replace("Z","+00:00")) if not isinstance(raw_last,datetime) else raw_last
        if last_observed.tzinfo is None:last_observed=last_observed.replace(tzinfo=timezone.utc)
        if (now-last_observed).total_seconds()<=stale_seconds:return False
        alerted_at=row.alerted_at if row.alerted_at.tzinfo else row.alerted_at.replace(tzinfo=timezone.utc)
        final_price=float(payload.get("current_price",payload.get("entry_price",row.entry_price)))
        entry=float(payload.get("entry_price",row.entry_price))
        directional_success=final_price>entry if row.direction=="UP" else final_price<entry
        favorable=max(0.0,float(payload.get("favorable_points",0.0)))
        partial_threshold=float(payload.get("partial_target_points",float(payload.get("target_points",0.0))*.6))
        scores=dict(payload.get("greek_scores_current") or {})
        ordered=[name for name,_ in sorted(scores.items(),key=lambda item:(-float(item[1]),item[0]))]
        payload.update(
            status="INTERRUPTED",lifecycle_state="COMPLETE",completion_reason="STREAM_STALE",
            outcome_grade="SUCCESS" if directional_success else "PARTIAL" if favorable>=partial_threshold else "FAILED",
            success_basis="DIRECTIONAL_FINAL" if directional_success else None,
            final_favorable_points=favorable,final_price=final_price,final_price_at=last_observed.isoformat(),
            seconds_observed=max(0.0,(last_observed-alerted_at).total_seconds()),
            greek_scores_at_failure=scores,
            greek_rankings_at_failure={"strongest":ordered[:1],"strong":ordered[1:2],"normal":ordered[2:4],"weak":ordered[4:5],"weakest":ordered[5:6]},
            greek_values_at_failure=dict(payload.get("greek_values_current") or {}),
        )
        row.status="INTERRUPTED";row.payload=payload
        return True

    async def outcome_attribution(self,symbol:str,per_group:int=3)->dict[str,Any]:
        async with self.sessions() as s:
            rows=(await s.execute(select(SystemOutcomeRow).where(SystemOutcomeRow.symbol==symbol.upper())
                .order_by(SystemOutcomeRow.alerted_at.desc()).limit(1000))).scalars().all()
            changed=False
            now=datetime.now(timezone.utc)
            for row in rows:
                # Do not use any(generator): it short-circuits after the first
                # changed row and can leave the rest of an old deployment's
                # overdue calls marked TRACKING.
                changed=self._reconcile_expired_outcome(row,now) or changed
                changed=self._reconcile_interrupted_gamma_outcome(row,now) or changed
            if changed:await s.commit()
        systems={}
        for system in ("PRIMARY_OPTIONS","GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2","DELTA_DYNAMICS"):
            items=[dict(row.payload) for row in rows if row.system==system]
            # Every database row has a stable primary-key/call ID. Never hide
            # a live call merely because another call shares its direction or
            # rounded entry price. Return all active calls, plus the newest
            # completed calls for history.
            active_calls=[item for item in items if str(item.get("status") or "TRACKING").upper()=="TRACKING"]
            completed_calls=[item for item in items if str(item.get("status") or "TRACKING").upper()!="TRACKING"]
            calls=sorted(
                [*active_calls,*completed_calls[:100]],
                key=lambda item:str(item.get("alerted_at") or ""),
                reverse=True,
            )
            # MFE ranks the strongest direction-adjusted follow-through. MAE is
            # negative; ascending order ranks the deepest adverse excursion.
            systems[system]={
                "highest":sorted(items,key=lambda item:float(item.get("favorable_points",0)),reverse=True)[:per_group],
                "lowest":sorted(items,key=lambda item:float(item.get("adverse_points",0)))[:per_group],
                # Match the dashboard's 100-alert window so every visible
                # alert can resolve its own nested outcome path.
                "calls":calls,
                "tracking":sum(item.get("status")=="TRACKING" for item in calls),
                "total":len(items),
                "raw_total":len(items),
                "duplicates_suppressed":0,
            }
        return {"symbol":symbol.upper(),"systems":systems}

    async def system_outcome_by_call_id(self,call_id:str)->dict[str,Any]|None:
        """Return the persisted JSON record for an exact visible call ID."""
        async with self.sessions() as s:
            row=(await s.execute(select(SystemOutcomeRow)
                .where(SystemOutcomeRow.id.like(f"{call_id}-%"))
                .order_by(SystemOutcomeRow.alerted_at.desc()).limit(1))).scalar_one_or_none()
            if row is not None and self._reconcile_expired_outcome(row,datetime.now(timezone.utc)):
                await s.commit()
        return None if row is None else dict(row.payload)

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

    async def states_between(self,symbol:str,start:datetime,end:datetime,limit:int=10000)->list[MarketState]:
        """Return the persisted provider stream in chronological order for an audit window."""
        async with self.sessions() as s:
            rows=(await s.execute(select(MarketStateRow).where(
                MarketStateRow.symbol==symbol.upper(),MarketStateRow.timestamp>=start,MarketStateRow.timestamp<=end,
            ).order_by(MarketStateRow.timestamp.asc()).limit(limit))).scalars().all()
            return [MarketState.model_validate(row.payload) for row in rows]

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
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        # create_all does not evolve existing Supabase tables.  Checking the
        # catalog first avoids issuing ADD COLUMN IF NOT EXISTS on every boot:
        # Postgres still takes an ACCESS EXCLUSIVE lock for that statement,
        # even when the column already exists.
        column_ddls={
            "zone_name":"alter table market_states add column zone_name varchar(40)",
            "zone_score":"alter table market_states add column zone_score double precision",
            "zone_confidence":"alter table market_states add column zone_confidence double precision",
            "zone_qualified":"alter table market_states add column zone_qualified boolean",
            "zone_direction":"alter table market_states add column zone_direction varchar(8)",
            "zone_normalized_greeks":"alter table market_states add column zone_normalized_greeks json",
            "zone_greek_bands":"alter table market_states add column zone_greek_bands json",
            "zone_rule_checks":"alter table market_states add column zone_rule_checks json",
        }
        index_ddls={
            "ix_market_states_zone_name":"create index ix_market_states_zone_name on market_states (zone_name)",
            "ix_market_states_zone_score":"create index ix_market_states_zone_score on market_states (zone_score)",
            "ix_market_states_zone_qualified":"create index ix_market_states_zone_qualified on market_states (zone_qualified)",
            "ix_market_states_zone_direction":"create index ix_market_states_zone_direction on market_states (zone_direction)",
        }
        if connection.dialect.name=="postgresql":
            columns=(await connection.execute(text("""
                select column_name from information_schema.columns
                where table_schema=current_schema() and table_name='market_states'
            """))).scalars().all()
            for name,ddl in column_ddls.items():
                if name not in columns:
                    await connection.execute(text(ddl))
            indexes=(await connection.execute(text("""
                select indexname from pg_indexes
                where schemaname=current_schema() and tablename='market_states'
            """))).scalars().all()
            for name,ddl in index_ddls.items():
                if name not in indexes:
                    await connection.execute(text(ddl))
    factory=async_sessionmaker(engine,expire_on_commit=False);return factory,SqlAlchemyRepository(factory)
