from datetime import datetime, timedelta, timezone

import pytest

from axiom.analytics.cvd_proxy import CvdProxyEngine
from axiom.analytics.imbalance import chain_imbalances, signed_imbalance
from axiom.analytics.mpi import MarketPressureEngine
from axiom.analytics.pressure_trend import PressureTrendEngine
from axiom.domain.metrics import MaxTrackerToday
from axiom.domain.scoring import ConfluenceEngine


def test_max_today_is_monotonic_and_resets_at_0400_et():
    tracker = MaxTrackerToday()
    before = datetime(2026, 8, 27, 7, 59, tzinfo=timezone.utc)  # 03:59 ET
    after = before + timedelta(minutes=1)
    assert tracker.update("gex", 10, before) == 10
    assert tracker.update("gex", 2, before) == 10
    assert tracker.update("gex", 3, after) == 3


def test_signed_chain_imbalances():
    assert signed_imbalance(75, 25) == pytest.approx(50)
    values = chain_imbalances({"positive_gex": 75, "negative_gex": -25,
        "positive_dex": 20, "negative_dex": -80, "call_volume": 60, "put_volume": 40})
    assert values == pytest.approx({"gex_imbalance_pct": 50, "dex_imbalance_pct": -60, "vol_imbalance_pct": 20})


def test_pressure_mpi_and_cvd_contracts_are_bounded_and_vectorized():
    tracker = MaxTrackerToday()
    pressure = PressureTrendEngine(tracker)
    mpi = MarketPressureEngine(tracker)
    cvd = CvdProxyEngine(tracker)
    now = datetime(2026, 8, 27, 14, tzinfo=timezone.utc)
    first = pressure.calculate("QQQ", now, 710, {"net_dealer_delta": 10, "dex": 5, "gex_raw": 8, "zero_gamma": 709})
    second = pressure.calculate("QQQ", now + timedelta(seconds=5), 711, {"net_dealer_delta": 30, "dex": 7, "gex_raw": 6, "zero_gamma": 709}, 2)
    market = mpi.calculate("QQQ", now + timedelta(seconds=5), 711, second)
    flow = cvd.calculate("QQQ", now, -100)
    assert all(0 <= second[key] <= 100 for key in ("pressure_trend", "speed_pct", "dex_pct", "gex_pct"))
    assert all(0 <= market[key] <= 100 for key in ("pressure_flow_pct", "pressure_roc_pct", "pressure_div_pct", "mpi", "mpi_trend"))
    assert market["roc_vector"] in (-1, 0, 1) and market["div_vector"] in (-1, 0, 1)
    assert flow["cvd_proxy_pct"] == -100 and flow["cvd_proxy_vector"] == -1
    assert first["pressure_trend"] != second["pressure_trend"]


def test_confluence_flags_fake_long_and_early_reversal():
    engine = ConfluenceEngine()
    base = {"spot": 712, "zero_delta": 710, "dex_pct": 80, "dex_imbalance_pct": 40,
        "pressure_trend": 75, "zero_gamma_pct": 50, "effective_gex_pct": 50,
        "mpi_trend": 80, "roc_vector": 1, "div_vector": 1, "pressure_div_pct": 70,
        "cvd_proxy_pct": 40, "cvd_proxy_vector": 1, "vol_imbalance_pct": 25, "gex_imbalance_pct": 10}
    engine.calculate("QQQ", base)
    falling = {**base, "pressure_trend": 80, "zero_gamma_pct": 60, "effective_gex_pct": 60,
        "cvd_proxy_pct": 30, "cvd_proxy_vector": -1, "vol_imbalance_pct": -20}
    result = engine.calculate("QQQ", falling)
    assert result["isFakeLong"] is True
    assert result["isEarlyReversal"] is True
    assert result["confluence_confidence"] == 75
