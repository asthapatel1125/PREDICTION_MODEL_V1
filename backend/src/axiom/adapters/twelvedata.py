from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx


class TwelveDataPriceClient:
    """Small server-side Twelve Data adapter. API keys never reach the browser."""

    base_url = "https://api.twelvedata.com"

    def __init__(self, api_key: str | None, timeout_seconds: float = 10.0):
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    async def latest(self, symbol: str) -> dict[str, Any] | None:
        if not self.api_key:
            return None
        # QQQ is supported by the Basic plan. Futures such as NQ must not be
        # silently proxied because they are different instruments and point scales.
        if symbol.upper() != "QQQ":
            return None
        observed_at = datetime.now(timezone.utc)
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.get(
                f"{self.base_url}/price",
                params={"symbol": symbol.upper(), "apikey": self.api_key},
            )
            response.raise_for_status()
            payload = response.json()
        if payload.get("status") == "error":
            raise RuntimeError(f"Twelve Data: {payload.get('message', 'price request failed')}")
        return {
            "symbol": symbol.upper(),
            "price": float(payload["price"]),
            "source": "TWELVE_DATA",
            # /price has no exchange timestamp. This is explicitly an application
            # observation timestamp, not fabricated tick precision.
            "source_timestamp": None,
            "observed_at": observed_at,
        }
