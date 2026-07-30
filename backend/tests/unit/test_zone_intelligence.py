from datetime import datetime, timezone

import pytest

from axiom.analytics.zone_intelligence import ZoneIntelligenceEngine
from axiom.domain.models import Greeks


def test_normalization_uses_clipped_three_sigma_scale():
    engine = ZoneIntelligenceEngine()
    assert engine._scaled(100, [-1, 0, 1]) == 1.0
    assert engine._scaled(-100, [-1, 0, 1]) == -1.0
    assert engine._scaled(1, [1, 1, 1]) == 0.0


@pytest.mark.parametrize(
    ("hour","minute","expected"),
    [(8,0,"PRE_MARKET"),(9,30,"OPENING_AUCTION"),(9,45,"OPENING_RANGE"),
     (10,15,"OPENING_DRIVE"),(12,30,"MIDDAY"),(15,55,"CLOSING_IMBALANCE"),
     (16,0,"CLOSING_AUCTION")],
)
def test_eastern_time_windows_and_overlap_priority(hour, minute, expected):
    engine = ZoneIntelligenceEngine()
    # July is EDT, so Eastern = UTC - 4.
    timestamp = datetime(2026,7,15,hour+4,minute,tzinfo=timezone.utc)
    windows = engine._windows(timestamp)
    assert expected in windows


def test_midday_rule_formula_is_exact():
    values={"ultima":0.1,"zomma":0.7,"gamma":0.7,"speed":0.1,"color":0.7,"delta":0.1}
    rules=ZoneIntelligenceEngine._rules(values,0,0,False)["MIDDAY"]
    assert all(passed for _,passed in rules)


def test_zone_payload_contains_normalized_bands_and_checks():
    engine=ZoneIntelligenceEngine(minimum_history=2)
    history=[Greeks(delta=-1,gamma=-1,speed=-1,color=-1,zomma=-1,ultima=-1),
             Greeks(delta=0,gamma=0,speed=0,color=0,zomma=0,ultima=0)]
    result=engine.calculate(Greeks(delta=1,gamma=1,speed=1,color=1,zomma=1,ultima=1),
        history,datetime(2026,7,15,16,30,tzinfo=timezone.utc),"QQQ")
    assert set(result.normalized)=={"ultima","zomma","gamma","speed","color","delta"}
    assert set(result.bands)==set(result.normalized)
    assert result.active_windows==["MIDDAY"]
    assert "MIDDAY" in result.rule_checks
