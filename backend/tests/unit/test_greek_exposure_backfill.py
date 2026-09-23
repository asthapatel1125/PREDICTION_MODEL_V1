from datetime import date,datetime,timezone
from types import SimpleNamespace

from axiom.jobs.backfill_greek_exposure import trading_days_ending
from axiom.infrastructure.database import merge_greek_exposure_minutes


def test_recent_sessions_skip_weekend():
    assert trading_days_ending(date(2026,9,22),5)==[
        date(2026,9,16),date(2026,9,17),date(2026,9,18),
        date(2026,9,21),date(2026,9,22),
    ]


def test_archive_fills_missing_exposures_without_replacing_live_values_or_price():
    at=datetime(2026,9,22,13,30,tzinfo=timezone.utc)
    live={"timestamp":at,"open":700.0,"close":701.0,"spot":700.5,
          "dex_signed_raw":12.0,"gamma_exposure_raw":None,
          "charm_exposure_raw":None,"speed_exposure_raw":None}
    archived=SimpleNamespace(timestamp=at,spot=699.0,dex_signed_raw=10.0,
        gamma_exposure_raw=20.0,charm_exposure_raw=30.0,speed_exposure_raw=40.0)
    [result]=merge_greek_exposure_minutes([live],[archived])
    assert result["close"]==701.0
    assert result["dex_signed_raw"]==12.0
    assert [result[key] for key in ("gamma_exposure_raw","charm_exposure_raw","speed_exposure_raw")]==[20,30,40]


def test_archive_supplies_missing_minute_without_fabricating_imbalance():
    at=datetime(2026,9,22,13,30,tzinfo=timezone.utc)
    archived=SimpleNamespace(timestamp=at,spot=700.0,dex_signed_raw=10.0,
        gamma_exposure_raw=20.0,charm_exposure_raw=30.0,speed_exposure_raw=40.0)
    [result]=merge_greek_exposure_minutes([], [archived])
    assert result["timestamp"]==at
    assert result["spot"]==700.0
    assert result["gex_imbalance_pct"] is None
