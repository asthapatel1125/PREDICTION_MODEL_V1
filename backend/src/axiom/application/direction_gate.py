"""Durable daily admission preference shared by all Dynamics trackers."""
import asyncio
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

MODES = {"BOTH", "LONG_ONLY", "SHORT_ONLY", "NO_TRADE"}


class DirectionGateLockedError(ValueError):
    pass


def gate_expiry(now, market_timezone):
    local = now.astimezone(ZoneInfo(market_timezone))
    day = local.date()
    if local.time() >= time(18):
        day += timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return datetime.combine(day, time(18), tzinfo=local.tzinfo)


def effective_gate(saved, now):
    if not saved:
        return {"mode": "BOTH", "expires_at": None, "updated_at": None, "locked": False}
    expiry = datetime.fromisoformat(saved["expires_at"])
    active = now < expiry and saved["mode"] != "BOTH"
    return {**saved, "mode": saved["mode"] if active else "BOTH", "locked": active}


class DailyDirectionGate:
    def __init__(self, repository, trackers, market_timezone):
        self.repository = repository
        self.trackers = trackers
        self.market_timezone = market_timezone
        self.lock = asyncio.Lock()

    def apply(self, payload):
        for tracker in self.trackers:
            if tracker.direction_gate != payload["mode"]:
                tracker.set_direction_gate(payload["mode"])
        return payload

    async def sync(self, now=None):
        async with self.lock:
            saved = await self.repository.load_direction_gate()
            return self.apply(effective_gate(saved, now or datetime.now(timezone.utc)))

    async def set(self, mode, now=None):
        if mode not in MODES or mode == "BOTH":
            raise ValueError("Invalid Dynamics direction gate")
        now = now or datetime.now(timezone.utc)
        payload = {"mode": mode, "updated_at": now.isoformat(),
                   "expires_at": gate_expiry(now, self.market_timezone).isoformat(), "locked": True}
        async with self.lock:
            current = effective_gate(await self.repository.load_direction_gate(), now)
            if current["locked"]:
                raise DirectionGateLockedError(
                    f"Session choice is locked as {current['mode']} until {current['expires_at']}")
            # Do not acknowledge/apply a preference that failed to persist.
            await self.repository.save_direction_gate(payload)
            return self.apply(payload)
