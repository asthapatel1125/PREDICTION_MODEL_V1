from collections.abc import Sequence

from axiom.domain.enums import Direction
from axiom.domain.models import MarketBar, MicroRange


class MicroRangeBreakout:
    def calculate(self, bars: Sequence[MarketBar], lookback_minutes: int, snapback_bars: int = 2) -> MicroRange:
        if not bars: raise ValueError("Micro-range requires bars")
        current = bars[-1]; cutoff = current.timestamp.timestamp() - lookback_minutes * 60
        prior = [b for b in bars[:-1] if b.timestamp.timestamp() >= cutoff]
        if not prior: return MicroRange(high=current.high, low=current.low)
        high, low = max(b.high for b in prior), min(b.low for b in prior)
        direction = Direction.UP if current.close > high else Direction.DOWN if current.close < low else Direction.NEUTRAL
        confirmed = direction != Direction.NEUTRAL and ((direction == Direction.UP and current.low >= high) or (direction == Direction.DOWN and current.high <= low))
        recent = bars[-snapback_bars:]
        snapback = direction != Direction.NEUTRAL and any((direction == Direction.UP and b.close <= high) or (direction == Direction.DOWN and b.close >= low) for b in recent[:-1])
        return MicroRange(high=high, low=low, breakout=direction, confirmed=confirmed, snapback=snapback)

