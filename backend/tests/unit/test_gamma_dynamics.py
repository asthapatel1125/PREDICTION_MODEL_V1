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
    result=GammaDynamicsSix().calculate(Greeks(gamma=.08,speed=.02,zomma=.2,color=.3,ultima=.08,vomma=.09),history(),"QQQ")
    assert result.qualified is True
    assert set(result.inputs)=={"zomma","color","speed","gamma","vomma","ultima"}
    assert result.ideal_ranges["ultima"]
    assert result.ideal_ranges["vomma"]
    assert len(set(result.ideal_ranges.values())) == 6


def test_gamma_dynamics_v2_requires_speed_gamma_directional_confluence():
    result=GammaDynamicsSix().calculate(Greeks(gamma=-.08,speed=.02,zomma=.2,color=.3,ultima=.08,vomma=.09),history(),"QQQ")
    assert result.qualified is False
    assert result.decision is Direction.NEUTRAL


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
