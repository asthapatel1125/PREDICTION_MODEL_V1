from axiom.analytics.eod_snapshots import render_exposure_history_svg


def test_exposure_history_snapshot_renders_qqq_candles_and_level_line():
    rows=[
        {"timestamp":"2026-09-16T11:00:00+00:00","open":700,"high":702,"low":699,"close":701,"zero_gamma":698,"zero_delta":697},
        {"timestamp":"2026-09-16T11:05:00+00:00","open":701,"high":703,"low":700,"close":700.5,"zero_gamma":699,"zero_delta":697.5},
    ]
    svg=render_exposure_history_svg(rows,"zero-gamma","2026-09-16","2026-09-16",300)
    assert "QQQ UP CANDLE" in svg
    assert "QQQ DOWN CANDLE" in svg
    assert "ZERO GAMMA" in svg
    assert svg.count("<rect")>=3
    assert 'stroke="#b56cff"' in svg
