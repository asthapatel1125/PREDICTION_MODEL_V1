from axiom.analytics.nasdaq_range_atlas import build_range_atlas


def test_range_atlas_serves_precomputed_month_endpoints():
    levels = [
        {"month": "2025-12", "nas100_high": 200.0, "nas100_low": 100.0, "nas100_range": 100.0,
         "qqq_high": 60.0, "qqq_low": 49.0, "qqq_range": 11.0, "slope": 0.11,
         "intercept": 38.0, "qqq_observations": 22},
        {"month": "2026-01", "nas100_high": 300.0, "nas100_low": 200.0, "nas100_range": 100.0,
         "qqq_high": 72.0, "qqq_low": 61.0, "qqq_range": 11.0, "slope": 0.11,
         "intercept": 39.0, "qqq_observations": 21},
    ]
    atlas = build_range_atlas(levels)
    mapped, latest = atlas["levels"]
    assert mapped["qqq_high"] == 60.0
    assert mapped["qqq_low"] == 49.0
    assert mapped["slope"] == 0.11
    assert mapped["cohort"] == "recent"
    assert latest["cohort"] == "latest"
    assert latest["calibrated"] is True
    assert atlas["calibrated_count"] == 2
