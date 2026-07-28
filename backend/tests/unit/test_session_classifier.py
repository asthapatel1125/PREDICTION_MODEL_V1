from datetime import datetime, timedelta, timezone

from axiom.analytics.session_classifier import IntradaySessionClassifier
from axiom.domain.models import Greeks, MarketBar


def bar(timestamp: datetime, index: int = 0, sign: int = 1) -> MarketBar:
    price = 500 + index * .25
    return MarketBar(
        timestamp=timestamp, symbol="QQQ", timeframe_seconds=60,
        open=price-.1, high=price+.3, low=price-.2, close=price,
        volume=1000+index*100, bid_ask_spread=.02,
        greeks=Greeks(gamma=sign*(.1+index*.01),vanna=sign*(.2+index*.01),
            charm=sign*(.15+index*.01)),
    )


def test_clock_gates_exclude_impossible_sessions_and_handle_dst():
    classifier=IntradaySessionClassifier()
    # 10:00 a.m. EDT. Power hour can never be eligible here.
    timestamp=datetime(2026,7,27,14,0,tzinfo=timezone.utc)
    assert classifier.eligible_sessions(timestamp)==["OPENING","LATE_MORNING"]
    assert classifier._clock_session(timestamp)=="LATE_MORNING"


def test_transition_requires_configured_persistence():
    classifier=IntradaySessionClassifier({
        "transition_threshold":0,
        "separation_threshold":0,
        "minimum_confirmations":0,
        "persistence_bars":3,
    })
    opening=datetime(2026,7,27,13,45,tzinfo=timezone.utc)
    history=[bar(opening+timedelta(minutes=index),index) for index in range(15)]
    classifier.calculate(history[-1],history[:-1])
    for index in range(3):
        current=bar(datetime(2026,7,27,14,index,tzinfo=timezone.utc),20+index)
        result=classifier.calculate(current,history)
    assert result["detected_session"]=="LATE_MORNING"
    assert result["session_state"]=="CONFIRMED"
    assert result["weight_status"]=="INITIAL_HYPOTHESIS_NOT_BACKTESTED"


def test_vanna_is_not_used_directionally_without_iv_change():
    classifier=IntradaySessionClassifier()
    start=datetime(2026,7,27,13,30,tzinfo=timezone.utc)
    history=[bar(start+timedelta(minutes=index),index) for index in range(20)]
    result=classifier.calculate(bar(start+timedelta(minutes=20),21),history)
    assert result["directional_votes"]["vanna"]==0
    assert result["effective_directional_weights"]["vanna"]==0
    assert result["data_limitations"]["atm_iv_change_available"] is False


def test_configured_early_close_moves_power_hour_and_closes_at_one():
    classifier=IntradaySessionClassifier({"early_close_dates":["2026-11-27"]})
    assert "POWER_HOUR" in classifier.eligible_sessions(datetime(2026,11,27,17,0,tzinfo=timezone.utc))
    assert classifier.eligible_sessions(datetime(2026,11,27,18,1,tzinfo=timezone.utc))==[]
