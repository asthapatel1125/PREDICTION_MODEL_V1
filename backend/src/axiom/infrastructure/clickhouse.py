from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import UTC, date, datetime
from typing import Any

import httpx


def _literal(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


class ClickHouseRepository:
    """Small async HTTP adapter for the private Render ClickHouse service."""

    def __init__(self, host: str, port: int, database: str, user: str, password: str, secure: bool = False):
        scheme = "https" if secure else "http"
        self.url = f"{scheme}://{host}:{port}/"
        self.database = database
        self.auth = (user, password)

    async def _request(self, sql: str, *, body: bytes | None = None, timeout: float = 60.0) -> str:
        params = {"database": self.database, "query": sql}
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(self.url, params=params, content=body, auth=self.auth)
            if response.is_error:
                detail=response.text.strip()[:2_000]
                raise httpx.HTTPStatusError(
                    f"ClickHouse returned {response.status_code}: {detail}",
                    request=response.request,response=response,
                )
            return response.text

    async def ping(self) -> bool:
        try:
            return (await self._request("SELECT 1", timeout=5.0)).strip() == "1"
        except httpx.HTTPError:
            return False

    async def ensure_exposure_history(self) -> None:
        await self._request("""
            CREATE TABLE IF NOT EXISTS exposure_history
            (
                symbol LowCardinality(String),
                timestamp DateTime64(3, 'America/New_York'),
                interval_seconds UInt16,
                qqq_price Float64,
                zero_gamma Nullable(Float64),
                zero_gamma_raw Nullable(Float64),
                zero_gamma_confidence Float32,
                zero_gamma_method LowCardinality(String),
                zero_delta Nullable(Float64),
                zero_delta_method LowCardinality(String),
                contract_count UInt32,
                calculated_at DateTime64(3, 'UTC') DEFAULT now64(3)
            )
            ENGINE = ReplacingMergeTree(calculated_at)
            PARTITION BY toYYYYMM(timestamp)
            ORDER BY (symbol, interval_seconds, timestamp)
        """)

    async def exposure_history_ready(self) -> bool:
        try:
            await self._request("SELECT 1 FROM exposure_history LIMIT 0", timeout=5.0)
            return True
        except httpx.HTTPError:
            return False

    async def exposure_inputs(self, symbol: str, session_date: date, interval_seconds: int = 60) -> list[dict[str, Any]]:
        # Reduce the five-second raw chain inside ClickHouse first.  Only the
        # final real observation for each contract/bucket crosses the network.
        day = session_date.isoformat()
        sql = f"""
            SELECT
                symbol, expiration, strike, right,
                bucket AS timestamp,
                argMax(delta, source_timestamp) AS delta,
                argMax(gamma, source_timestamp) AS gamma,
                argMax(implied_vol, source_timestamp) AS implied_volatility,
                argMax(underlying_price, source_timestamp) AS underlying_price,
                any(oi.open_interest) AS open_interest
            FROM
            (
                SELECT
                    symbol, expiration, strike, right,
                    toStartOfInterval(timestamp, INTERVAL {int(interval_seconds)} SECOND) AS bucket,
                    timestamp AS source_timestamp, delta, gamma, implied_vol, underlying_price
                FROM option_exposure_inputs
                WHERE symbol = {_literal(symbol.upper())}
                  AND toDate(timestamp) = toDate({_literal(day)})
            ) AS inputs
            LEFT ANY JOIN
            (
                SELECT symbol, expiration, strike, right, argMax(open_interest, timestamp) AS open_interest
                FROM option_open_interest
                WHERE symbol = {_literal(symbol.upper())}
                  AND toDate(timestamp) = toDate({_literal(day)})
                GROUP BY symbol, expiration, strike, right
            ) AS oi USING (symbol, expiration, strike, right)
            GROUP BY symbol, expiration, strike, right, bucket
            ORDER BY bucket, expiration, strike, right
            FORMAT JSONEachRow
        """
        text = await self._request(sql, timeout=180.0)
        return [json.loads(line) for line in text.splitlines() if line]

    async def replace_exposure_day(self, symbol: str, session_date: date, rows: Iterable[dict[str, Any]], interval_seconds: int) -> None:
        # ReplacingMergeTree makes reruns idempotent: the newer calculated_at
        # version wins under FINAL without a mutation racing the fresh insert.
        payload = b"".join((json.dumps(row, separators=(",", ":")) + "\n").encode() for row in rows)
        if payload:
            await self._request("INSERT INTO exposure_history FORMAT JSONEachRow", body=payload, timeout=180.0)

    async def exposure_history(self, symbol: str, days: int, interval_seconds: int) -> list[dict[str, Any]]:
        sql = f"""
            WITH selected_days AS
            (
                SELECT toDate(timestamp) AS day
                FROM exposure_history FINAL
                WHERE symbol={_literal(symbol.upper())} AND interval_seconds=60
                GROUP BY day ORDER BY day DESC LIMIT {max(1, min(int(days), 365))}
            )
            SELECT
                toUnixTimestamp(bucket) * 1000 AS timestamp_ms,
                argMax(qqq_price, timestamp) AS spot,
                argMax(zero_gamma, timestamp) AS zero_gamma,
                argMax(zero_delta, timestamp) AS zero_delta,
                argMax(zero_gamma_raw, timestamp) AS zero_gamma_raw,
                argMax(zero_gamma_confidence, timestamp) AS zero_gamma_confidence,
                argMax(zero_gamma_method, timestamp) AS zero_gamma_method,
                argMax(zero_delta_method, timestamp) AS zero_delta_method,
                argMax(contract_count, timestamp) AS contract_count
            FROM
            (
                SELECT *, toStartOfInterval(timestamp, INTERVAL {max(60, int(interval_seconds))} SECOND) AS bucket
                FROM exposure_history FINAL
                WHERE symbol={_literal(symbol.upper())} AND interval_seconds=60
                  AND toDate(timestamp) IN (SELECT day FROM selected_days)
            )
            GROUP BY bucket ORDER BY bucket
            FORMAT JSONEachRow
        """
        text = await self._request(sql, timeout=30.0)
        result=[]
        for line in text.splitlines():
            if not line:
                continue
            item=json.loads(line)
            timestamp=datetime.fromtimestamp(int(item["timestamp_ms"])/1000.0,UTC).isoformat()
            result.append({
                "timestamp":timestamp, "spot":item["spot"], "source":"CLICKHOUSE_BACKFILL",
                "walls":{
                    "ZERO_GAMMA":{"strike":item["zero_gamma"],"raw_strike":item["zero_gamma_raw"],"confidence":item["zero_gamma_confidence"],"method":item["zero_gamma_method"]},
                    "ZERO_DELTA":{"strike":item["zero_delta"],"method":item["zero_delta_method"]},
                },
                "contract_count":item["contract_count"],
            })
        return result

    async def _legacy_exposure_candles(self, symbol: str, days: int, interval_seconds: int, limit: int = 2500, before: datetime | None = None) -> list[dict[str, Any]]:
        """Return server-aggregated QQQ candles with closing exposure levels.

        Only the compact QQQ and exposure-history tables are read.  The raw
        option chain is deliberately not referenced, keeping this safe on the
        512 MB ClickHouse service.
        """
        interval = max(60, min(int(interval_seconds), 43200))
        before_sql = f"AND timestamp < toDateTime64({_literal(before.isoformat())}, 3, 'UTC')" if before else ""
        days_filter = f"AND toDate(timestamp) IN (SELECT day FROM (SELECT toDate(timestamp) AS day FROM exposure_history FINAL WHERE symbol = {_literal(symbol.upper())} AND interval_seconds = 60 GROUP BY day ORDER BY day DESC LIMIT {max(1, min(int(days), 365))}))"
        session_start = "toDateTime(toDate(timestamp), 'America/New_York') + INTERVAL 9 HOUR + INTERVAL 30 MINUTE"
        bucket = f"{session_start} + toIntervalSecond(intDiv(toUnixTimestamp(timestamp) - toUnixTimestamp({session_start}), {interval}) * {interval})"
        sql = f"""
            WITH
                qqq AS
                (
                    SELECT
                        {bucket} AS bucket,
                        timestamp,
                        price
                    FROM qqq_history
                    WHERE timestamp >= toDateTime('2000-01-01 00:00:00', 'America/New_York')
                      AND toTime(timestamp) >= toTime('09:30:00')
                      AND toTime(timestamp) < toTime('16:00:00')
                      {days_filter}
                      {before_sql}
                ),
                qqq_candles AS
                (
                    SELECT bucket, argMin(price, timestamp) AS open,
                           max(price) AS high, min(price) AS low,
                           argMax(price, timestamp) AS close
                    FROM qqq GROUP BY bucket
                ),
                levels AS
                (
                    SELECT
                        {bucket} AS bucket,
                        argMax(zero_gamma, timestamp) AS zero_gamma,
                        argMax(zero_delta, timestamp) AS zero_delta
                    FROM exposure_history FINAL
                    WHERE symbol = {_literal(symbol.upper())}
                      AND interval_seconds = 60
                      {days_filter}
                      {before_sql}
                    GROUP BY bucket
                )
            SELECT q.bucket AS timestamp, q.open, q.high, q.low, q.close,
                   l.zero_gamma, l.zero_delta
            FROM qqq_candles AS q
            LEFT JOIN levels AS l ON q.bucket = l.bucket
            ORDER BY q.bucket DESC
            LIMIT {max(1, min(int(limit), 2500))}
            FORMAT JSONEachRow
        """
        text = await self._request(sql, timeout=45.0)
        rows = [json.loads(line) for line in text.splitlines() if line]
        rows.reverse()
        for row in rows:
            row["timestamp"] = datetime.fromisoformat(str(row["timestamp"]).replace("Z", "+00:00")).isoformat()
        return rows

    async def exposure_candles(self, symbol: str, days: int, interval_seconds: int, limit: int = 2500) -> list[dict[str, Any]]:
        """Return session-anchored QQQ OHLC candles with closing ZG/ZD levels.

        Both source tables are compact.  Bucketing happens in ClickHouse and
        only the requested display candles cross the network.
        """
        bucket_seconds=max(60,min(int(interval_seconds),86_400))
        row_limit=max(30,min(int(limit),20_000))
        day_limit=max(1,min(int(days),365))
        symbol_literal=_literal(symbol.upper())
        sql=f"""
            WITH
                selected_days AS
                (
                    SELECT toDate(timestamp) AS day
                    FROM exposure_history FINAL
                    WHERE symbol={symbol_literal} AND interval_seconds=60
                    GROUP BY day ORDER BY day DESC LIMIT {day_limit}
                ),
                origin AS toDateTime('1970-01-01 09:30:00','America/New_York')
            SELECT * FROM
            (
                SELECT
                    toUnixTimestamp(q.bucket) * 1000 AS timestamp_ms,
                    q.open AS open, q.high AS high, q.low AS low, q.close AS close,
                    e.zero_gamma AS zero_gamma, e.zero_delta AS zero_delta
                FROM
                (
                    SELECT
                        if({bucket_seconds}=86400,
                           toDateTime(toDate(timestamp),'America/New_York') + INTERVAL 9 HOUR + INTERVAL 30 MINUTE,
                           toDateTime(toDate(timestamp),'America/New_York') + INTERVAL 9 HOUR + INTERVAL 30 MINUTE
                             + toIntervalSecond(intDiv(toUnixTimestamp(timestamp) - toUnixTimestamp(toDateTime(toDate(timestamp),'America/New_York') + INTERVAL 9 HOUR + INTERVAL 30 MINUTE), {bucket_seconds}) * {bucket_seconds})) AS bucket,
                        argMin(price,timestamp) AS open,
                        max(price) AS high,
                        min(price) AS low,
                        argMax(price,timestamp) AS close
                    FROM exposure_history FINAL
                    WHERE symbol={symbol_literal}
                      AND interval_seconds=60
                      AND toDate(timestamp) IN (SELECT day FROM selected_days)
                      AND toTime(timestamp) >= toTime('09:30:00')
                      AND toTime(timestamp) <= toTime('16:00:00')
                    GROUP BY bucket
                ) AS q
                LEFT JOIN
                (
                    SELECT
                        if({bucket_seconds}=86400,
                           toDateTime(toDate(timestamp),'America/New_York') + INTERVAL 9 HOUR + INTERVAL 30 MINUTE,
                           toDateTime(toDate(timestamp),'America/New_York') + INTERVAL 9 HOUR + INTERVAL 30 MINUTE
                             + toIntervalSecond(intDiv(toUnixTimestamp(timestamp) - toUnixTimestamp(toDateTime(toDate(timestamp),'America/New_York') + INTERVAL 9 HOUR + INTERVAL 30 MINUTE), {bucket_seconds}) * {bucket_seconds})) AS bucket,
                        argMax(zero_gamma,timestamp) AS zero_gamma,
                        argMax(zero_delta,timestamp) AS zero_delta
                    FROM exposure_history FINAL
                    WHERE symbol={symbol_literal} AND interval_seconds=60
                      AND toDate(timestamp) IN (SELECT day FROM selected_days)
                      AND toTime(timestamp) >= toTime('09:30:00')
                      AND toTime(timestamp) <= toTime('16:00:00')
                    GROUP BY bucket
                ) AS e USING bucket
                ORDER BY q.bucket DESC
                LIMIT {row_limit}
            )
            ORDER BY timestamp_ms
            FORMAT JSONEachRow
            SETTINGS max_threads=1, max_memory_usage=100000000
        """
        text=await self._request(sql,timeout=30.0)
        result=[]
        for line in text.splitlines():
            if not line:
                continue
            item=json.loads(line)
            result.append({
                "timestamp":datetime.fromtimestamp(int(item["timestamp_ms"])/1000.0,UTC).isoformat(),
                "open":item["open"],"high":item["high"],"low":item["low"],"close":item["close"],
                "zero_gamma":item.get("zero_gamma"),"zero_delta":item.get("zero_delta"),
            })
        return result
