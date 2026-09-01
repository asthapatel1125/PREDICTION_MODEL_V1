from datetime import datetime, timezone

from axiom.analytics.nasdaq_range_atlas import build_range_atlas


def test_range_atlas_maps_month_endpoints_and_refuses_missing_months():
    levels = [
        {"month": "2025-12", "nas100_high": 200.0, "nas100_low": 100.0, "nas100_range": 100.0},
        {"month": "2026-01", "nas100_high": 300.0, "nas100_low": 200.0, "nas100_range": 100.0},
    ]
    rows = [
        {"last_trade": datetime(2025, 12, 2, tzinfo=timezone.utc), "high": 55.0, "low": 49.0},
        {"last_trade": datetime(2025, 12, 31, tzinfo=timezone.utc), "high": 60.0, "low": 50.0},
    ]
    atlas = build_range_atlas(levels, rows)
    mapped, missing = atlas["levels"]
    assert mapped["qqq_high"] == 60.0
    assert mapped["qqq_low"] == 49.0
    assert mapped["slope"] == 0.11
    assert mapped["cohort"] == "recent"
    assert missing["cohort"] == "latest"
    assert missing["calibrated"] is False
    assert "qqq_high" not in missing
    assert atlas["calibrated_count"] == 1
