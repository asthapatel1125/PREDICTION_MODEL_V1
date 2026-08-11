from datetime import datetime, timedelta, timezone

import pytest

from axiom.analytics.gamma_dynamics import GammaDynamicsQuartet, GammaDynamicsSix
from axiom.domain.enums import Direction
from axiom.domain.models import Greeks


def history(count=30):
    return [Greeks(gamma=.01+i*.0001, speed=.001+i*.00001, zomma=.02+i*.0002, color=.03+i*.0003, ultima=.01+i*.0001, vomma=.015+i*.0001) for i in range(count)]


def test_gamma_dynamics_qualifies_upward_relative_pressure():
    result = GammaDynamicsQuartet().calculate(Greeks(gamma=.08, speed=.02, zomma=.2, color=.3, ultima=.08, vomma=.09), history(), "QQQ")
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
    first = engine.calculate(Greeks(), history(), "QQQ", chain_metrics(), metric_history(), active_time())
    second = engine.calculate(Greeks(), history(), "QQQ", chain_metrics(), metric_history(), active_time() + timedelta(minutes=1))
    assert first.qualified is True
    assert second.qualified is False
    assert second.alert_checks["cooldown"] is False


def test_gamma_dynamics_qualifies_downward_relative_pressure():
    result = GammaDynamicsQuartet().calculate(Greeks(gamma=-.08, speed=-.02, zomma=.2, color=.3), history(), "QQQ")
    assert result.qualified is True
    assert result.decision is Direction.DOWN
    assert result.pressure < 0


def test_gamma_dynamics_waits_when_gamma_and_speed_disagree():
    result = GammaDynamicsQuartet().calculate(Greeks(gamma=.08, speed=-.02, zomma=.2, color=.3), history(), "QQQ")
    assert result.qualified is False
    assert result.decision is Direction.NEUTRAL


def test_gamma_dynamics_waits_during_warmup():
    result = GammaDynamicsQuartet().calculate(Greeks(gamma=.08, speed=.02, zomma=.2, color=.3), history(5), "QQQ")
    assert result.qualified is False


def test_normalization_preserves_real_sub_picounit_greek_variation():
    samples = [Greeks(gamma=.02 + index * 1e-14, speed=.001, zomma=.14, color=-.71) for index in range(20)]
    current = Greeks(gamma=.02 + 30e-14, speed=.001, zomma=.14, color=-.71)
    result = GammaDynamicsQuartet().calculate(current, samples, "QQQ")
    assert result.normalized["gamma"] > 0
