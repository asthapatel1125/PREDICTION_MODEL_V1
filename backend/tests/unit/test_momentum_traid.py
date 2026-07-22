from axiom.analytics.momentum_triad import NQMomentumTriad
from axiom.domain.enums import Direction
from axiom.domain.models import Greeks


def test_momentum_triad_long_when_all_three_are_positive():
    result = NQMomentumTriad().calculate(Greeks(zomma=.2, speed=.1, delta=.3), "QQQ")
    assert result.aligned is True
    assert result.decision is Direction.UP
    assert result.votes == {"zomma": 1, "speed": 1, "delta": 1}


def test_momentum_triad_short_when_all_three_are_negative():
    result = NQMomentumTriad().calculate(Greeks(zomma=-.2, speed=-.1, delta=-.3), "NDX")
    assert result.aligned is True
    assert result.decision is Direction.DOWN


def test_momentum_triad_waits_on_disagreement_or_zero():
    mixed = NQMomentumTriad().calculate(Greeks(zomma=.2, speed=-.1, delta=.3), "QQQ")
    zero = NQMomentumTriad().calculate(Greeks(zomma=.2, speed=.1, delta=0), "QQQ")
    assert mixed.decision is Direction.NEUTRAL and not mixed.aligned
    assert zero.decision is Direction.NEUTRAL and not zero.aligned
