from datetime import datetime, timezone

from axiom.analytics.wall_intelligence import WallIntelligenceService, detect_break, tier_for


def test_wall_tier_mapping_requires_absolute_strength_for_strongest():
    assert tier_for(.7, 90, 150_000_000, .8) == "STRONGEST"
    assert tier_for(.7, 90, 99_000_000, .8) == "STRONG"
    assert tier_for(-.8, 10, 0, 0) == "WEAKEST"
    assert tier_for(0, 50, 0, 0) == "NORMAL"


def test_break_detection_uses_only_previous_snapshot():
    assert detect_break(500, 502, 501) == "BREAK_UP"
    assert detect_break(502, 500, 501) == "BREAK_DOWN"
    assert detect_break(500, 500.5, 501) is None


def test_standalone_observer_has_no_strategy_decision_and_marks_estimates():
    service=WallIntelligenceService(history_len=4)
    metrics={"call_wall_strike":501,"call_wall_gex":2_000_000,"put_wall_strike":499,"put_wall_gex":-1_000_000,
        "zero_gamma":500,"support_level":499,"resistance_level":501,"gex_walls":[{"strike":501,"gex":2_000_000},{"strike":499,"gex":-1_000_000}],"tw_gex":.8,"spoof_score":1,"edge":5}
    point,events=service.observe(datetime.now(timezone.utc),"QQQ",500,metrics,"CALM",100)
    assert point["is_point_in_time"] is True
    assert point["is_estimated_oi_delayed"] is True
    assert "decision" not in point
    assert events == []
