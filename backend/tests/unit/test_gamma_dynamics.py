from datetime import datetime, timedelta, timezone
from math import isfinite

import pytest

from axiom.analytics.gamma_dynamics import GammaDynamicsQuartet, GammaDynamicsSix
from axiom.domain.enums import Direction
from axiom.domain.models import Greeks


def history(count=30):
    return [Greeks(gamma=.01+i*.0001, speed=.001+i*.00001, zomma=.02+i*.0002, color=.03+i*.0003, ultima=.01+i*.0001, vomma=.015+i*.0001) for i in range(count)]


def test_gamma_dynamics_qualifies_upward_relative_pressure():
    result = GammaDynamicsQuartet(minimum_history=20).calculate(Greeks(gamma=.08, speed=.02, zomma=.2, color=.3, ultima=.08, vomma=.09), history(), "QQQ")
    assert result.qualified is True
    assert result.decision is Direction.UP
    assert result.pressure > 0
    assert set(result.inputs) == {"zomma", "color", "speed", "gamma"}
    assert set(result.normalized) == set(result.inputs)


def test_gamma_dynamics_v2_adds_vomma_and_ultima():
    metrics = chain_metrics(atm_iv=.22, atm_iv_available=1)
    result=GammaDynamicsSix().calculate(
        Greeks(gamma=.08,speed=.02,zomma=.2,color=.3,ultima=.08,vomma=.09),history(),"QQQ",
        metrics, metric_history(), active_time(),
    )
    # V2 intentionally needs a complete 720 five-second-tick baseline.
    assert result.qualified is False
    assert result.alert_checks["baseline"] is False
    assert set(result.inputs)=={"zomma","color","speed","gamma","vomma","ultima"}
    assert result.ideal_ranges["ultima"]
    assert result.ideal_ranges["vomma"]
    assert len(set(result.ideal_ranges.values())) == 6
    assert result.target_price == pytest.approx(500.75)
    assert result.chain_metrics["key_fault_line"] == 500
    assert result.alert_checks["liquidity"] is True
    assert result.chain_metrics["iv_expansion"] == pytest.approx(.10)


def test_gamma_dynamics_v2_requires_speed_gamma_directional_confluence():
    result=GammaDynamicsSix().calculate(
        Greeks(gamma=-.08,speed=.02,zomma=.2,color=.3,ultima=.08,vomma=.09),history(),"QQQ",
        chain_metrics(weighted_charm=0, net_dealer_delta=0), metric_history(), active_time(),
    )
    assert result.qualified is False
    assert result.decision is Direction.NEUTRAL


def active_time():
    return datetime(2026, 7, 16, 14, 45, tzinfo=timezone.utc)


def chain_metrics(**overrides):
    values = {
        "chain_available": 1, "spot": 500, "key_fault_line": 500,
        "gamma_squeeze_score": 100, "weighted_charm": 100,
        "weighted_speed": 100, "weighted_vanna": 100, "weighted_color": -100,
        "net_dealer_delta": 100, "atm_spread": .10, "liquidity_available": 1,
        "bad_liquidity": 0,
    }
    return {**values, **overrides}


def metric_history(count=20):
    return [
        {
            "gamma_squeeze_score": index, "weighted_charm": index,
            "weighted_speed": index, "weighted_vanna": index,
            "weighted_color": index, "net_dealer_delta": index, "atm_iv": .20,
        }
        for index in range(count)
    ]


def test_gamma_dynamics_v2_enforces_ten_minute_cooldown():
    # Keep this test focused on cooldown rather than the production warm-up.
    engine = GammaDynamicsSix(minimum_history=20)
    qualifying = chain_metrics(
        # This produces a 400M rolling DealerFlow proxy from the same
        # unit-consistent VolHack calculation; a 1B GEX change only produces
        # ~4M here and should correctly fail the 300M inventory gate.
        gex_raw=100_000_000_000, gamma_open_interest=1, color_ex=0, speed_ex=0,
        gex_density=1, gex_dollar_density=200_000_000, support_level=499,
        resistance_level=501, dex=-1_000, charm_ex=1_000, liquidity_score=.1,
    )
    history_metrics = [
        {"gex_raw": 0, "spot": 500, "observed_epoch": 5, "gex_density": 1, "atm_iv": .20}
        for _ in range(20)
    ]
    first = engine.calculate(Greeks(), history(), "QQQ", qualifying, history_metrics, active_time())
    second = engine.calculate(Greeks(), history(), "QQQ", qualifying, history_metrics, active_time() + timedelta(minutes=1))
    assert first.qualified is True
    assert second.qualified is False
    assert second.alert_checks["cooldown"] is False


def test_gamma_dynamics_v2_keeps_live_chain_levels_and_scores_finite():
    """Charm exposure must never turn discrete chain strikes into e+6 levels."""
    engine=GammaDynamicsSix(minimum_history=2)
    current=chain_metrics(
        gex_raw=1_174_000_000, gamma_open_interest=1_000_000, color_ex=500,
        speed_ex=2_000, gex_density=.084, gex_dollar_density=425_000_000,
        support_level=730, resistance_level=735, dex=-1_000, charm_ex=-5e12,
        total_open_interest=2_000_000, concentration=.5, liquidity_score=.1,
    )
    previous=[
        {"gex_raw":1_170_000_000,"spot":732,"observed_epoch":5,"gex_density":.08,"gamma_open_interest":1_000_000,"dex":-900,"color_ex":500,"speed_ex":2_000,"atm_iv":.2},
        {"gex_raw":1_172_000_000,"spot":732.1,"observed_epoch":10,"gex_density":.082,"gamma_open_interest":1_000_000,"dex":-950,"color_ex":500,"speed_ex":2_000,"atm_iv":.2},
    ]
    result=engine.calculate(Greeks(),history(),"QQQ",current,previous,active_time())
    metrics=result.chain_metrics
    assert metrics["ksup_t10"]==730
    assert metrics["kres_t10"]==735
    assert metrics["amp_score"]>=0
    assert metrics["dr"]>=0
    assert 0<=metrics["dr_t10"]<=1
    assert isfinite(metrics["fade_score"])
    assert isfinite(metrics["amp_score"])
    assert isfinite(metrics["final_score_clean"])
    assert metrics["score_integrity"]==1


def test_gamma_dynamics_qualifies_downward_relative_pressure():
    result = GammaDynamicsQuartet(minimum_history=20).calculate(Greeks(gamma=-.08, speed=-.02, zomma=.2, color=.3), history(), "QQQ")
    assert result.qualified is True
    assert result.decision is Direction.DOWN
    assert result.pressure < 0


def test_gamma_dynamics_waits_when_gamma_and_speed_disagree():
    result = GammaDynamicsQuartet(minimum_history=20).calculate(Greeks(gamma=.08, speed=-.02, zomma=.2, color=.3), history(), "QQQ")
    assert result.qualified is False
    assert result.decision is Direction.NEUTRAL


def test_gamma_dynamics_waits_during_warmup():
    result = GammaDynamicsQuartet(minimum_history=20).calculate(Greeks(gamma=.08, speed=.02, zomma=.2, color=.3), history(5), "QQQ")
    assert result.qualified is False


def test_normalization_preserves_real_sub_picounit_greek_variation():
    samples = [Greeks(gamma=.02 + index * 1e-14, speed=.001, zomma=.14, color=-.71) for index in range(20)]
    current = Greeks(gamma=.02 + 30e-14, speed=.001, zomma=.14, color=-.71)
    result = GammaDynamicsQuartet(minimum_history=20).calculate(current, samples, "QQQ")
    assert result.normalized["gamma"] > 0
