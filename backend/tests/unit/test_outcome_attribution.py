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


def test_long_momentum_tracks_favorable_and_adverse_excursions():
    tracker = OutcomeAttributionTracker(horizon_minutes=30, cooldown_seconds=300)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(state(start, 500), EngineMode.LIVE, 500, "TWELVE_DATA", start)
    assert len(created) == 1
    signal_id = created[0]["id"]
    assert created[0]["call_id"] == "2026072710300000002"
    assert signal_id == "2026072710300000002-QQQ"

    high_time = start + timedelta(minutes=2)
    tracker.process(state(high_time, 507), EngineMode.LIVE, 507, "TWELVE_DATA", high_time)
    low_time = start + timedelta(minutes=3)
    updates = tracker.process(state(low_time, 497), EngineMode.LIVE, 497, "TWELVE_DATA", low_time)
    record = next(item for item in updates if item["id"] == signal_id)

    assert record["favorable_points"] == 7
    assert record["adverse_points"] == -3
    assert record["seconds_to_high"] == 120
    assert record["seconds_to_low"] == 180
    assert record["turning_highs"][0]["price"] == 507
    assert record["turning_highs"][0]["matched_call"] is True
    assert record["turning_highs"][0]["success_leading_greek"]
    assert record["turning_highs"][0]["strongest_greek"]
    assert record["turning_highs"][0]["weakest_greek"]
    assert record["turning_highs"][0]["decay_greek"]


def test_turning_low_is_confirmed_only_after_an_upward_reversal():
    tracker = OutcomeAttributionTracker(horizon_minutes=30, cooldown_seconds=300)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(state(start, 500), EngineMode.LIVE, 500, "THETADATA", start)
    signal_id = created[0]["id"]
    tracker.process(state(start + timedelta(seconds=5), 499), EngineMode.LIVE, 499, "THETADATA", start + timedelta(seconds=5))
    tracker.process(state(start + timedelta(seconds=10), 498), EngineMode.LIVE, 498, "THETADATA", start + timedelta(seconds=10))
    updates = tracker.process(state(start + timedelta(seconds=15), 498.2), EngineMode.LIVE, 498.2, "THETADATA", start + timedelta(seconds=15))
    record = next(item for item in updates if item["id"] == signal_id)
    assert record["turning_lows"][0]["price"] == 498
    assert record["turning_lows"][0]["confirmed_at"] == start + timedelta(seconds=15)
