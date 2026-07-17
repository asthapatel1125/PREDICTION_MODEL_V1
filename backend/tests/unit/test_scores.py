from axiom.analytics.scores import DirectionScore,ExplosionScore

from conftest import make_bar


def test_direction_score_range_and_audit_payload():
    bars=[make_bar(i) for i in range(20)];result=DirectionScore().calculate(bars[-1],bars[:-1])
    assert -3<=result.value<=3
    assert set(result.inputs)=={"gamma","vanna","charm"}
    assert result.explanation and 0<=result.confidence<=1


def test_explosion_is_bounded(config):
    bars=[make_bar(i) for i in range(80)];result=ExplosionScore(config.score_weights["explosion"]).calculate(bars[-1],bars[:-1])
    assert 0<=result.value<=1
    assert set(result.components)==set(config.score_weights["explosion"])

