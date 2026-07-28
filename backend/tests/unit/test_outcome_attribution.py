from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from axiom.analytics.outcome_attribution import OutcomeAttributionTracker
from axiom.domain.enums import Direction, EngineMode
from axiom.domain.models import Greeks


def state(timestamp: datetime, price: float, direction: Direction = Direction.UP):
    greeks = Greeks(delta=.4, gamma=.2, vanna=.1, charm=.05, speed=.3, zomma=.6, color=.4, ultima=.2)
    return SimpleNamespace(
        timestamp=timestamp, symbol="QQQ", greeks=greeks,
        options_bias_qualified=False, options_bias=Direction.NEUTRAL,
        momentum_triad=SimpleNamespace(
            aligned=True, decision=direction,
            acceleration=.6 if direction == Direction.UP else -.6,
            direction=.3 if direction == Direction.UP else -.3,
            confirmation=.4 if direction == Direction.UP else -.4,
        ),
        gamma_dynamics=SimpleNamespace(qualified=False, decision=Direction.NEUTRAL),
        supporting_indicators={"price": price},
    )


def test_long_momentum_tracks_one_minute_ohlc_and_fifty_point_target():
    tracker = OutcomeAttributionTracker(horizon_minutes=30, cooldown_seconds=300)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(state(start, 500), EngineMode.LIVE, 500, "TWELVE_DATA", start)
    assert len(created) == 1
    signal_id = created[0]["id"]
    assert created[0]["call_id"] == "2026072710300000002"
    assert signal_id == "2026072710300000002-QQQ"

    tracker.process(state(start + timedelta(seconds=5), 507), EngineMode.LIVE, 507, "TWELVE_DATA", start + timedelta(seconds=5))
    tracker.process(state(start + timedelta(seconds=10), 497), EngineMode.LIVE, 497, "TWELVE_DATA", start + timedelta(seconds=10))
    target_time = start + timedelta(minutes=2,seconds=5)
    updates = tracker.process(state(target_time, 550), EngineMode.LIVE, 550, "TWELVE_DATA", target_time)
    record = next(item for item in updates if item["id"] == signal_id)

    assert record["favorable_points"] == 50
    assert record["adverse_points"] == -3
    assert record["target_reached_price"] == 550
    assert record["seconds_to_target"] == 125
    assert record["target_touch_type"] == "OPEN"
    assert record["minute_bars"][0] == {
        "timestamp": start.replace(second=0,microsecond=0),
        "open":500,"high":507,"low":497,"close":497,"samples":3,
    }
    assert record["strongest_greek_at_target"]
    assert record["weakest_greek_at_target"]


def test_short_target_is_recorded_as_intraminute_low():
    tracker = OutcomeAttributionTracker(horizon_minutes=30, cooldown_seconds=300)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(state(start, 500,Direction.DOWN), EngineMode.LIVE, 500, "THETADATA", start)
    signal_id = created[0]["id"]
    updates = tracker.process(state(start + timedelta(seconds=5), 450,Direction.DOWN), EngineMode.LIVE, 450, "THETADATA", start + timedelta(seconds=5))
    record = next(item for item in updates if item["id"] == signal_id)
    assert record["target_reached_price"] == 450
    assert record["target_touch_type"] == "LOW"
    assert record["minute_bars"][0]["low"] == 450
