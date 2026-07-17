from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from axiom.domain.enums import AlertProfile


class AlertProfileSelector:
    def __init__(self, timezone_name: str, event_window_minutes: int = 20):
        self.tz=ZoneInfo(timezone_name); self.window=timedelta(minutes=event_window_minutes)

    def select(self,timestamp:datetime,high_impact_events:list[datetime],volatility_ratio:float) -> AlertProfile:
        local=timestamp.astimezone(self.tz)
        if volatility_ratio>=2.5 or any(abs(local-e.astimezone(self.tz))<=self.window for e in high_impact_events): return AlertProfile.NEWS
        if time(9,30)<=local.time()<time(10): return AlertProfile.MARKET_OPEN
        if time(15)<=local.time()<time(16): return AlertProfile.POWER_HOUR
        if local.time()<time(9,30) or local.time()>=time(16): return AlertProfile.OVERNIGHT
        return AlertProfile.NORMAL_SESSION

