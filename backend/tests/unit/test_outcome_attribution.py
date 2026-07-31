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
        gamma_dynamics=SimpleNamespace(
            qualified=True, decision=direction, intensity=.8, intensity_threshold=.65,
            pressure=.7 if direction == Direction.UP else -.7,
            inputs={"speed": .3, "gamma": .2, "zomma": .6, "color": .4},
            model_dump=lambda **_: {},
        ),
        supporting_indicators={"price": price},
    )


def test_qqq_target_uses_nyse_regular_hours():
    tracker = OutcomeAttributionTracker()
    assert tracker._target_spec("QQQ", datetime(2026, 7, 27, 13, 29, tzinfo=timezone.utc))["target_points"] == .25
    assert tracker._target_spec("QQQ", datetime(2026, 7, 27, 13, 30, tzinfo=timezone.utc))["target_points"] == 1.25
    assert tracker._target_spec("QQQ", datetime(2026, 7, 27, 19, 59, tzinfo=timezone.utc))["target_points"] == 1.25
    assert tracker._target_spec("QQQ", datetime(2026, 7, 27, 20, 0, tzinfo=timezone.utc))["target_points"] == .25


def test_long_gamma_tracks_one_minute_ohlc_and_fifty_point_target():
    tracker = OutcomeAttributionTracker(horizon_minutes=30, cooldown_seconds=300)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(state(start, 500), EngineMode.LIVE, 500, "TWELVE_DATA", start)
    assert len(created) == 1
    signal_id = created[0]["id"]
    assert created[0]["call_id"] == "2026072710300000003"
    assert signal_id == "2026072710300000003-QQQ"

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


def test_flicker_does_not_open_duplicate_same_direction_call():
    tracker = OutcomeAttributionTracker(horizon_minutes=30, cooldown_seconds=300)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    first = tracker.process(state(start, 500), EngineMode.LIVE, 500, "THETADATA", start)
    first_id = first[0]["id"]
    tracker.process(
        state(start + timedelta(seconds=5), 501, Direction.NEUTRAL),
        EngineMode.LIVE, 501, "THETADATA", start + timedelta(seconds=5),
    )
    updates = tracker.process(
        state(start + timedelta(seconds=10), 502, Direction.UP),
        EngineMode.LIVE, 502, "THETADATA", start + timedelta(seconds=10),
    )
    assert {item["id"] for item in updates} == {first_id}
    assert len(tracker._active) == 1


def test_unreached_call_expires_at_horizon_with_last_observed_values():
    tracker = OutcomeAttributionTracker(horizon_minutes=30)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(state(start, 500), EngineMode.LIVE, 500, "THETADATA", start)
    signal_id = created[0]["id"]
    last_time = start + timedelta(minutes=29, seconds=55)
    tracker.process(state(last_time, 512), EngineMode.LIVE, 512, "THETADATA", last_time)
    updates = tracker.process(
        state(start + timedelta(minutes=30, seconds=5), 560),
        EngineMode.LIVE, 560, "THETADATA", start + timedelta(minutes=30, seconds=5),
    )
    record = next(item for item in updates if item["id"] == signal_id)
    assert record["status"] == "EXPIRED"
    assert record["final_price"] == 512
    assert record["highest_price"] == 512
    assert record["target_reached_at"] is None
    assert record["target_shortfall_points"] == 38
    assert signal_id not in tracker._active


def test_target_touch_exactly_at_expiry_counts():
    tracker = OutcomeAttributionTracker(horizon_minutes=30)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(state(start, 500), EngineMode.LIVE, 500, "THETADATA", start)
    signal_id = created[0]["id"]
    expiry = start + timedelta(minutes=30)
    updates = tracker.process(state(expiry, 550), EngineMode.LIVE, 550, "THETADATA", expiry)
    record = next(item for item in updates if item["id"] == signal_id)
    assert record["status"] == "TARGET_REACHED"
    assert record["target_reached_at"] == expiry
    assert record["target_reached_price"] == 550


def test_long_risk_family_activates_zero_four_six_eight_once():
    tracker = OutcomeAttributionTracker(horizon_minutes=60)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(state(start, 500), EngineMode.LIVE, 500, "THETADATA", start)
    signal_id = created[0]["id"]

    updates = tracker.process(
        state(start + timedelta(minutes=1), 492),
        EngineMode.LIVE, 492, "THETADATA", start + timedelta(minutes=1),
    )
    record = next(item for item in updates if item["id"] == signal_id)
    assert [leg["datum"] for leg in record["family_legs"]] == [500, 496, 494, 492]
    assert [leg["call_id"] for leg in record["family_legs"]] == [
        f"{record['call_id']}.1",
        f"{record['call_id']}.1.2",
        f"{record['call_id']}.1.3",
        f"{record['call_id']}.1.4",
    ]
    assert record["family_average_datum"] == 495.5
    assert record["family_average_pl_points"] == -3.5
    assert record["family_next_trigger_points"] is None

    updates = tracker.process(
        state(start + timedelta(minutes=2), 497),
        EngineMode.LIVE, 497, "THETADATA", start + timedelta(minutes=2),
    )
    record = next(item for item in updates if item["id"] == signal_id)
    assert len(record["family_legs"]) == 4
    assert record["family_average_pl_points"] == 1.5
    assert record["family_outcome_state"] == "PROFIT"
    assert [leg["current_pl_points"] for leg in record["family_legs"]] == [-3, 1, 3, 5]
    assert [leg["status"] for leg in record["family_legs"]] == [
        "FAILED", "SUCCEEDED", "SUCCEEDED", "SUCCEEDED",
    ]
    assert record["expires_at"] == start + timedelta(minutes=60)


def test_short_risk_family_mirrors_adverse_triggers():
    tracker = OutcomeAttributionTracker(horizon_minutes=60)
    start = datetime(2026, 7, 27, 14, 30, tzinfo=timezone.utc)
    created = tracker.process(
        state(start, 500, Direction.DOWN), EngineMode.LIVE, 500, "THETADATA", start
    )
    signal_id = created[0]["id"]
    updates = tracker.process(
        state(start + timedelta(minutes=1), 508, Direction.DOWN),
        EngineMode.LIVE, 508, "THETADATA", start + timedelta(minutes=1),
    )
    record = next(item for item in updates if item["id"] == signal_id)
    assert [leg["datum"] for leg in record["family_legs"]] == [500, 504, 506, 508]
    assert record["family_average_datum"] == 504.5
    assert record["family_average_pl_points"] == -3.5

    updates = tracker.process(
        state(start + timedelta(minutes=2), 503, Direction.DOWN),
        EngineMode.LIVE, 503, "THETADATA", start + timedelta(minutes=2),
    )
    record = next(item for item in updates if item["id"] == signal_id)
    assert len(record["family_legs"]) == 4
    assert record["family_average_pl_points"] == 1.5
    assert record["family_outcome_state"] == "PROFIT"
