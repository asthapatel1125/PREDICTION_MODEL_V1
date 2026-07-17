from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Sequence
from datetime import datetime
from typing import Protocol

from axiom.domain.models import Alert, MarketBar, MarketState, Outcome


class MarketDataPort(ABC):
    @abstractmethod
    async def historical_bars(self, symbol: str, start: datetime, end: datetime, resolution_seconds: int) -> AsyncIterator[MarketBar]: ...

    @abstractmethod
    async def live_bars(self, symbol: str, resolution_seconds: int) -> AsyncIterator[MarketBar]: ...


class RepositoryPort(Protocol):
    async def save_state(self, state: MarketState) -> None: ...
    async def save_alert(self, alert: Alert) -> None: ...
    async def save_outcome(self, outcome: Outcome) -> None: ...
    async def list_alerts(self, limit: int = 100, offset: int = 0) -> Sequence[Alert]: ...


class EventPublisherPort(Protocol):
    async def publish(self, topic: str, payload: dict[str, object]) -> None: ...

