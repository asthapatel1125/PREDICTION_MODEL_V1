from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from axiom.domain.models import Greeks, MarketBar
from axiom.ports.interfaces import MarketDataPort


class ThetaDataProtocolError(RuntimeError):
    pass


class ThetaDataV3Client(MarketDataPort):
    """ThetaData Options Pro adapter for direct Python or local Terminal access."""

    def __init__(self, base_url: str = "http://127.0.0.1:25503/v3", timeout: float = 60,
                 api_key: str | None = None, transport: str = "python", max_dte: int = 7,
                 strike_range: int = 30, market_timezone: str = "America/New_York"):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.api_key = api_key
        self.transport = transport.lower()
        self.max_dte = max_dte
        self.strike_range = strike_range
        self.market_tz = ZoneInfo(market_timezone)
        self._client: Any = None

    def _python_client(self) -> Any:
        if self._client is None:
            try:
                from thetadata import ThetaClient
            except ImportError as exc:
                raise ThetaDataProtocolError("Install thetadata>=1.0.9 for direct API access") from exc
            if not self.api_key:
                raise ThetaDataProtocolError("THETADATA_API_KEY is required for direct ThetaData access")
            self._client = ThetaClient(api_key=self.api_key)
        return self._client

    async def _python_rows(self, method: str, **params: Any) -> list[dict[str, Any]]:
        result = await asyncio.wait_for(
            asyncio.to_thread(lambda: getattr(self._python_client(), method)(**params)),
            timeout=self.timeout,
        )
        if hasattr(result, "to_dicts"):
            return result.to_dicts()
        if hasattr(result, "to_dict"):
            return list(result.to_dict(orient="records"))
        if isinstance(result, list):
            return [row for row in result if isinstance(row, dict)]
        raise ThetaDataProtocolError(f"{method} returned an unsupported dataframe type")

    async def _terminal_rows(self, path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(f"{self.base_url}{path}", params={**params, "format": "json"})
            response.raise_for_status()
            return self._rows(response.json())

    async def _snapshot_rows(self, symbol: str) -> list[dict[str, Any]]:
        params = {"symbol": symbol.upper(), "expiration": "*", "strike": "*", "right": "both",
                  "max_dte": self.max_dte, "strike_range": self.strike_range}
        if self.transport == "terminal":
            rows = await self._terminal_rows("/option/snapshot/greeks/all", {**params, "use_market_value": True})
            oi = await self._terminal_rows("/option/snapshot/open_interest", params)
        else:
            rows = await self._python_rows("option_snapshot_greeks_all", **params, use_market_value=True)
            oi = await self._python_rows("option_snapshot_open_interest", **params)
        self._merge_open_interest(rows, oi)
        if rows:
            snapshot_time=max(self._timestamp(row) for row in rows)
            for row in rows:row["_bucket_timestamp"]=snapshot_time
        return rows

    async def historical_bars(self, symbol: str, start: datetime, end: datetime,
                              resolution_seconds: int) -> AsyncIterator[MarketBar]:
        interval = self._interval(resolution_seconds)
        cursor = start.astimezone(self.market_tz).date()
        final = end.astimezone(self.market_tz).date()
        rows: list[dict[str, Any]] = []
        while cursor <= final:
            if cursor.weekday() < 5:
                params: dict[str, Any] = {
                    "symbol": symbol.upper(), "expiration": "*", "strike": "*", "right": "both",
                    "date": cursor, "interval": interval, "max_dte": self.max_dte,
                    "strike_range": self.strike_range,
                    "start_time": start.astimezone(self.market_tz).strftime("%H:%M:%S") if cursor == start.astimezone(self.market_tz).date() else "09:30:00",
                    "end_time": end.astimezone(self.market_tz).strftime("%H:%M:%S") if cursor == end.astimezone(self.market_tz).date() else "16:00:00",
                }
                if self.transport == "terminal":
                    terminal_params = {key: value.strftime("%Y%m%d") if isinstance(value, date) else value for key, value in params.items()}
                    try:day_rows=await self._terminal_rows("/option/history/greeks/all", terminal_params)
                    except httpx.HTTPStatusError:
                        terminal_params["expiration"]=cursor.strftime("%Y%m%d")
                        day_rows=await self._terminal_rows("/option/history/greeks/all", terminal_params)
                else:
                    try:day_rows=await self._python_rows("option_history_greeks_all", **params)
                    except Exception:
                        params["expiration"]=cursor
                        day_rows=await self._python_rows("option_history_greeks_all", **params)
                if not day_rows and params.get("expiration")=="*":
                    params["expiration"]=cursor
                    day_rows=(await self._python_rows("option_history_greeks_all", **params)) if self.transport!="terminal" else day_rows
                rows.extend(day_rows)
            cursor += timedelta(days=1)
        for bar in self._aggregate(rows, symbol, resolution_seconds):
            if start <= bar.timestamp <= end:
                yield bar

    async def live_bars(self, symbol: str, resolution_seconds: int) -> AsyncIterator[MarketBar]:
        last_timestamp: datetime | None = None
        while True:
            bars = self._aggregate(await self._snapshot_rows(symbol), symbol, resolution_seconds)
            if not bars:
                raise ThetaDataProtocolError("No ThetaData snapshot rows; market may be closed or symbol unavailable")
            bar = bars[-1]
            if last_timestamp is None or bar.timestamp > last_timestamp:
                last_timestamp = bar.timestamp
                yield bar
            await asyncio.sleep(resolution_seconds)

    @staticmethod
    def _merge_open_interest(rows: list[dict[str, Any]], oi_rows: list[dict[str, Any]]) -> None:
        def key(row: dict[str, Any]) -> tuple[str, str, str]:
            return str(row.get("expiration", "")), str(row.get("strike", "")), str(row.get("right", "")).lower()
        lookup = {key(row): row.get("open_interest", 0) for row in oi_rows}
        for row in rows:
            row["open_interest"] = lookup.get(key(row), row.get("open_interest", 0))

    @staticmethod
    def _rows(payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            return [row for row in payload if isinstance(row, dict)]
        if isinstance(payload, dict):
            for key in ("response", "data", "results"):
                if isinstance(payload.get(key), list):
                    return [row for row in payload[key] if isinstance(row, dict)]
        raise ThetaDataProtocolError("ThetaData response did not contain object rows")

    def _aggregate(self, rows: list[dict[str, Any]], symbol: str, resolution_seconds: int) -> list[MarketBar]:
        buckets: dict[int, list[dict[str, Any]]] = {}
        for row in rows:
            ts = self._timestamp(row)
            buckets.setdefault(int(ts.timestamp()) // resolution_seconds, []).append(row)
        result: list[MarketBar] = []
        for group in (buckets[key] for key in sorted(buckets)):
            ts = max(self._timestamp(row) for row in group)
            weights = [max(self._number(row.get("open_interest") or row.get("volume") or 1), 1) for row in group]
            total = sum(weights)
            signed = [(row, weight, 1 if str(row.get("right", "")).lower() in {"call", "c"} else -1)
                      for row, weight in zip(group, weights)]
            def exposure(name: str) -> float:
                return sum(self._number(row.get(name)) * weight * sign for row, weight, sign in signed) / total
            latest = max(group, key=self._timestamp)
            price = self._number(latest.get("underlying_price") or latest.get("stock_price") or latest.get("price"))
            if price <= 0:
                continue
            spreads = [max(0.0, self._number(row.get("ask")) - self._number(row.get("bid"))) for row in group]
            result.append(MarketBar(timestamp=ts, symbol=symbol, timeframe_seconds=resolution_seconds,
                open=price, high=price, low=price, close=price,
                volume=sum(self._number(row.get("volume")) for row in group),
                bid_ask_spread=sum(spreads) / max(len(spreads), 1),
                greeks=Greeks(**{name: exposure(name) for name in Greeks.model_fields})))
        return result

    def _timestamp(self, row: dict[str, Any]) -> datetime:
        value = row.get("_bucket_timestamp") or row.get("timestamp") or row.get("datetime") or row.get("underlying_timestamp")
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, (int, float)):
            parsed = datetime.fromtimestamp(value / 1000 if value > 10**12 else value, tz=timezone.utc)
        elif isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            raise ThetaDataProtocolError("Row missing timestamp")
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=self.market_tz)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _number(value: Any) -> float:
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _interval(seconds: int) -> str:
        supported = {1, 5, 10, 15, 30, 60, 300, 600, 900, 1800, 3600}
        nearest = min(supported, key=lambda value: abs(value - seconds))
        return f"{nearest // 60}m" if nearest >= 60 else f"{nearest}s"
