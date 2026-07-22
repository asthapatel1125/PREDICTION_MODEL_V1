from __future__ import annotations

from axiom.domain.enums import Direction
from axiom.domain.models import Greeks, MomentumTriad


class NQMomentumTriad:
    """Sign-alignment heuristic that remains independent of the main signal."""

    def __init__(self, zero_tolerance: float = 1e-12):
        self.zero_tolerance = zero_tolerance

    def _vote(self, value: float) -> int:
        if value > self.zero_tolerance:
            return 1
        if value < -self.zero_tolerance:
            return -1
        return 0

    def calculate(self, greeks: Greeks, source_symbol: str) -> MomentumTriad:
        values = {"zomma": float(greeks.zomma), "speed": float(greeks.speed), "delta": float(greeks.delta)}
        votes = {name: self._vote(value) for name, value in values.items()}
        aligned_long = all(vote == 1 for vote in votes.values())
        aligned_short = all(vote == -1 for vote in votes.values())
        decision = Direction.UP if aligned_long else Direction.DOWN if aligned_short else Direction.NEUTRAL
        explanation = (
            "Zomma acceleration, Speed direction, and Delta confirmation are all positive."
            if aligned_long else
            "Zomma acceleration, Speed direction, and Delta confirmation are all negative."
            if aligned_short else
            "Zomma acceleration, Speed direction, and Delta confirmation are not aligned."
        )
        return MomentumTriad(
            decision=decision, aligned=aligned_long or aligned_short, source_symbol=source_symbol,
            acceleration=values["zomma"], direction=values["speed"], confirmation=values["delta"],
            votes=votes, explanation=explanation,
        )
