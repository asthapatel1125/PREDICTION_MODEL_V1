from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence

from axiom.domain.models import MarketBar, ScoreResult


class AnalyticsModule(ABC):
    """Replaceable formula contract used by the decision pipeline."""

    @abstractmethod
    def calculate(self, current: MarketBar, history: Sequence[MarketBar]) -> ScoreResult: ...


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def robust_intensity(current: float, history: Sequence[float]) -> float:
    import numpy as np

    values = np.abs(np.asarray(history, dtype=float))
    if len(values) < 10:
        return abs(current) / (1.0 + abs(current))
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    z = max(0.0, (abs(current) - median) / max(1.4826 * mad, 1e-9))
    return 1.0 - float(np.exp(-z / 2.0))

