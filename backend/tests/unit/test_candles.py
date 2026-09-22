from datetime import datetime, timezone

from axiom.analytics.candles import get_candles


def _row(timestamp: str, price: float, volume: float = 1, trade_id: str | None = None):
    row = {"timestamp": timestamp, "price": price, "volume": volume}
    if trade_id is not None:
        row["trade_id"] = trade_id
    return row


def _local_hours(candles):
    from zoneinfo import ZoneInfo
    return [datetime.fromisoformat(row["timestamp"]).astimezone(ZoneInfo("America/New_York")).hour for row in candles]


def test_dst_spring_forward_uses_clock_hour_boundaries():
    rows = [_row("2024-03-10T06:15:00Z", 100), _row("2024-03-10T07:15:00Z", 101)]
    assert _local_hours(get_candles(rows, "1H", now=datetime(2024, 3, 11, tzinfo=timezone.utc))) == [1, 3]
    assert _local_hours(get_candles(rows, "2H", now=datetime(2024, 3, 11, tzinfo=timezone.utc))) == [0, 3]


def test_fifteen_minute_bucket_floors_093112_to_0930():
    candles = get_candles([_row("2026-09-17T13:31:12Z", 100)], "15M", now=datetime(2026, 9, 18, tzinfo=timezone.utc))
    local = datetime.fromisoformat(candles[0]["timestamp"]).astimezone(__import__("zoneinfo").ZoneInfo("America/New_York"))
    assert (local.hour, local.minute, local.second) == (9, 30, 0)


def test_six_hour_day_has_exact_calendar_boundaries():
    rows = [_row(f"2026-09-17T{hour:02d}:05:00Z", 100 + hour) for hour in (4, 10, 16, 22)]
    candles = get_candles(rows, "6H", now=datetime(2026, 9, 18, 12, tzinfo=timezone.utc))
    assert _local_hours(candles) == [0, 6, 12, 18]


def test_current_partial_candle_is_returned_unconfirmed():
    candles = get_candles([_row("2026-09-17T14:17:00Z", 100)], "15M", now=datetime(2026, 9, 17, 14, 18, tzinfo=timezone.utc))
    assert len(candles) == 1
    assert candles[0]["is_confirmed"] is False


def test_duplicate_timestamp_and_trade_id_volume_is_not_double_counted():
    rows = [_row("2026-09-17T14:01:00Z", 100, 5, "a"), _row("2026-09-17T14:01:00Z", 100, 5, "a")]
    candles = get_candles(rows, "5M", now=datetime(2026, 9, 18, tzinfo=timezone.utc))
    assert candles[0]["volume"] == 5


def test_options_fields_keep_last_snapshot_in_calendar_candle():
    rows = [
        {"timestamp": "2026-09-17T14:01:00Z", "spot": 700, "dex_signed_raw": 1_000_000,
         "gamma_exposure_raw": 2_000_000, "charm_exposure_raw": 30, "speed_exposure_raw": 4,
         "gex_imbalance_pct": 10, "options_at": "2026-09-17T14:01:15Z"},
        {"timestamp": "2026-09-17T14:03:00Z", "spot": 701, "dex_signed_raw": 1_100_000,
         "gamma_exposure_raw": 2_100_000, "charm_exposure_raw": 35, "speed_exposure_raw": 5,
         "gex_imbalance_pct": 20, "options_at": "2026-09-17T14:03:20Z"},
    ]
    [candle] = get_candles(rows, "5M", now=datetime(2026, 9, 18, tzinfo=timezone.utc),
        last_fields=("dex_signed_raw", "gamma_exposure_raw", "charm_exposure_raw", "speed_exposure_raw", "gex_imbalance_pct", "options_at"))
    assert candle["dex_signed_raw"] == 1_100_000
    assert candle["gamma_exposure_raw"] == 2_100_000
    assert candle["charm_exposure_raw"] == 35
    assert candle["speed_exposure_raw"] == 5
    assert candle["gex_imbalance_pct"] == 20
    assert candle["options_at"].startswith("2026-09-17T14:03:20")
