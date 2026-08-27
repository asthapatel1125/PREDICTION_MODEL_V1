from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass

from axiom.domain.models import Greeks, MarketBar


@dataclass
class _Bucket:
    bars: list[MarketBar]

    def aggregate(self, seconds: int) -> MarketBar:
        first, last = self.bars[0], self.bars[-1]
        n = len(self.bars)
        return MarketBar(timestamp=last.timestamp, symbol=last.symbol, timeframe_seconds=seconds,
            open=first.open, high=max(b.high for b in self.bars), low=min(b.low for b in self.bars), close=last.close,
            volume=sum(b.volume for b in self.bars), bid_ask_spread=sum(b.bid_ask_spread for b in self.bars)/n,
            greeks=Greeks(**{name: sum(getattr(b.greeks,name) for b in self.bars)/n for name in Greeks.model_fields}),
            contract_count=last.contract_count, open_interest=last.open_interest,
            # A completed timeframe uses the final complete chain snapshot for
            # chain-level calculations; averaging snapshots would corrupt dGEX.
            gamma_metrics=last.gamma_metrics, gamma_ticks=last.gamma_ticks)


class MultiTimeframeEngine:
    """Streaming, event-time bar synchronizer with bounded per-symbol history."""

    def __init__(self, timeframes: list[int], max_bars: int = 20000):
        self.timeframes = sorted(set(timeframes)); self.max_bars = max_bars
        self.history: dict[tuple[str,int], deque[MarketBar]] = defaultdict(deque)
        self._buckets: dict[tuple[str,int,int], _Bucket] = {}

    @staticmethod
    def _cache_bar(bar: MarketBar) -> MarketBar:
        """Keep rolling calculations compact; full chain snapshots are persisted separately.

        A five-second chain can contain thousands of strike records.  Retaining
        it in every in-memory timeframe bucket would exceed a small Render
        instance long before the trading session ends.  Gamma 2.0 only needs
        the compact chain metrics for its rolling calculations; ``gamma_ticks``
        are saved by the engine before this cache is discarded.
        """
        return bar.model_copy(update={"gamma_ticks": []})

    def update(self, bar: MarketBar) -> dict[int, MarketBar]:
        completed: dict[int, MarketBar] = {}
        cached_bar = self._cache_bar(bar)
        for seconds in self.timeframes:
            epoch = int(cached_bar.timestamp.timestamp()); bucket_id = epoch // seconds
            key = (cached_bar.symbol, seconds, bucket_id); bucket = self._buckets.setdefault(key, _Bucket([])); bucket.bars.append(cached_bar)
            previous_key = (cached_bar.symbol, seconds, bucket_id - 1)
            if previous_key in self._buckets:
                complete = self._buckets.pop(previous_key).aggregate(seconds)
                history = self.history[(cached_bar.symbol, seconds)]
                if len(history) >= self.max_bars:
                    for _ in range(min(1000, len(history))):
                        history.popleft()
                history.append(complete); completed[seconds] = complete
        return completed

    def bars(self, symbol: str, timeframe: int) -> list[MarketBar]:
        return list(self.history[(symbol, timeframe)])

    def alignment(self, symbol: str) -> dict[str, float]:
        result: dict[str,float] = {}
        for tf in self.timeframes:
            bars = self.bars(symbol, tf)
            if len(bars) < 2: result[f"{tf}s"] = 0.0
            else: result[f"{tf}s"] = 1.0 if bars[-1].close > bars[-2].close else -1.0 if bars[-1].close < bars[-2].close else 0.0
        return result
