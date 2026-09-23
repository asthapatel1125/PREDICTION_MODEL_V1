from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Iterable

import pandas as pd


TIMEFRAME_SECONDS: dict[str, int] = {
    "1M": 60,
    "5M": 300,
    "15M": 900,
    "30M": 1_800,
    "1H": 3_600,
    "2H": 7_200,
    "4H": 14_400,
    "6H": 21_600,
}


def timeframe_seconds(timeframe: str | int) -> int:
    if isinstance(timeframe, int):
        seconds = timeframe
    else:
        key = str(timeframe).strip().upper()
        if key not in TIMEFRAME_SECONDS:
            raise ValueError(f"Unsupported candle timeframe: {timeframe}")
        seconds = TIMEFRAME_SECONDS[key]
    if seconds not in TIMEFRAME_SECONDS.values():
        raise ValueError(f"Unsupported candle timeframe: {timeframe}")
    return seconds


def _timestamp(value: Any, input_tz: str) -> pd.Timestamp:
    result = pd.Timestamp(value)
    if result.tzinfo is None:
        result = result.tz_localize(input_tz, ambiguous="raise", nonexistent="shift_forward")
    return result.tz_convert("UTC")


def _session_name(value: pd.Timestamp) -> str:
    minute = value.hour * 60 + value.minute
    if minute < 9 * 60 + 30:
        return "PRE"
    if minute < 16 * 60:
        return "RTH"
    return "POST"


def _localize_boundary(value: pd.Timestamp, exchange_tz: str) -> pd.Timestamp:
    naive = value.tz_localize(None)
    return naive.tz_localize(exchange_tz, ambiguous=False, nonexistent="shift_forward")


def _trimmed_mean(values: pd.Series) -> float:
    ordered = sorted(float(value) for value in values.dropna())
    if not ordered:
        return float("nan")
    trim = int(len(ordered) * 0.1) if len(ordered) >= 10 else 0
    retained = ordered[trim:len(ordered) - trim] if trim else ordered
    return sum(retained) / len(retained)


def candle_is_confirmed(timestamp: Any, timeframe: str | int, *, exchange_tz: str = "America/New_York", now: Any = None) -> bool:
    seconds = timeframe_seconds(timeframe)
    local_start = _timestamp(timestamp, "UTC").tz_convert(exchange_tz)
    naive_start = local_start.tz_localize(None)
    naive_end = naive_start + timedelta(seconds=int(seconds))
    day_end = naive_start.normalize() + timedelta(days=1)
    if naive_end > day_end:
        naive_end = day_end
    current = _timestamp(now or pd.Timestamp.now(tz="UTC"), "UTC").tz_convert(exchange_tz)
    return bool(current >= _localize_boundary(naive_end, exchange_tz))


def get_candles(
    rows: Iterable[dict[str, Any]],
    timeframe: str | int,
    num_candles: int = 150,
    *,
    exchange_tz: str = "America/New_York",
    input_tz: str = "UTC",
    now: datetime | pd.Timestamp | None = None,
    last_fields: tuple[str, ...] = (),
    average_fields: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    """Aggregate trade/minute rows into exchange-calendar OHLCV candles.

    Buckets are independently anchored to midnight for each exchange-local
    calendar day.  RTH, pre-market, and post-market observations are grouped
    separately so an interval crossing 09:30 or 16:00 never mixes sessions.
    """
    seconds = timeframe_seconds(timeframe)
    limit = max(1, int(num_candles))
    frame = pd.DataFrame(list(rows))
    if frame.empty or "timestamp" not in frame:
        return []

    frame = frame.copy()
    frame["timestamp"] = frame["timestamp"].map(lambda value: _timestamp(value, input_tz))
    frame = frame.dropna(subset=["timestamp"])
    dedupe = ["timestamp"] + (["trade_id"] if "trade_id" in frame else [])
    frame = frame.drop_duplicates(subset=dedupe, keep="last").sort_values("timestamp")
    if frame.empty:
        return []

    price_column = "price" if "price" in frame else "spot" if "spot" in frame else "close"
    for column in ("open", "high", "low", "close"):
        if column not in frame:
            frame[column] = frame[price_column]
    if "volume" not in frame:
        frame["volume"] = 0.0
    if "spot" not in frame:
        frame["spot"] = frame[price_column]
    for column in ("open", "high", "low", "close", "volume", "spot"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.dropna(subset=["open", "high", "low", "close"])

    frame["local_timestamp"] = frame["timestamp"].map(lambda value: value.tz_convert(exchange_tz))
    frame["local_day"] = frame["local_timestamp"].map(lambda value: value.date())
    frame["session"] = frame["local_timestamp"].map(_session_name)
    rule = f"{seconds}s"
    pieces: list[pd.DataFrame] = []
    for (_, session), group in frame.groupby(["local_day", "session"], sort=True):
        indexed = group.set_index("local_timestamp").sort_index()
        aggregations = {
            "open": ("open", "first"), "high": ("high", "max"),
            "low": ("low", "min"), "close": ("close", "last"),
            "volume": ("volume", "sum"), "spot": ("spot", _trimmed_mean),
        }
        aggregations.update({field: (field, "last") for field in last_fields if field in indexed.columns})
        aggregations.update({field: (field, _trimmed_mean) for field in average_fields if field in indexed.columns})
        candles = indexed.resample(rule, origin="start_day", label="left", closed="left").agg(
            **aggregations
        ).dropna(subset=["open", "high", "low", "close"])
        if not candles.empty:
            candles["session"] = session
            pieces.append(candles)
    if not pieces:
        return []

    candles = pd.concat(pieces).sort_index(kind="stable")
    current = _timestamp(now or pd.Timestamp.now(tz="UTC"), input_tz).tz_convert(exchange_tz)
    output: list[dict[str, Any]] = []
    for bucket_start, row in candles.tail(limit).iterrows():
        local_start = pd.Timestamp(bucket_start).tz_convert(exchange_tz)
        naive_end = local_start.tz_localize(None) + timedelta(seconds=int(seconds))
        day_end = local_start.normalize().tz_localize(None) + timedelta(days=1)
        if naive_end > day_end:
            naive_end = day_end
        session = str(row["session"])
        if session == "PRE":
            naive_end = min(naive_end, local_start.normalize().tz_localize(None) + timedelta(hours=9, minutes=30))
        elif session == "RTH":
            naive_end = min(naive_end, local_start.normalize().tz_localize(None) + timedelta(hours=16))
        local_end = _localize_boundary(naive_end, exchange_tz)
        candle = {
            "timestamp": local_start.tz_convert("UTC").isoformat(),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["volume"]),
            "spot": float(row["spot"]),
            "session": session,
            "is_confirmed": bool(current >= local_end),
        }
        for field in last_fields:
            if field in row and pd.notna(row[field]):
                value = row[field]
                candle[field] = pd.Timestamp(value).isoformat() if field == "options_at" else float(value)
        for field in average_fields:
            if field in row and pd.notna(row[field]):
                candle[field] = float(row[field])
        output.append(candle)
    return output
