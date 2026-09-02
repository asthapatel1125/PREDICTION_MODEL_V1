import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from axiom.application.direction_gate import DailyDirectionGate, gate_expiry
from axiom.analytics.outcome_attribution import OutcomeAttributionTracker
from axiom.infrastructure.database import ConfigurationRow, SqlAlchemyRepository


def test_persist_restart_refresh_expiry_and_explicit_change(tmp_path):
    async def run():
        engine=create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'gate.db'}")
        async with engine.begin() as conn:
            await conn.run_sync(ConfigurationRow.__table__.create)
        repository=SqlAlchemyRepository(async_sessionmaker(engine,expire_on_commit=False))
        first=OutcomeAttributionTracker()
        service=DailyDirectionGate(repository,[first],"America/New_York")
        morning=datetime(2026,9,2,14,tzinfo=timezone.utc)
        saved=await service.set("LONG_ONLY",morning)
        assert saved["expires_at"]=="2026-09-02T18:00:00-04:00"
        # A fresh tracker/service represents another worker or a Render restart.
        second=OutcomeAttributionTracker()
        restored=DailyDirectionGate(repository,[second],"America/New_York")
        assert (await restored.sync(morning))["mode"]=="LONG_ONLY"
        assert second.direction_gate=="LONG_ONLY"
        await service.set("SHORT_ONLY",morning)
        assert (await restored.sync(morning))["mode"]=="SHORT_ONLY"
        before=datetime(2026,9,2,21,59,59,tzinfo=timezone.utc)
        assert (await restored.sync(before))["mode"]=="SHORT_ONLY"
        closing=datetime(2026,9,2,22,tzinfo=timezone.utc)
        assert (await restored.sync(closing))["mode"]=="BOTH"
        assert (await restored.sync(datetime(2026,9,3,14,tzinfo=timezone.utc)))["mode"]=="BOTH"
        await engine.dispose()
    asyncio.run(run())


def test_session_expiry_observes_eastern_dst_and_weekends():
    assert gate_expiry(datetime(2026,12,2,15,tzinfo=timezone.utc),"America/New_York").isoformat()=="2026-12-02T18:00:00-05:00"
    assert gate_expiry(datetime(2026,9,4,23,tzinfo=timezone.utc),"America/New_York").isoformat()=="2026-09-07T18:00:00-04:00"


def test_failed_save_does_not_acknowledge_or_change_gate():
    class BrokenRepository:
        async def save_direction_gate(self,payload):raise RuntimeError("database unavailable")
    tracker=OutcomeAttributionTracker()
    service=DailyDirectionGate(BrokenRepository(),[tracker],"America/New_York")
    with pytest.raises(RuntimeError):asyncio.run(service.set("LONG_ONLY"))
    assert tracker.direction_gate=="BOTH"


def test_blocked_direction_keeps_existing_leg_marks_but_creates_no_child():
    record={"entry_price":700,"direction":"UP","system":"GAMMA_DYNAMICS",
            "family_legs":[{"datum":700,"trigger_adverse_points":0}]}
    now=datetime(2026,9,2,14,tzinfo=timezone.utc)
    OutcomeAttributionTracker._update_risk_family(record,690,now,None,allow_new_children=False)
    assert len(record["family_legs"])==1
    assert record["family_legs"][0]["current_pl_points"]==-10
