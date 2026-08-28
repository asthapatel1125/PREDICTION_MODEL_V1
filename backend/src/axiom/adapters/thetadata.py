from __future__ import annotations

import asyncio
import re
from collections import deque
from collections.abc import AsyncIterator
from datetime import date, datetime, time, timedelta, timezone
from itertools import pairwise
from math import exp, isfinite, log, pi, sqrt
from statistics import median
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
                 strike_range: int = 30, market_timezone: str = "America/New_York",
                 poll_seconds: float = 5.0, open_interest_cache_seconds: float = 900.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.api_key = api_key
        self.transport = transport.lower()
        self.max_dte = max_dte
        self.strike_range = strike_range
        self.market_tz = ZoneInfo(market_timezone)
        self.poll_seconds = poll_seconds
        # OI is published on a delayed cadence.  Re-fetching a full OI chain
        # with every five-second Greek snapshot duplicates the largest payload
        # without making the calculation more current.
        self.open_interest_cache_seconds = open_interest_cache_seconds
        self._open_interest_cache: dict[str, tuple[datetime, list[dict[str, Any]]]] = {}
        self._zero_gamma_history: dict[str, deque[float]] = {}
        self._zero_gamma_ema: dict[str, float] = {}
        self._wall_candidate_history: dict[tuple[str, str], deque[float]] = {}
        self._wall_selected: dict[tuple[str, str], float] = {}
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
            return self._normalize_rows(result.to_dicts())
        if hasattr(result, "to_dict"):
            return self._normalize_rows(list(result.to_dict(orient="records")))
        if isinstance(result, list):
            return self._normalize_rows(result)
        raise ThetaDataProtocolError(f"{method} returned an unsupported dataframe type")

    async def _terminal_rows(self, path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(f"{self.base_url}{path}", params={**params, "format": "json"})
            response.raise_for_status()
            return self._normalize_rows(self._rows(response.json()))

    async def _snapshot_rows(self, symbol: str) -> list[dict[str, Any]]:
        params = {"symbol": symbol.upper(), "expiration": "*", "strike": "*", "right": "both",
                  "max_dte": self.max_dte, "strike_range": self.strike_range}
        cache_key = symbol.upper()
        cached_at, cached_oi = self._open_interest_cache.get(cache_key, (datetime.min.replace(tzinfo=timezone.utc), []))
        oi_is_fresh = cached_oi and (datetime.now(timezone.utc) - cached_at).total_seconds() < self.open_interest_cache_seconds
        if self.transport == "terminal":
            rows = await self._terminal_rows("/option/snapshot/greeks/all", {**params, "use_market_value": True})
            oi = cached_oi if oi_is_fresh else await self._terminal_rows("/option/snapshot/open_interest", params)
        else:
            rows = await self._python_rows("option_snapshot_greeks_all", **params, use_market_value=True)
            oi = cached_oi if oi_is_fresh else await self._python_rows("option_snapshot_open_interest", **params)
        if not oi_is_fresh:
            self._open_interest_cache[cache_key] = (datetime.now(timezone.utc), oi)
        self._merge_open_interest(rows, oi)
        self._require_all_greek_orders(rows)
        if rows:
            # This is the time Axiom observed a complete snapshot. Provider contract
            # timestamps may remain unchanged for quiet contracts and must not stop
            # the live feed from recording the next successful poll.
            snapshot_time=datetime.now(timezone.utc)
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
        loop = asyncio.get_running_loop()
        next_poll = loop.time()
        last_timestamp: datetime | None = None
        repeated_snapshot_polls = 0
        while True:
            bars = self._aggregate(await self._snapshot_rows(symbol), symbol, resolution_seconds)
            if not bars:
                raise ThetaDataProtocolError("No ThetaData snapshot rows; market may be closed or symbol unavailable")
            bar = bars[-1]
            if last_timestamp is not None and bar.timestamp <= last_timestamp:
                repeated_snapshot_polls += 1
                if repeated_snapshot_polls >= 3:
                    raise ThetaDataProtocolError(
                        f"ThetaData snapshot timestamp has not advanced since {bar.timestamp.isoformat()}; refusing to recycle stale chain data"
                    )
            else:
                last_timestamp = bar.timestamp
                repeated_snapshot_polls = 0
            yield bar
            # Provider polling is intentionally independent from chart/bar resolution.
            next_poll += self.poll_seconds
            await asyncio.sleep(max(0.0, next_poll - loop.time()))

    @staticmethod
    def _merge_open_interest(rows: list[dict[str, Any]], oi_rows: list[dict[str, Any]]) -> None:
        def expiration(value: Any) -> str:
            if isinstance(value, (date, datetime)):
                return value.strftime("%Y%m%d")
            return re.sub(r"[^0-9]", "", str(value))
        def strike(value: Any) -> str:
            try:return format(float(value), ".8f").rstrip("0").rstrip(".")
            except (TypeError, ValueError):return str(value).strip().lower()
        def right(value: Any) -> str:
            value=str(value).strip().lower()
            return "c" if value in {"c","call"} else "p" if value in {"p","put"} else value
        def key(row: dict[str, Any]) -> tuple[str, str, str]:
            return expiration(row.get("expiration", "")),strike(row.get("strike", "")),right(row.get("right", ""))
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

    @staticmethod
    def _normalize_key(value: Any) -> str:
        key = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(value)).strip().lower()
        return re.sub(r"[^a-z0-9]+", "_", key).strip("_")

    @classmethod
    def _normalize_rows(cls, rows: list[Any]) -> list[dict[str, Any]]:
        normalized_rows: list[dict[str, Any]] = []
        for source in rows:
            if not isinstance(source, dict):
                continue
            row = {cls._normalize_key(key): value for key, value in source.items()}
            for container in ("greeks", "quote", "contract", "underlying"):
                nested = row.get(container)
                if isinstance(nested, dict):
                    for key, value in nested.items():
                        row.setdefault(cls._normalize_key(key), value)
            normalized_rows.append(row)
        return normalized_rows

    @classmethod
    def _require_all_greek_orders(cls, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        # Speed and Color have deterministic fallbacks below when a provider
        # snapshot omits a third-order field. The remaining fields are required
        # because neither the UI nor the Gamma Dynamics formulas can recover
        # them safely from other values.
        missing = [name for name in Greeks.model_fields if name not in {"speed", "color"}
                   if not any(cls._optional_number(row.get(name)) is not None for row in rows)]
        if missing:
            raise ThetaDataProtocolError(
                "ThetaData all-Greeks snapshot is missing numeric fields: " + ", ".join(missing)
            )

    @classmethod
    def _require_live_first_order_values(cls, rows: list[dict[str, Any]]) -> None:
        """Reject provider placeholder snapshots instead of persisting fake flat lines."""
        if not rows:
            return
        diagnostics: dict[str, tuple[int, int, float, float]] = {}
        for name in ("delta", "theta", "vega", "rho"):
            values = [value for row in rows if (value := cls._optional_number(row.get(name))) is not None]
            diagnostics[name] = (
                len(values),
                sum(abs(value) > 1e-15 for value in values),
                min(values, default=0.0),
                max(values, default=0.0),
            )
        if all(nonzero == 0 for _, nonzero, _, _ in diagnostics.values()):
            details = "; ".join(
                f"{name}: numeric={numeric}, nonzero={nonzero}, range=[{low:.3g},{high:.3g}]"
                for name, (numeric, nonzero, low, high) in diagnostics.items()
            )
            raise ThetaDataProtocolError(
                "ThetaData returned an all-zero first-order Greek snapshot; refusing to persist placeholder data. "
                + details
            )

    def _aggregate(self, rows: list[dict[str, Any]], symbol: str, resolution_seconds: int) -> list[MarketBar]:
        buckets: dict[int, list[dict[str, Any]]] = {}
        for row in rows:
            ts = self._timestamp(row)
            buckets.setdefault(int(ts.timestamp()) // resolution_seconds, []).append(row)
        result: list[MarketBar] = []
        for group in (buckets[key] for key in sorted(buckets)):
            ts = max(self._timestamp(row) for row in group)
            latest = max(group, key=self._timestamp)
            price = self._number(latest.get("underlying_price") or latest.get("stock_price") or latest.get("price"))
            if price <= 0:
                continue
            self._hydrate_third_order_fallbacks(group, price)
            weights = [max(self._number(row.get("open_interest") or row.get("volume") or 1), 1) for row in group]
            weighted = list(zip(group, weights))
            def exposure(name: str) -> float:
                available = [(value, weight) for row, weight in weighted
                             if (value := self._optional_number(row.get(name))) is not None]
                if not available:
                    raise ThetaDataProtocolError(f"ThetaData group is missing numeric {name} values")
                valid_weight = sum(weight for _, weight in available)
                # Preserve ThetaData's native sign. Applying another universal
                # call/put sign would change the provider values and double-sign
                # Greeks such as put delta/rho.
                return sum(value * weight for value, weight in available) / valid_weight
            spreads = [max(0.0, self._number(row.get("ask")) - self._number(row.get("bid"))) for row in group]
            result.append(MarketBar(timestamp=ts, symbol=symbol, timeframe_seconds=resolution_seconds,
                open=price, high=price, low=price, close=price,
                volume=sum(self._number(row.get("volume")) for row in group),
                bid_ask_spread=sum(spreads) / max(len(spreads), 1),
                greeks=Greeks(**{name: exposure(name) for name in Greeks.model_fields}),
                contract_count=len(group),
                open_interest=sum(self._number(row.get("open_interest")) for row in group),
                gamma_metrics=self._gamma_metrics(group, price, ts, symbol),
                # The current bar carries raw contracts only long enough for
                # the live engine to persist one audit snapshot per minute.
                gamma_ticks=self._gamma_ticks(group, symbol, price, ts)))
        return result

    @classmethod
    def _gamma_ticks(cls, rows: list[dict[str, Any]], symbol: str, spot: float,
                     observed_at: datetime) -> list[dict[str, Any]]:
        """Return the complete per-contract chain snapshot without aggregation."""
        ticks=[]
        for row in rows:
            strike=cls._optional_number(row.get("strike"))
            if strike is None or strike <= 0:
                continue
            bid_size=cls._number(row.get("bid_size")); ask_size=cls._number(row.get("ask_size"))
            expiration=str(row.get("expiration") or "")
            expiry_date=cls._expiration_date(expiration)
            # The contract expires at the regular-session close for the
            # purposes of a short-dated risk gate.  This is deliberately not
            # an options-pricing clock; it only prevents already-expired data
            # from entering Gamma 3.0.
            expiry_at=(datetime.combine(expiry_date,time(16,0),tzinfo=ZoneInfo("America/New_York")) if expiry_date else None)
            observed_et=observed_at.astimezone(ZoneInfo("America/New_York"))
            years_to_expiry=max(0.0,(expiry_at-observed_et).total_seconds()/(365.25*24*60*60)) if expiry_at else 0.0
            ticks.append({
                "timestamp": observed_at, "symbol": symbol.upper(), "expiration": expiration,
                "right": str(row.get("right") or "").upper(), "strike": strike,
                "open_interest": cls._number(row.get("open_interest")), "gamma": cls._number(row.get("gamma")),
                "delta": cls._number(row.get("delta")), "speed": cls._number(row.get("speed")),
                "vomma": cls._number(row.get("vomma")), "color": cls._number(row.get("color")),
                "charm": cls._number(row.get("charm")),
                "bid": cls._number(row.get("bid")), "ask": cls._number(row.get("ask")),
                "bid_size": bid_size, "ask_size": ask_size, "underlying_price": spot,
                "depth": bid_size + ask_size, "volume": cls._number(row.get("volume")),
                "implied_volatility": cls._number(row.get("implied_volatility") or row.get("implied_vol") or row.get("iv")),
                "time_to_expiry_years": years_to_expiry,
            })
        return ticks

    @classmethod
    def _hydrate_third_order_fallbacks(cls, rows: list[dict[str, Any]], spot: float) -> None:
        """Fill only missing Speed/Color with the specification's fallbacks."""
        by_surface: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in rows:
            key = (str(row.get("expiration", "")), str(row.get("right", "")))
            by_surface.setdefault(key, []).append(row)
        for surface in by_surface.values():
            ordered = sorted(surface, key=lambda row: cls._number(row.get("strike")))
            for index, row in enumerate(ordered):
                if cls._optional_number(row.get("speed")) is None and 0 < index < len(ordered) - 1:
                    previous, following = ordered[index - 1], ordered[index + 1]
                    denominator = cls._number(following.get("strike")) - cls._number(previous.get("strike"))
                    if abs(denominator) > 1e-12:
                        row["speed"] = (
                            cls._number(following.get("gamma")) - cls._number(previous.get("gamma"))
                        ) / denominator
                if cls._optional_number(row.get("speed")) is None:
                    row["speed"] = 0.0
                if cls._optional_number(row.get("color")) is None:
                    row["color"] = -cls._number(row.get("theta")) * cls._number(row.get("gamma")) / max(spot, 1e-12)

    def _repriced_zero_gamma(self, rows: list[dict[str, Any]], spot: float,
                             observed_at: datetime, symbol: str) -> dict[str, Any]:
        """Solve the nearest signed-GEX zero crossing after repricing gamma.

        OI remains previous-session OPRA inventory.  IV is held constant across
        the scenario grid; this is a transparent sticky-strike approximation,
        not a claim of observed dealer inventory.
        """
        observed_market = observed_at.astimezone(self.market_tz)
        eligible: list[tuple[float, float, float, float]] = []
        quoted = 0
        for row in rows:
            expiration = self._expiration_date(row.get("expiration"))
            strike = self._optional_number(row.get("strike"))
            oi = self._number(row.get("open_interest"))
            iv = self._optional_number(row.get("implied_volatility") or row.get("implied_vol") or row.get("iv"))
            bid, ask = self._optional_number(row.get("bid")), self._optional_number(row.get("ask"))
            if expiration is None or strike is None or strike <= 0 or oi <= 0 or iv is None or not .01 <= iv <= 5.0:
                continue
            expiry_at = datetime.combine(expiration, time(16, 0), self.market_tz)
            years = max((expiry_at-observed_market).total_seconds(), 60.0)/(365.0*24.0*3600.0)
            if years > max(float(self.max_dte)+1.0, 1.0)/365.0:
                continue
            # Reject crossed, zero-bid and exceptionally wide markets.  A
            # missing quote is retained but lowers the confidence score.
            if bid is not None and ask is not None:
                midpoint = (bid+ask)/2.0
                if ask < bid or bid <= 0 or midpoint <= 0 or (ask-bid)/midpoint > 1.0:
                    continue
                quoted += 1
            eligible.append((strike, oi, iv, years if years > 1e-9 else 1e-9))
        if len(eligible) < 2:
            return {"level":spot,"raw_level":spot,"method":"SPOT_FALLBACK","confidence":0.0,
                    "contracts":len(eligible),"crossing_slope":0.0,"grid_low":spot,"grid_high":spot}

        low = max(min(strike for strike, *_ in eligible), spot*.88)
        high = min(max(strike for strike, *_ in eligible), spot*1.12)
        if high <= low:
            low, high = spot*.9, spot*1.1
        scenarios = [low+(high-low)*index/200.0 for index in range(201)]
        # Preserve call/put signs by evaluating directly from the filtered rows.
        signed_contracts: list[tuple[float,float,float,float,float]]=[]
        for row in rows:
            expiration=self._expiration_date(row.get("expiration"));strike=self._optional_number(row.get("strike"));oi=self._number(row.get("open_interest"));iv=self._optional_number(row.get("implied_volatility") or row.get("implied_vol") or row.get("iv"))
            if expiration is None or strike is None or oi<=0 or iv is None or not .01<=iv<=5.0:continue
            expiry_at=datetime.combine(expiration,time(16,0),self.market_tz);years=max((expiry_at-observed_market).total_seconds(),60.0)/(365.0*24.0*3600.0)
            if years>max(float(self.max_dte)+1.0,1.0)/365.0:continue
            bid,ask=self._optional_number(row.get("bid")),self._optional_number(row.get("ask"))
            if bid is not None and ask is not None:
                mid=(bid+ask)/2.0
                if ask<bid or bid<=0 or mid<=0 or (ask-bid)/mid>1.0:continue
            signed_contracts.append((strike,oi,iv,max(years,1e-9),self._right_sign(row.get("right"))))
        def signed_total(scenario:float)->float:
            total=0.0
            for strike,oi,iv,years,side in signed_contracts:
                root_t=sqrt(years);d1=(log(max(scenario,1e-12)/strike)+.5*iv*iv*years)/(iv*root_t)
                gamma=exp(-.5*d1*d1)/sqrt(2.0*pi)/(scenario*iv*root_t)
                total+=side*oi*100.0*gamma*scenario*scenario*.01
            return total
        values=[signed_total(value) for value in scenarios]
        crossings=[]
        for index in range(1,len(scenarios)):
            before,after=values[index-1],values[index]
            if before==0:crossings.append((scenarios[index-1],index,abs(after-before)))
            elif before*after<0:
                ratio=abs(before)/(abs(before)+abs(after));level=scenarios[index-1]+ratio*(scenarios[index]-scenarios[index-1])
                crossings.append((level,index,abs(after-before)))
        if crossings:
            raw,index,slope=min(crossings,key=lambda item:abs(item[0]-spot));method="REPRICED_GEX_ZERO_CROSS"
        else:
            index=min(range(len(values)),key=lambda item:abs(values[item]));raw=scenarios[index];slope=abs(values[min(index+1,len(values)-1)]-values[max(index-1,0)]);method="MIN_ABS_REPRICED_GEX"
        history=self._zero_gamma_history.setdefault(symbol.upper(),deque(maxlen=5));history.append(raw)
        filtered=median(history);previous=self._zero_gamma_ema.get(symbol.upper(),filtered);smoothed=.30*filtered+.70*previous
        if abs(smoothed-previous)<.02:smoothed=previous
        self._zero_gamma_ema[symbol.upper()]=smoothed
        scale=max(max(abs(value) for value in values),1.0);slope_quality=min(1.0,slope/scale*25.0);quote_quality=quoted/max(len(eligible),1);cross_quality=1.0 if crossings else .35
        confidence=100.0*(.45*slope_quality+.35*quote_quality+.20*cross_quality)
        return {"level":smoothed,"raw_level":raw,"method":method,"confidence":max(0.0,min(100.0,confidence)),
                "contracts":len(signed_contracts),"crossing_slope":slope,"grid_low":low,"grid_high":high}

    def _rank_exposure_wall(self, rows: list[dict[str, Any]], spot: float, symbol: str,
                            right: str) -> dict[str, Any] | None:
        """Select a stable wall from exposure, activity, and quote quality."""
        wanted = 1 if right == "call" else -1
        by_strike: dict[float, dict[str, float]] = {}
        for row in rows:
            if self._right_sign(row.get("right")) != wanted:
                continue
            strike = self._optional_number(row.get("strike"))
            oi = self._number(row.get("open_interest"))
            gamma = abs(self._number(row.get("gamma")))
            delta = abs(self._number(row.get("delta")))
            if strike is None or strike <= 0 or oi <= 0 or not all(isfinite(value) for value in (strike, oi, gamma, delta)):
                continue
            bid = self._optional_number(row.get("bid"))
            ask = self._optional_number(row.get("ask"))
            if bid is not None and ask is not None:
                mid = (bid + ask) / 2.0
                if bid <= 0 or ask < bid or mid <= 0 or (ask - bid) / mid > 1.0:
                    continue
                spread_quality = max(0.0, 1.0 - (ask - bid) / mid)
            else:
                spread_quality = 0.25
            bid_size = max(0.0, self._number(row.get("bid_size")))
            ask_size = max(0.0, self._number(row.get("ask_size")))
            item = by_strike.setdefault(float(strike), {"gex": 0.0, "dex": 0.0, "oi": 0.0,
                                                         "volume": 0.0, "liquidity": 0.0, "contracts": 0.0})
            item["gex"] += gamma * oi * 100.0 * spot ** 2 * .01
            item["dex"] += delta * oi * 100.0 * spot
            item["oi"] += oi
            item["volume"] += max(0.0, self._number(row.get("volume")))
            item["liquidity"] += spread_quality * sqrt(bid_size + ask_size + 1.0)
            item["contracts"] += 1.0
        if not by_strike:
            return None

        strikes = sorted(by_strike)
        gaps = sorted(right_value - left for left, right_value in pairwise(strikes) if right_value > left)
        typical_gap = gaps[len(gaps) // 2] if gaps else max(1.0, spot * .0025)
        cluster_radius = max(typical_gap * 2.0, spot * .005)
        for strike, item in by_strike.items():
            item["cluster_gex"] = sum(
                neighbor["gex"] * max(0.0, 1.0 - abs(other_strike - strike) / cluster_radius)
                for other_strike, neighbor in by_strike.items()
                if abs(other_strike - strike) <= cluster_radius
            )

        maxima = {name: max((item[name] for item in by_strike.values()), default=0.0)
                  for name in ("cluster_gex", "dex", "oi", "volume", "liquidity")}
        key = (symbol.upper(), right)
        history = self._wall_candidate_history.setdefault(key, deque(maxlen=12))
        candidates: dict[float, dict[str, Any]] = {}
        for strike, item in by_strike.items():
            normalized = {name: item[name] / maxima[name] if maxima[name] > 0 else 0.0 for name in maxima}
            persistence = sum(previous == strike for previous in history) / max(len(history), 1) if history else .5
            score = (.30 * normalized["cluster_gex"] + .20 * normalized["dex"] + .15 * normalized["oi"]
                     + .15 * normalized["volume"] + .10 * normalized["liquidity"] + .10 * persistence)
            candidates[strike] = {**item, "score": score, "persistence": persistence,
                                  "components": normalized}

        raw_strike = max(candidates, key=lambda strike: (candidates[strike]["score"], -abs(strike - spot)))
        history.append(raw_strike)
        filtered_center = median(history)
        filtered_strike = min(candidates, key=lambda strike: (abs(strike - filtered_center),
                                                               -candidates[strike]["score"]))
        previous = self._wall_selected.get(key)
        selected = filtered_strike
        if (previous in candidates and previous != filtered_strike
                and candidates[filtered_strike]["score"] < candidates[previous]["score"] + .08):
            selected = float(previous)
        self._wall_selected[key] = selected
        ranked = sorted(candidates.items(), key=lambda item: item[1]["score"], reverse=True)
        selected_data = candidates[selected]
        runner_up = next((data["score"] for strike, data in ranked if strike != selected), 0.0)
        margin = max(0.0, selected_data["score"] - runner_up)
        confidence = 100.0 * min(1.0, .75 * selected_data["score"] + .25 * min(1.0, margin / .20))
        return {"strike": float(selected), "raw_strike": float(raw_strike),
                "gex": float(wanted * selected_data["gex"]), "dex": float(wanted * selected_data["dex"]),
                "open_interest": int(selected_data["oi"]), "volume": float(selected_data["volume"]),
                "score": float(selected_data["score"] * 100.0), "confidence": float(confidence),
                "persistence": float(selected_data["persistence"] * 100.0),
                "cluster_gex": float(wanted * selected_data["cluster_gex"]),
                "method": "WEIGHTED_EXPOSURE_CLUSTER_V2"}

    def _gamma_metrics(cls, rows: list[dict[str, Any]], spot: float, observed_at: datetime,
                       symbol: str = "QQQ") -> dict[str, Any]:
        """Calculate Gamma Dynamics 2.0 features from one option-chain snapshot."""
        dated = [row for row in rows if cls._expiration_date(row.get("expiration")) is not None]
        contracts = [row for row in dated if cls._expiration_date(row.get("expiration")) == observed_at.date()] if dated else rows
        by_strike: dict[float, list[dict[str, Any]]] = {}
        for row in contracts:
            strike = cls._optional_number(row.get("strike"))
            if strike is not None and strike > 0:
                by_strike.setdefault(strike, []).append(row)
        if not by_strike:
            return {"spot": spot, "chain_available": 0.0}
        net_gex: dict[float, float] = {}
        # Delta exposure is directional rather than convexity exposure.  Do
        # not apply the call/put GEX side convention here: contract delta is
        # already positive for calls and negative for puts.  This is the
        # OI-based stock hedge in dollars implied by each strike.
        net_dex: dict[float, float] = {}
        for strike, contracts_at_strike in by_strike.items():
            net_gex[strike] = sum(
                cls._right_sign(row.get("right"))
                * cls._number(row.get("open_interest")) * 100.0 * cls._number(row.get("gamma")) * spot ** 2 * 0.01
                for row in contracts_at_strike
            )
            net_dex[strike] = sum(
                cls._number(row.get("delta"))
                * cls._number(row.get("open_interest")) * 100.0 * spot
                for row in contracts_at_strike
            )
        key_fault_line = min(net_gex, key=lambda strike: (-abs(net_gex[strike]), strike))
        key_rows = by_strike[key_fault_line]
        atm_strike = min(by_strike, key=lambda strike: (abs(strike - spot), strike))
        atm_rows = by_strike[atm_strike]
        subset = [
            row for row in contracts
            if 0.25 < abs(cls._number(row.get("delta"))) < 0.75
            and abs(cls._number(row.get("strike")) - spot) / max(spot, 1e-12) < 0.01
        ]
        def weighted(name: str) -> float:
            return sum(cls._number(row.get(name)) * cls._number(row.get("open_interest")) * 100.0 for row in subset)
        iv_values = [
            value for row in atm_rows
            if (value := cls._optional_number(row.get("implied_volatility") or row.get("implied_vol") or row.get("iv"))) is not None
        ]
        key_sizes = [
            cls._optional_number(row.get("bid_size")) for row in key_rows
        ] + [cls._optional_number(row.get("ask_size")) for row in key_rows]
        liquidity_available = any(value is not None for value in key_sizes)
        liquidity = sum(value or 0.0 for value in key_sizes)
        atm_spread = sum(max(0.0, cls._number(row.get("ask")) - cls._number(row.get("bid"))) for row in atm_rows) / max(len(atm_rows), 1)
        # Contract-level exposures for Gamma Dynamics 2.0.  Keep the raw
        # values here; its rolling model infers flow and delayed-OI effects
        # from consecutive snapshots rather than inventing tape data.
        gex_total = sum(net_gex.values())
        abs_gex_total = sum(abs(value) for value in net_gex.values())
        near_strikes = [strike for strike in net_gex if abs(strike - spot) <= spot * .005]
        near_gex = sum(net_gex[strike] for strike in near_strikes)
        near_abs_gex = sum(abs(net_gex[strike]) for strike in near_strikes)
        gex_density = near_gex / max(abs_gex_total, 1.0) / max(spot * .01, 1e-12)
        support_candidates = [strike for strike, value in net_gex.items() if strike <= spot and value > 0]
        resistance_candidates = [strike for strike, value in net_gex.items() if strike >= spot and value < 0]
        support = max(support_candidates, key=lambda strike: net_gex[strike]) if support_candidates else min(by_strike, key=lambda strike: abs(strike - spot))
        resistance = min(resistance_candidates, key=lambda strike: net_gex[strike]) if resistance_candidates else min(by_strike, key=lambda strike: abs(strike - spot))
        total_oi = sum(cls._number(row.get("open_interest")) for row in contracts)
        gamma_oi = sum(abs(cls._number(row.get("gamma"))) * cls._number(row.get("open_interest")) for row in contracts)
        positive_gex = sum(max(0.0, value) for value in net_gex.values())
        negative_gex = sum(min(0.0, value) for value in net_gex.values())
        positive_dex = sum(max(0.0, value) for value in net_dex.values())
        negative_dex = sum(min(0.0, value) for value in net_dex.values())
        call_volume = sum(max(0.0, cls._number(row.get("volume"))) for row in contracts if cls._right_sign(row.get("right")) > 0)
        put_volume = sum(max(0.0, cls._number(row.get("volume"))) for row in contracts if cls._right_sign(row.get("right")) < 0)
        max_flow = max((abs(value) for value in net_gex.values()), default=0.0)
        zero_gamma_result = cls._repriced_zero_gamma(dated or rows, spot, observed_at, symbol)
        zero_gamma = float(zero_gamma_result["level"])
        strike_oi = {strike: int(sum(cls._number(row.get("open_interest")) for row in items)) for strike, items in by_strike.items()}
        call_wall_result = cls._rank_exposure_wall(contracts, spot, symbol, "call")
        put_wall_result = cls._rank_exposure_wall(contracts, spot, symbol, "put")
        call_wall = call_wall_result["strike"] if call_wall_result else None
        put_wall = put_wall_result["strike"] if put_wall_result else None
        positive_delta_walls = [strike for strike, dex in net_dex.items() if dex > 0]
        negative_delta_walls = [strike for strike, dex in net_dex.items() if dex < 0]
        call_delta_wall = max(positive_delta_walls, key=lambda strike: net_dex[strike]) if positive_delta_walls else None
        put_delta_wall = min(negative_delta_walls, key=lambda strike: net_dex[strike]) if negative_delta_walls else None
        delta_wall = max(net_dex, key=lambda strike: (abs(net_dex[strike]), -strike))
        # Zero Delta is a *balance level*, not the maximum DEX wall.  Walk the
        # cumulative signed DEX distribution from low to high strikes and use
        # the nearest interpolated zero crossing.  This is the strike where
        # cumulative calls/puts' OI-based delta exposure balances under the
        # current-chain approximation; it is not a tape-confirmed dealer hedge.
        cumulative_dex = 0.0
        previous_strike: float | None = None
        previous_cumulative: float | None = None
        zero_delta_candidates: list[float] = []
        for dex_strike in sorted(net_dex):
            cumulative_dex += net_dex[dex_strike]
            if previous_strike is not None and previous_cumulative is not None:
                if cumulative_dex == 0.0:
                    zero_delta_candidates.append(float(dex_strike))
                elif previous_cumulative == 0.0:
                    zero_delta_candidates.append(float(previous_strike))
                elif (previous_cumulative < 0.0 < cumulative_dex) or (previous_cumulative > 0.0 > cumulative_dex):
                    fraction = -previous_cumulative / (cumulative_dex - previous_cumulative)
                    zero_delta_candidates.append(float(previous_strike + fraction * (dex_strike - previous_strike)))
            previous_strike, previous_cumulative = dex_strike, cumulative_dex
        # A cumulative crossing is the preferred balance level.  Older code
        # silently used spot when the chain did not contain a crossing; that
        # made ZERO_DELTA plot exactly on top of QQQ and looked like a live
        # signal even though it was only a placeholder.  If the cumulative
        # curve does not cross, look for a signed per-strike DEX crossing and
        # finally use the strike with the smallest absolute DEX as an honest
        # nearest-balance estimate.  Never substitute the underlying price.
        zero_delta_method = "CUMULATIVE_CROSSING"
        if zero_delta_candidates:
            zero_delta = min(zero_delta_candidates, key=lambda value: abs(value - spot))
        else:
            direct_candidates: list[float] = []
            ordered_strikes = sorted(net_dex)
            for left_strike, right_strike in pairwise(ordered_strikes):
                left_dex, right_dex = net_dex[left_strike], net_dex[right_strike]
                if left_dex == 0.0:
                    direct_candidates.append(float(left_strike))
                elif right_dex == 0.0:
                    direct_candidates.append(float(right_strike))
                elif (left_dex < 0.0 < right_dex) or (left_dex > 0.0 > right_dex):
                    fraction = -left_dex / (right_dex - left_dex)
                    direct_candidates.append(float(left_strike + fraction * (right_strike - left_strike)))
            if direct_candidates:
                zero_delta = min(direct_candidates, key=lambda value: abs(value - spot))
                zero_delta_method = "STRIKE_BALANCE_CROSSING"
            else:
                zero_delta = float(min(net_dex, key=lambda strike: abs(net_dex[strike])))
                zero_delta_method = "NEAREST_BALANCE_STRIKE"
        zero_delta_nearest = min(net_dex, key=lambda strike: abs(strike - zero_delta))
        dex_walls = [
            {
                "strike": float(strike), "dex": float(net_dex[strike]), "abs_dex": float(abs(net_dex[strike])),
                "side": 1 if net_dex[strike] >= 0 else -1, "open_interest": strike_oi[strike],
                "distance_pct": float((strike - spot) / max(spot, 1e-12) * 100.0),
            }
            for strike in sorted(net_dex, key=lambda item: (-abs(net_dex[item]), item))[:5]
        ]
        gex_walls = [
            {
                "strike": float(strike), "gex": float(net_gex[strike]), "abs_gex": float(abs(net_gex[strike])),
                "side": 1 if net_gex[strike] > 0 else -1, "open_interest": strike_oi[strike],
                "distance_pct": float((strike - spot) / max(spot, 1e-12) * 100.0),
            }
            for strike in sorted(net_gex, key=lambda item: (-abs(net_gex[item]), item))[:5]
        ]
        # A compact, point-in-time market-structure snapshot.  These are
        # observations only; Gamma Dynamics continues to use its own features.
        zero_gamma_nearest = min(net_gex, key=lambda strike: abs(strike - zero_gamma))
        wall_estimates = {
            "CALL_WALL": dict(call_wall_result or {"strike": 0.0, "gex": 0.0}),
            "PUT_WALL": dict(put_wall_result or {"strike": 0.0, "gex": 0.0}),
            "ZERO_GAMMA": {"strike": float(zero_gamma), "gex": float(net_gex[zero_gamma_nearest])},
            "SUPPORT": {"strike": float(support), "gex": float(net_gex.get(support, 0.0))},
            "RESISTANCE": {"strike": float(resistance), "gex": float(net_gex.get(resistance, 0.0))},
            "DELTA_WALL": {"strike": float(delta_wall), "dex": float(net_dex[delta_wall])},
            "ZERO_DELTA": {"strike": float(zero_delta), "dex": float(net_dex[zero_delta_nearest])},
        }
        exposure = lambda greek, power, scale=1.0: sum(
            cls._right_sign(row.get("right")) * cls._number(row.get(greek)) * cls._number(row.get("open_interest")) * 100.0 * spot ** power * scale
            for row in contracts
        )
        return {
            "observed_epoch": observed_at.timestamp(),
            "spot": spot,
            "chain_available": 1.0,
            "key_fault_line": key_fault_line,
            "net_gex_key": net_gex[key_fault_line],
            "gamma_squeeze_score": abs(net_gex[key_fault_line]) / max(0.1, abs(spot - key_fault_line)),
            "weighted_speed": weighted("speed"),
            "weighted_color": weighted("color"),
            "weighted_charm": weighted("charm"),
            "weighted_vanna": weighted("vanna"),
            "net_dealer_delta": sum(
                cls._number(row.get("delta")) * cls._number(row.get("open_interest")) * 100.0 * cls._right_sign(row.get("right"))
                for row in contracts
            ),
            "atm_iv": sum(iv_values) / len(iv_values) if iv_values else 0.0,
            "atm_iv_available": float(bool(iv_values)),
            "atm_spread": atm_spread,
            "key_liquidity": liquidity,
            "liquidity_available": float(liquidity_available),
            "bad_liquidity": float(liquidity_available and liquidity < 1000.0),
            "gex_raw": gex_total,
            "gex_abs_total": abs_gex_total,
            "positive_gex": positive_gex,
            "negative_gex": negative_gex,
            "positive_dex": positive_dex,
            "negative_dex": negative_dex,
            "call_volume": call_volume,
            "put_volume": put_volume,
            "is_estimated_oi_delayed": 1.0,
            "gex_density": gex_density,
            # ``gex_density`` is a dimensionless local concentration.  It
            # must not be multiplied by spot again and presented as dollars:
            # that produced values in the hundreds and made the $100M gate
            # impossible to pass.  The signed near-spot GEX is the actual
            # dollar exposure inside the specified +/-0.5% band.
            "gex_dollar_density": near_gex,
            "gex_abs_dollar_density": near_abs_gex,
            "zero_gamma": zero_gamma,
            "zero_gamma_raw": float(zero_gamma_result["raw_level"]),
            "zero_gamma_method": str(zero_gamma_result["method"]),
            "zero_gamma_confidence": float(zero_gamma_result["confidence"]),
            "zero_gamma_contracts": int(zero_gamma_result["contracts"]),
            "zero_gamma_crossing_slope": float(zero_gamma_result["crossing_slope"]),
            "zero_gamma_grid_low": float(zero_gamma_result["grid_low"]),
            "zero_gamma_grid_high": float(zero_gamma_result["grid_high"]),
            "zero_gamma_gap_usd": float(spot-zero_gamma),
            "zero_gamma_gap_bps": float((spot-zero_gamma)/max(spot,1e-12)*10_000.0),
            "call_wall_strike": float(call_wall or 0.0),
            "call_wall_gex": float(call_wall_result["gex"]) if call_wall_result else 0.0,
            "call_wall_oi": int(call_wall_result["open_interest"]) if call_wall_result else 0,
            "call_wall_score": float(call_wall_result["score"]) if call_wall_result else 0.0,
            "call_wall_confidence": float(call_wall_result["confidence"]) if call_wall_result else 0.0,
            "call_wall_persistence": float(call_wall_result["persistence"]) if call_wall_result else 0.0,
            "call_wall_method": str(call_wall_result["method"]) if call_wall_result else "UNAVAILABLE",
            "put_wall_strike": float(put_wall or 0.0),
            "put_wall_gex": float(put_wall_result["gex"]) if put_wall_result else 0.0,
            "put_wall_oi": int(put_wall_result["open_interest"]) if put_wall_result else 0,
            "put_wall_score": float(put_wall_result["score"]) if put_wall_result else 0.0,
            "put_wall_confidence": float(put_wall_result["confidence"]) if put_wall_result else 0.0,
            "put_wall_persistence": float(put_wall_result["persistence"]) if put_wall_result else 0.0,
            "put_wall_method": str(put_wall_result["method"]) if put_wall_result else "UNAVAILABLE",
            "gex_walls": gex_walls,
            "dex_walls": dex_walls,
            "delta_wall_strike": float(delta_wall),
            "delta_wall_dex": float(net_dex[delta_wall]),
            "zero_delta": float(zero_delta),
            "zero_delta_dex": float(net_dex[zero_delta_nearest]),
            "zero_delta_method": zero_delta_method,
            "zero_delta_crossing_available": float(bool(zero_delta_candidates or zero_delta_method == "STRIKE_BALANCE_CROSSING")),
            "call_delta_wall_strike": float(call_delta_wall or 0.0),
            "call_delta_wall_dex": float(net_dex[call_delta_wall]) if call_delta_wall is not None else 0.0,
            "put_delta_wall_strike": float(put_delta_wall or 0.0),
            "put_delta_wall_dex": float(net_dex[put_delta_wall]) if put_delta_wall is not None else 0.0,
            "wall_estimates": wall_estimates,
            "pin_status": "BETWEEN_WALLS" if call_wall is not None and put_wall is not None and put_wall < spot < call_wall else "OUTSIDE",
            "support_level": support,
            "resistance_level": resistance,
            "total_open_interest": total_oi,
            "gamma_open_interest": gamma_oi,
            "max_flow": max_flow,
            "concentration": max_flow / max(abs_gex_total, 1.0),
            "market_depth": liquidity * spot,
            "liquidity_score": atm_spread / max(liquidity, 1.0),
            "dex": exposure("delta", 1),
            "speed_ex": exposure("speed", 3, .01),
            "color_ex": exposure("color", 2, .01),
            "charm_ex": exposure("charm", 1),
            "vanna_ex": exposure("vanna", 1),
            "volga_ex": exposure("vomma", 0),
        }

    @staticmethod
    def _right_sign(value: Any) -> float:
        return -1.0 if str(value).strip().lower() in {"p", "put"} else 1.0

    @staticmethod
    def _expiration_date(value: Any) -> date | None:
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        digits = re.sub(r"[^0-9]", "", str(value or ""))
        if len(digits) != 8:
            return None
        try:
            return datetime.strptime(digits, "%Y%m%d").date()
        except ValueError:
            return None

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
    def _optional_number(value: Any) -> float | None:
        if value is None or value == "":
            return None
        try:
            parsed = float(value)
            return parsed if parsed == parsed and parsed not in {float("inf"), float("-inf")} else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _interval(seconds: int) -> str:
        supported = {1, 5, 10, 15, 30, 60, 300, 600, 900, 1800, 3600}
        nearest = min(supported, key=lambda value: abs(value - seconds))
        return f"{nearest // 60}m" if nearest >= 60 else f"{nearest}s"
