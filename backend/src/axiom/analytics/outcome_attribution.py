from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from axiom.domain.enums import Direction, EngineMode
from axiom.domain.models import MarketState


SYSTEM_GREEKS = {
    "PRIMARY_OPTIONS": ("gamma", "vanna", "charm", "speed", "zomma", "color", "ultima"),
    "MOMENTUM_TRIAD": ("zomma", "speed", "delta"),
    "GAMMA_DYNAMICS": ("zomma", "color", "speed", "gamma"),
}


class OutcomeAttributionTracker:
    """Tracks observed excursions after qualified, independent system decisions."""

    def __init__(self, horizon_minutes: int = 30, cooldown_seconds: int = 300):
        self.horizon = timedelta(minutes=horizon_minutes)
        self.cooldown = timedelta(seconds=cooldown_seconds)
        self._active: dict[str, dict[str, Any]] = {}
        self._last_signal: dict[tuple[str, str], datetime] = {}
        self._history: dict[str, dict[str, deque[float]]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=100))
        )
        self.eastern = ZoneInfo("America/New_York")

    @staticmethod
    def _direction_sign(direction: Direction) -> int:
        return 1 if direction == Direction.UP else -1

    @staticmethod
    def _qualified_systems(state: MarketState) -> list[tuple[str, Direction]]:
        systems: list[tuple[str, Direction]] = []
        if state.options_bias_qualified and state.options_bias != Direction.NEUTRAL:
            systems.append(("PRIMARY_OPTIONS", state.options_bias))
        triad = state.momentum_triad
        if triad and triad.aligned and triad.decision != Direction.NEUTRAL:
            systems.append(("MOMENTUM_TRIAD", triad.decision))
        gamma = state.gamma_dynamics
        if gamma and gamma.qualified and gamma.decision != Direction.NEUTRAL:
            systems.append(("GAMMA_DYNAMICS", gamma.decision))
        return systems

    def _relative_scores(self, symbol: str, system: str, state: MarketState, direction: Direction) -> dict[str, float]:
        greeks = state.greeks
        if greeks is None:
            return {}
        direction_sign = self._direction_sign(direction)
        scores: dict[str, float] = {}
        for name in SYSTEM_GREEKS[system]:
            value = float(getattr(greeks, name))
            samples = list(self._history[symbol][name])
            magnitude = abs(value)
            percentile = (
                (sum(item < magnitude for item in samples) + 0.5 * sum(item == magnitude for item in samples))
                / len(samples)
                if samples else 0.5
            )
            sign = 1 if value > 0 else -1 if value < 0 else 0
            scores[name] = direction_sign * sign * percentile
        return scores

    @staticmethod
    def _leaders(scores: dict[str, float]) -> tuple[str | None, str | None]:
        if not scores:
            return None, None
        return max(scores, key=scores.get), min(scores, key=scores.get)

    def _call_id(self,timestamp:datetime,system:str)->str:
        stream={"PRIMARY_OPTIONS":1,"MOMENTUM_TRIAD":2,"GAMMA_DYNAMICS":3}[system]
        eastern=timestamp.astimezone(self.eastern)
        milliseconds=eastern.microsecond//1000
        return f"{eastern:%Y%m%d%H%M%S}{milliseconds:03d}{stream:02d}"

    @staticmethod
    def _pivot(kind:str,sequence:int,price:float,timestamp:datetime,record:dict[str,Any],
        scores:dict[str,float],confirmed_at:datetime)->dict[str,Any]:
        ordered=sorted(scores.items(),key=lambda item:item[1],reverse=True)
        strongest=ordered[0][0] if ordered else None
        weakest=ordered[-1][0] if ordered else None
        baseline=record.get("greek_scores_at_signal",{})
        decays={name:float(baseline[name])-float(scores.get(name,baseline[name])) for name in baseline}
        decay=max(decays,key=decays.get) if decays else None
        direction=record.get("direction")
        matched=(direction==Direction.UP.value and kind=="HIGH") or (direction==Direction.DOWN.value and kind=="LOW")
        return {"kind":kind,"sequence":sequence,"price":price,"timestamp":timestamp,
            "confirmed_at":confirmed_at,"points_from_datum":price-record["entry_price"],
            "seconds_from_alert":max(0.0,(timestamp-record["alerted_at"]).total_seconds()),
            "greek_scores":scores,"matched_call":matched,
            "success_leading_greek":strongest if matched else None,
            "strongest_greek":strongest,"weakest_greek":weakest,
            "decay_greek":decay,"decay_amount":decays.get(decay,0.0) if decay else 0.0}

    def _update_turning_points(self,record:dict[str,Any],price:float,now:datetime,scores:dict[str,float])->None:
        """Reversal-confirmed zigzag; datum is the alert price, never a synthetic zero."""
        threshold=record["reversal_points"];trend=record["swing_trend"]
        if trend=="SEEKING":
            if price>record["candidate_high_price"]:
                record.update(candidate_high_price=price,candidate_high_at=now,candidate_high_scores=scores)
            if price<record["candidate_low_price"]:
                record.update(candidate_low_price=price,candidate_low_at=now,candidate_low_scores=scores)
            if price>=record["candidate_low_price"]+threshold:
                record.update(swing_trend="UP",candidate_high_price=price,candidate_high_at=now,candidate_high_scores=scores)
            elif price<=record["candidate_high_price"]-threshold:
                record.update(swing_trend="DOWN",candidate_low_price=price,candidate_low_at=now,candidate_low_scores=scores)
            return
        if trend=="UP":
            if price>record["candidate_high_price"]:
                record.update(candidate_high_price=price,candidate_high_at=now,candidate_high_scores=scores)
            elif record["candidate_high_price"]-price>=threshold:
                if len(record["turning_highs"])<3:
                    record["turning_highs"].append(self._pivot("HIGH",len(record["turning_highs"])+1,
                        record["candidate_high_price"],record["candidate_high_at"],record,
                        record["candidate_high_scores"],now))
                record.update(swing_trend="DOWN",candidate_low_price=price,candidate_low_at=now,candidate_low_scores=scores)
            return
        if price<record["candidate_low_price"]:
            record.update(candidate_low_price=price,candidate_low_at=now,candidate_low_scores=scores)
        elif price-record["candidate_low_price"]>=threshold:
            if len(record["turning_lows"])<3:
                record["turning_lows"].append(self._pivot("LOW",len(record["turning_lows"])+1,
                    record["candidate_low_price"],record["candidate_low_at"],record,
                    record["candidate_low_scores"],now))
            record.update(swing_trend="UP",candidate_high_price=price,candidate_high_at=now,candidate_high_scores=scores)

    @staticmethod
    def _decision_reasons(system: str, state: MarketState, direction: Direction) -> list[str]:
        side = "bullish" if direction == Direction.UP else "bearish"
        sign_word = "positive" if direction == Direction.UP else "negative"
        if system == "MOMENTUM_TRIAD" and state.momentum_triad:
            triad = state.momentum_triad
            return [
                f"Zomma {triad.acceleration:+.4g} is {sign_word}, indicating {side} Gamma acceleration.",
                f"Speed {triad.direction:+.4g} is {sign_word}, aligning Gamma's spot sensitivity with the {side} call.",
                f"Delta {triad.confirmation:+.4g} is {sign_word}, providing first-order {side} confirmation.",
            ]
        if system == "GAMMA_DYNAMICS" and state.gamma_dynamics:
            gamma = state.gamma_dynamics
            inputs = gamma.inputs
            return [
                f"Speed {inputs.get('speed', 0):+.4g} supplies the {side} direction while Gamma magnitude {abs(inputs.get('gamma', 0)):.4g} supplies the active curvature base.",
                f"Zomma/Color relative intensity is {gamma.intensity:.1%}, above the {gamma.intensity_threshold:.1%} qualification threshold.",
                f"Signed curvature pressure is {gamma.pressure:+.2f}, confirming the {side} Gamma-dynamics state.",
            ]
        return [
            f"Explosion {state.explosion.value:.2f} passed its {state.active_thresholds.get('explosion_min', 0):.2f} energy threshold.",
            f"Direction {state.direction.value:+.0f}/3 and signed pressure {state.pressure.value:+.2f} align {side}.",
            f"Options confidence {state.supporting_indicators.get('options_confidence', 0):.1%} passed while risk remained inside the active gate.",
        ]

    def process(
        self,
        state: MarketState,
        mode: EngineMode,
        price: float,
        price_source: str,
        price_observed_at: datetime,
        price_source_timestamp: datetime | None = None,
    ) -> list[dict[str, Any]]:
        now = state.timestamp
        symbol = state.symbol.upper()
        updates: list[dict[str, Any]] = []

        # First update all open windows with an observed price and current Greeks.
        for signal_id, record in list(self._active.items()):
            if record["symbol"] != symbol:
                continue
            scores = self._relative_scores(symbol, record["system"], state, Direction(record["direction"]))
            self._update_turning_points(record,price,now,scores)
            if price > record["highest_price"]:
                record["highest_price"] = price
                record["highest_at"] = now
                record["greek_scores_at_high"] = scores
            if price < record["lowest_price"]:
                record["lowest_price"] = price
                record["lowest_at"] = now
                record["greek_scores_at_low"] = scores
            sign = 1 if record["direction"] == Direction.UP.value else -1
            record["favorable_points"] = (
                record["highest_price"] - record["entry_price"]
                if sign > 0 else record["entry_price"] - record["lowest_price"]
            )
            record["adverse_points"] = (
                record["lowest_price"] - record["entry_price"]
                if sign > 0 else record["entry_price"] - record["highest_price"]
            )
            favorable_scores = record["greek_scores_at_high"] if sign > 0 else record["greek_scores_at_low"]
            baseline = record["greek_scores_at_signal"]
            if baseline and favorable_scores:
                record["decay_greek"] = max(
                    baseline, key=lambda name: baseline[name] - favorable_scores.get(name, baseline[name])
                )
            record["price_source"] = price_source
            record["price_observed_at"] = price_observed_at
            record["price_source_timestamp"] = price_source_timestamp
            if now >= record["expires_at"]:
                record["status"] = "COMPLETE"
                del self._active[signal_id]
            updates.append(dict(record))

        # Create one event per system after cooldown; this prevents five-second duplicates.
        for system, direction in self._qualified_systems(state):
            key = (symbol, system)
            if key in self._last_signal and now - self._last_signal[key] < self.cooldown:
                continue
            scores = self._relative_scores(symbol, system, state, direction)
            strongest, weakest = self._leaders(scores)
            call_id = self._call_id(now,system)
            # Internal persistence key stays under the existing VARCHAR(36)
            # contract. The two-digit stream inside call_id already separates
            # systems that fire during the same millisecond.
            signal_id = f"{call_id}-{symbol}"
            reversal_points=max(price*.0002,.01)
            record = {
                "id": signal_id,
                "call_id": call_id,
                "system": system,
                "mode": mode.value,
                "symbol": symbol,
                "proxy_for": "NQ" if system == "MOMENTUM_TRIAD" else None,
                "direction": direction.value,
                "alerted_at": now,
                "expires_at": now + self.horizon,
                "status": "TRACKING",
                "entry_price": price,
                "highest_price": price,
                "highest_at": now,
                "lowest_price": price,
                "lowest_at": now,
                "favorable_points": 0.0,
                "adverse_points": 0.0,
                "seconds_to_high": 0.0,
                "seconds_to_low": 0.0,
                "strongest_greek": strongest,
                "leading_greek": strongest,
                "weakest_greek": weakest,
                "decay_greek": weakest,
                "decision_reasons": self._decision_reasons(system, state, direction),
                "reversal_points":reversal_points,
                "swing_trend":"SEEKING",
                "turning_highs":[],
                "turning_lows":[],
                "candidate_high_price":price,
                "candidate_high_at":now,
                "candidate_high_scores":scores,
                "candidate_low_price":price,
                "candidate_low_at":now,
                "candidate_low_scores":scores,
                "greek_scores_at_signal": scores,
                "greek_scores_at_high": scores,
                "greek_scores_at_low": scores,
                "greek_values_at_signal": {
                    name: float(getattr(state.greeks, name)) for name in SYSTEM_GREEKS[system]
                } if state.greeks else {},
                "price_source": price_source,
                "price_observed_at": price_observed_at,
                "price_source_timestamp": price_source_timestamp,
                "nq_price": price if symbol == "NQ" else None,
                "qqq_price": price if symbol == "QQQ" else None,
            }
            self._active[signal_id] = record
            self._last_signal[key] = now
            updates.append(dict(record))

        for record in updates:
            record["seconds_to_high"] = max(
                0.0, (record["highest_at"] - record["alerted_at"]).total_seconds()
            )
            record["seconds_to_low"] = max(
                0.0, (record["lowest_at"] - record["alerted_at"]).total_seconds()
            )

        if state.greeks:
            for name in state.greeks.model_fields:
                self._history[symbol][name].append(abs(float(getattr(state.greeks, name))))
        return updates
