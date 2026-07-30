from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from axiom.domain.enums import Direction, EngineMode
from axiom.domain.models import MarketState


SYSTEM_GREEKS = {
    "PRIMARY_OPTIONS": ("gamma", "vanna", "charm", "speed", "zomma", "color", "ultima"),
    "GAMMA_DYNAMICS": ("zomma", "color", "speed", "gamma"),
}


class OutcomeAttributionTracker:
    """Tracks observed excursions after qualified, independent system decisions."""

    def __init__(
        self,
        horizon_minutes: int = 60,
        cooldown_seconds: int = 300,
        qqq_points_per_50_nq: float = 1.235,
    ):
        self.horizon = timedelta(minutes=horizon_minutes)
        self.cooldown = timedelta(seconds=cooldown_seconds)
        self.qqq_points_per_50_nq = float(qqq_points_per_50_nq)
        self._active: dict[str, dict[str, Any]] = {}
        self._last_signal: dict[tuple[str, str], datetime] = {}
        self._episode_direction: dict[tuple[str, str], Direction] = {}
        self._history: dict[str, dict[str, deque[float]]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=100))
        )
        self.eastern = ZoneInfo("America/New_York")

    @staticmethod
    def _direction_sign(direction: Direction) -> int:
        return 1 if direction == Direction.UP else -1

    def _target_spec(self, symbol: str) -> dict[str, Any]:
        """Describe the target without pretending that QQQ and NQ share a point scale."""
        if symbol == "QQQ":
            return {
                "target_points": self.qqq_points_per_50_nq,
                "target_basis": "NQ_50_POINT_EQUIVALENT",
                "target_nq_points": 50.0,
                "target_conversion_method": "CONFIGURED_QQQ_PROXY",
                "target_conversion_quality": "ESTIMATED_NO_LIVE_NQ",
                "target_label": "50 NQ-POINT EQUIVALENT",
            }
        return {
            "target_points": 50.0,
            "target_basis": "INSTRUMENT_POINTS",
            "target_nq_points": 50.0 if symbol in {"NQ", "NDX"} else None,
            "target_conversion_method": "DIRECT_INSTRUMENT_POINTS",
            "target_conversion_quality": "OBSERVED_INSTRUMENT_SCALE",
            "target_label": f"50 {symbol} POINTS",
        }

    @staticmethod
    def _qualified_systems(state: MarketState) -> list[tuple[str, Direction]]:
        systems: list[tuple[str, Direction]] = []
        if state.options_bias_qualified and state.options_bias != Direction.NEUTRAL:
            systems.append(("PRIMARY_OPTIONS", state.options_bias))
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

    def _expire(self, record: dict[str, Any]) -> None:
        """Close an untouched path using its last real observation."""
        scores = record.get("greek_scores_current", {})
        strongest, weakest = self._leaders(scores)
        final_price = float(record.get("current_price", record["entry_price"]))
        target = float(record["target_price"])
        is_long = record["direction"] == Direction.UP.value
        shortfall = max(0.0, target-final_price if is_long else final_price-target)
        favorable = max(0.0, float(record.get("favorable_points", 0.0)))
        partial_threshold = float(record.get("partial_target_points", float(record["target_points"]) * 0.6))
        record.update(
            status="EXPIRED",
            lifecycle_state="COMPLETE",
            completion_reason="HORIZON_EXPIRED",
            outcome_grade="PARTIAL" if favorable >= partial_threshold else "FAILED",
            final_favorable_points=favorable,
            expired_at=record["expires_at"],
            final_price=final_price,
            final_price_at=record.get("current_price_at", record["expires_at"]),
            seconds_observed=max(0.0, (record["expires_at"]-record["alerted_at"]).total_seconds()),
            target_shortfall_points=shortfall,
            strongest_greek_current=strongest,
            weakest_greek_current=weakest,
        )

    def _call_id(self,timestamp:datetime,system:str)->str:
        stream={"PRIMARY_OPTIONS":1,"GAMMA_DYNAMICS":3}[system]
        eastern=timestamp.astimezone(self.eastern)
        milliseconds=eastern.microsecond//1000
        return f"{eastern:%Y%m%d%H%M%S}{milliseconds:03d}{stream:02d}"

    @staticmethod
    def _minute_bucket(timestamp:datetime)->datetime:
        return timestamp.replace(second=0,microsecond=0)

    @staticmethod
    def _update_lifecycle(record:dict[str,Any],now:datetime)->None:
        """Describe whether an active path is strengthening, stale, or reversing."""
        if str(record.get("status","TRACKING")).upper()!="TRACKING":
            record["lifecycle_state"]="COMPLETE"
            return
        entry=float(record["entry_price"])
        current=float(record.get("current_price",entry))
        sign=1 if record["direction"]==Direction.UP.value else -1
        current_favorable=sign*(current-entry)
        maximum=max(0.0,float(record.get("favorable_points",0.0)))
        retention=max(0.0,min(1.0,current_favorable/maximum)) if maximum>0 else 0.0
        last_extreme=record.get("last_favorable_extreme_at",record["alerted_at"])
        minutes_since=max(0.0,(now-last_extreme).total_seconds()/60)
        confirm_points=float(record.get(
            "confirmation_points",
            record.get("partial_target_points",record.get("target_points",1.0)),
        ))
        record.update(
            current_favorable_points=current_favorable,
            favorable_retained_pct=retention,
            minutes_since_favorable_extreme=minutes_since,
        )
        if maximum>=confirm_points and retention<0.5:
            lifecycle="REVERSING"
        elif maximum>=confirm_points and minutes_since>=5:
            lifecycle="STALLED"
        elif maximum>=confirm_points and minutes_since<1:
            lifecycle="EXTENDING"
        elif maximum>=confirm_points:
            lifecycle="CONFIRMING"
        else:
            lifecycle="DETECTED"
        record["lifecycle_state"]=lifecycle

    @staticmethod
    def _update_risk_family(record:dict[str,Any],price:float,now:datetime)->None:
        """Activate equal-weight child legs at the configured adverse levels."""
        legs=record.get("family_legs")
        if not legs:
            return
        parent=float(record["entry_price"])
        is_long=record["direction"]==Direction.UP.value
        adverse=max(0.0,parent-price if is_long else price-parent)
        thresholds=[float(value) for value in record.get("family_trigger_levels",[0.0,4.0,6.0,8.0])]
        active_thresholds={float(leg["trigger_adverse_points"]) for leg in legs}
        for leg_number,threshold in enumerate(thresholds[1:],start=2):
            if adverse<threshold or threshold in active_thresholds:
                continue
            datum=parent-threshold if is_long else parent+threshold
            legs.append({
                "call_id":f"{record['call_id']}.1.{leg_number}",
                "leg_number":leg_number,
                "role":"CHILD",
                "trigger_adverse_points":threshold,
                "datum":datum,
                "observed_trigger_price":price,
                "activated_at":now,
            })
            active_thresholds.add(threshold)
        datums=[float(leg["datum"]) for leg in legs]
        average=sum(datums)/len(datums)
        leg_pl=[
            (price-datum if is_long else datum-price)
            for datum in datums
        ]
        for leg,value in zip(legs,leg_pl):
            leg["current_pl_points"]=value
        average_pl=sum(leg_pl)/len(leg_pl)
        next_trigger=next((value for value in thresholds[1:] if value not in active_thresholds),None)
        if average_pl>0:
            outcome="PROFIT"
        elif average_pl<0:
            outcome="LOSS"
        else:
            outcome="BREAK_EVEN"
        record.update(
            family_active_legs=len(legs),
            family_average_datum=average,
            family_total_pl_points=sum(leg_pl),
            family_average_pl_points=average_pl,
            family_outcome_state=outcome,
            family_stage=f"{len(legs)} OF {len(thresholds)} LEGS",
            family_next_trigger_points=next_trigger,
            family_last_updated_at=now,
        )

    def _update_minute_path(self,record:dict[str,Any],price:float,now:datetime,
        scores:dict[str,float])->None:
        """Aggregate observed prices into one-minute OHLC candles for this call."""
        bucket=self._minute_bucket(now)
        bars=record["minute_bars"]
        new_bar=not bars or bars[-1]["timestamp"]!=bucket
        if new_bar:
            if bars and record.get("target_reached_at") and record.get("target_close_confirmed") is None:
                prior_close=float(bars[-1]["close"])
                target=float(record["target_price"])
                is_long=record["direction"]==Direction.UP.value
                record["target_close_confirmed"]=prior_close>=target if is_long else prior_close<=target
                record["target_close_price"]=prior_close
            bars.append({"timestamp":bucket,"open":price,"high":price,"low":price,"close":price,"samples":1})
        else:
            candle=bars[-1]
            candle["high"]=max(float(candle["high"]),price)
            candle["low"]=min(float(candle["low"]),price)
            candle["close"]=price
            candle["samples"]=int(candle.get("samples",0))+1

        if record.get("target_reached_at") is not None:
            return
        target=float(record["target_price"])
        is_long=record["direction"]==Direction.UP.value
        reached=price>=target if is_long else price<=target
        if not reached:
            return
        strongest,weakest=self._leaders(scores)
        baseline=record.get("greek_scores_at_signal",{})
        decays={name:float(baseline[name])-float(scores.get(name,baseline[name])) for name in baseline}
        decay=max(decays,key=decays.get) if decays else None
        record.update(
            status="TARGET_REACHED",
            target_reached_at=now,
            target_reached_price=price,
            seconds_to_target=max(0.0,(now-record["alerted_at"]).total_seconds()),
            target_touch_type="OPEN" if new_bar else ("HIGH" if is_long else "LOW"),
            strongest_greek_at_target=strongest,
            weakest_greek_at_target=weakest,
            decay_greek_at_target=decay,
            greek_scores_at_target=scores,
        )

    @staticmethod
    def _decision_reasons(system: str, state: MarketState, direction: Direction) -> list[str]:
        side = "bullish" if direction == Direction.UP else "bearish"
        sign_word = "positive" if direction == Direction.UP else "negative"
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
            # A price first observed after the declared horizon cannot be used
            # to manufacture a target touch. Finalize from the last stored tick.
            if record.get("target_reached_at") is None and now > record["expires_at"]:
                self._expire(record)
                del self._active[signal_id]
                updates.append(dict(record))
                continue
            scores = self._relative_scores(symbol, record["system"], state, Direction(record["direction"]))
            self._update_minute_path(record,price,now,scores)
            target_minute=self._minute_bucket(record["target_reached_at"]) if record.get("target_reached_at") else None
            if target_minute is not None and self._minute_bucket(now)>target_minute:
                # The new-minute observation only closes the preceding target
                # candle. It is not part of this call's completed path.
                if record["minute_bars"] and record["minute_bars"][-1]["timestamp"]>target_minute:
                    record["minute_bars"].pop()
                final_price=float(record.get("target_close_price")
                    or record.get("target_reached_price") or record["entry_price"])
                record.update(
                    status="COMPLETE",completion_reason="TARGET_REACHED",
                    lifecycle_state="COMPLETE",
                    outcome_grade="SUCCESS",final_favorable_points=max(
                        float(record["target_points"]),float(record.get("favorable_points",0.0))),
                    final_price=final_price,final_price_at=now,
                    current_price=final_price,current_price_at=now,
                )
                del self._active[signal_id]
                updates.append(dict(record))
                continue
            strongest_current, weakest_current = self._leaders(scores)
            record.update(
                current_price=price,
                current_price_at=now,
                greek_scores_current=scores,
                strongest_greek_current=strongest_current,
                weakest_greek_current=weakest_current,
            )
            if symbol == "QQQ":
                record["qqq_price"] = price
            elif symbol == "NQ":
                record["nq_price"] = price
            new_high=price > record["highest_price"]
            new_low=price < record["lowest_price"]
            if new_high:
                record["highest_price"] = price
                record["highest_at"] = now
                record["greek_scores_at_high"] = scores
            if new_low:
                record["lowest_price"] = price
                record["lowest_at"] = now
                record["greek_scores_at_low"] = scores
            sign = 1 if record["direction"] == Direction.UP.value else -1
            new_favorable_extreme=new_high if sign>0 else new_low
            if new_favorable_extreme:
                record["last_favorable_extreme_at"]=now
                record["favorable_extreme_count"]=int(record.get("favorable_extreme_count",0))+1
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
            record["dynamic_high"] = record["highest_price"]
            record["dynamic_low"] = record["lowest_price"]
            self._update_risk_family(record,price,now)
            self._update_lifecycle(record,now)
            if record.get("target_reached_at") is None and now >= record["expires_at"]:
                self._expire(record)
                del self._active[signal_id]
            updates.append(dict(record))

        # A continuing signal remains one episode. When it becomes neutral or
        # reverses, its independent price path keeps running until its target
        # is reached or the configured observation horizon expires.
        qualified=self._qualified_systems(state)
        current={system:direction for system,direction in qualified}
        for key,previous_direction in list(self._episode_direction.items()):
            episode_symbol,system=key
            if episode_symbol!=symbol:continue
            next_direction=current.get(system)
            if next_direction==previous_direction:continue
            if next_direction is None:del self._episode_direction[key]

        for system, direction in qualified:
            key = (symbol, system)
            if self._episode_direction.get(key)==direction:continue
            self._episode_direction[key]=direction
            # A flickering qualified state must not create several logical
            # calls that all track the same unresolved directional episode.
            # Opposite-direction calls remain independent and may overlap.
            same_direction_active=any(
                record["symbol"]==symbol
                and record["system"]==system
                and record["direction"]==direction.value
                and record.get("target_reached_at") is None
                for record in self._active.values()
            )
            if same_direction_active:
                continue
            scores = self._relative_scores(symbol, system, state, direction)
            strongest, weakest = self._leaders(scores)
            call_id = self._call_id(now,system)
            # Internal persistence key stays under the existing VARCHAR(36)
            # contract. The two-digit stream inside call_id already separates
            # systems that fire during the same millisecond.
            signal_id = f"{call_id}-{symbol}"
            target_spec=self._target_spec(symbol)
            target_points=float(target_spec["target_points"])
            target_price=price+target_points if direction==Direction.UP else price-target_points
            record = {
                "id": signal_id,
                "call_id": call_id,
                "system": system,
                "mode": mode.value,
                "symbol": symbol,
                "proxy_for": None,
                "direction": direction.value,
                "alerted_at": now,
                "expires_at": now + self.horizon,
                "status": "TRACKING",
                "outcome_grade":"TRACKING",
                "entry_price": price,
                "target_points":target_points,
                "partial_target_points":target_points*0.6,
                "target_price":target_price,
                **target_spec,
                "target_reached_at":None,
                "target_reached_price":None,
                "seconds_to_target":None,
                "target_touch_type":None,
                "target_close_confirmed":None,
                "target_close_price":None,
                "expired_at":None,
                "final_price":None,
                "final_price_at":None,
                "seconds_observed":0.0,
                "target_shortfall_points":target_points,
                "strongest_greek_at_target":None,
                "weakest_greek_at_target":None,
                "decay_greek_at_target":None,
                "greek_scores_at_target":{},
                "minute_bars":[{
                    "timestamp":self._minute_bucket(now),
                    "open":price,"high":price,"low":price,"close":price,"samples":1,
                }],
                "highest_price": price,
                "highest_at": now,
                "lowest_price": price,
                "lowest_at": now,
                "dynamic_high": price,
                "dynamic_low": price,
                "current_price": price,
                "current_price_at": now,
                "favorable_points": 0.0,
                "adverse_points": 0.0,
                "seconds_to_high": 0.0,
                "seconds_to_low": 0.0,
                "strongest_greek": strongest,
                "leading_greek": strongest,
                "weakest_greek": weakest,
                "strongest_greek_current": strongest,
                "weakest_greek_current": weakest,
                "decay_greek": weakest,
                "decision_reasons": self._decision_reasons(system, state, direction),
                "greek_scores_at_signal": scores,
                "greek_scores_current": scores,
                "greek_scores_at_high": scores,
                "greek_scores_at_low": scores,
                "greek_values_at_signal": {
                    name: float(getattr(state.greeks, name)) for name in SYSTEM_GREEKS[system]
                } if state.greeks else {},
                "gamma_dynamics_at_signal": (
                    state.gamma_dynamics.model_dump(mode="json")
                    if system == "GAMMA_DYNAMICS" and state.gamma_dynamics else None
                ),
                "price_source": price_source,
                "price_observed_at": price_observed_at,
                "price_source_timestamp": price_source_timestamp,
                "nq_price": price if symbol == "NQ" else None,
                "qqq_price": price if symbol == "QQQ" else None,
                "family_id":call_id,
                "family_parent_call_id":f"{call_id}.1",
                "family_trigger_levels":[0.0,4.0,6.0,8.0],
                "family_legs":[{
                    "call_id":f"{call_id}.1",
                    "leg_number":1,
                    "role":"PARENT",
                    "trigger_adverse_points":0.0,
                    "datum":price,
                    "observed_trigger_price":price,
                    "activated_at":now,
                    "current_pl_points":0.0,
                }],
                "family_active_legs":1,
                "family_average_datum":price,
                "family_total_pl_points":0.0,
                "family_average_pl_points":0.0,
                "family_outcome_state":"BREAK_EVEN",
                "family_stage":"1 OF 4 LEGS",
                "family_next_trigger_points":4.0,
                "family_last_updated_at":now,
            }
            self._active[signal_id] = record
            self._last_signal[key] = now
            updates.append(dict(record))

        updates=list({record["id"]:record for record in updates}.values())
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
