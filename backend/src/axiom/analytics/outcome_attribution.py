from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from axiom.domain.enums import Direction, EngineMode
from axiom.domain.models import MarketState


SYSTEM_GREEKS = {
    "PRIMARY_OPTIONS": ("gamma", "vanna", "charm", "speed", "zomma", "color", "ultima"),
    "GAMMA_DYNAMICS": ("zomma", "color", "speed", "gamma"),
    "GAMMA_DYNAMICS_V2": ("zomma", "color", "speed", "gamma", "vomma", "ultima"),
    "DELTA_DYNAMICS": ("ultima", "zomma", "gamma", "speed", "color", "delta"),
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
        # Gamma 1.0 is deliberately conservative: a qualified opposite
        # snapshot must persist before it can close and replace an open call.
        self.gamma_v1_reversal_confirmations = 3
        self.gamma_v1_reversal_min_adverse_points = 0.25
        self._gamma_v1_reversal: dict[tuple[str, str], dict[str, Any]] = {}
        self._history: dict[str, dict[str, deque[float]]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=100))
        )
        self.eastern = ZoneInfo("America/New_York")

    @staticmethod
    def _restore_datetime(value: Any) -> Any:
        if not isinstance(value,str):
            return value
        try:
            return datetime.fromisoformat(value.replace("Z","+00:00"))
        except ValueError:
            return value

    def restore_active(self, records: list[dict[str, Any]]) -> int:
        """Rehydrate persisted tracking paths after a process restart.

        The browser can refresh freely: its call cards come from the same
        persisted records. This method additionally lets the server continue
        updating the existing minute path rather than creating a new call.
        """
        restored=0
        datetime_fields=("alerted_at","expires_at","highest_at","lowest_at","current_price_at",
            "price_observed_at","price_source_timestamp","target_reached_at","final_price_at","expired_at")
        for stored in records:
            if str(stored.get("status") or "").upper()!="TRACKING" or not stored.get("id"):
                continue
            record=dict(stored)
            for field in datetime_fields:
                if field in record:
                    record[field]=self._restore_datetime(record[field])
            record["minute_bars"]=[{**bar,"timestamp":self._restore_datetime(bar.get("timestamp"))}
                for bar in record.get("minute_bars") or []]
            record["admission_audit"]=[{**item,"timestamp":self._restore_datetime(item.get("timestamp"))}
                for item in record.get("admission_audit") or []]
            record["shadow_challengers"]=[{
                **shadow,
                "started_at":self._restore_datetime(shadow.get("started_at")),
                "last_qualified_at":self._restore_datetime(shadow.get("last_qualified_at")),
                "target_reached_at":self._restore_datetime(shadow.get("target_reached_at")),
                "completed_at":self._restore_datetime(shadow.get("completed_at")),
                "minute_bars":[{**bar,"timestamp":self._restore_datetime(bar.get("timestamp"))} for bar in shadow.get("minute_bars") or []],
            } for shadow in record.get("shadow_challengers") or []]
            self._active[record["id"]]=record
            if record.get("system")=="GAMMA_DYNAMICS":
                key=(str(record.get("symbol","")).upper(),"GAMMA_DYNAMICS")
                self._episode_direction[key]=Direction(record["direction"])
                if isinstance(record.get("alerted_at"),datetime):
                    self._last_signal[key]=record["alerted_at"]
            restored+=1
        return restored

    @staticmethod
    def _direction_sign(direction: Direction) -> int:
        return 1 if direction == Direction.UP else -1

    def _target_spec(self, symbol: str, timestamp: datetime, system: str | None = None) -> dict[str, Any]:
        """Describe the target without pretending that QQQ and NQ share a point scale."""
        if symbol == "QQQ":
            eastern=timestamp.astimezone(self.eastern)
            if system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"}:
                morning=eastern.weekday()<5 and time(9,30)<=eastern.time()<time(12,0)
                target_points=1.25 if morning else .75
                return {
                    "target_points":target_points,
                    "target_basis":"GAMMA_NYSE_OPEN_TO_NOON_1_25_ELSE_0_75",
                    "target_nq_points":None,
                    "target_conversion_method":"GAMMA_SESSION_POINT_TARGET",
                    "target_conversion_quality":"OBSERVED_INSTRUMENT_SCALE",
                    "target_label":"1.25-POINT OPEN-TO-NOON REACH" if morning else "0.75-POINT OFF-HOURS REACH",
                }
            regular_hours=eastern.weekday()<5 and time(9,30)<=eastern.time()<time(16,0)
            target_points=1.25 if regular_hours else .25
            return {
                "target_points": target_points,
                "target_basis": "NYSE_RTH_1_25_ELSE_0_25",
                "target_nq_points": 50.0,
                "target_conversion_method": "NYSE_SESSION_POINT_TARGET",
                "target_conversion_quality": "OBSERVED_INSTRUMENT_SCALE",
                "target_label": "1.25-POINT RTH REACH" if regular_hours else "0.25-POINT EXTENDED-HOURS REACH",
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
    def _active_parent(records: dict[str, dict[str, Any]], symbol: str, system: str) -> tuple[str, dict[str, Any]] | None:
        """Return the one unresolved parent call for a system/symbol pair."""
        for signal_id, record in records.items():
            if record["symbol"] == symbol and record["system"] == system and record.get("status") == "TRACKING":
                return signal_id, record
        return None

    @staticmethod
    def _append_admission_audit(record: dict[str, Any], now: datetime, reason: str, candidate: Direction, confirmations: int = 0) -> None:
        audit=list(record.get("admission_audit") or [])
        audit.append({"timestamp":now,"reason":reason,"candidate_direction":candidate.value,"confirmations":confirmations})
        record["admission_audit"]=audit[-50:]
        record["suppressed_signal_count"]=int(record.get("suppressed_signal_count",0))+1
        record["last_suppressed_signal"]={"timestamp":now,"reason":reason,"candidate_direction":candidate.value,"confirmations":confirmations}

    def _finalize_gamma_v1_reversal(self, record: dict[str, Any], now: datetime, price: float, candidate: Direction) -> None:
        """Close an active Gamma 1.0 call before a confirmed opposite call opens."""
        scores=dict(record.get("greek_scores_current") or {})
        ordered=[name for name,_ in sorted(scores.items(),key=lambda item:(-float(item[1]),item[0]))]
        record.update(
            status="REVERSED", lifecycle_state="COMPLETE",
            completion_reason="CONFIRMED_OPPOSITE_SIGNAL",
            outcome_grade="REVERSED", success_basis=None,
            reversed_at=now, reversal_direction=candidate.value,
            final_price=price, final_price_at=now, current_price=price, current_price_at=now,
            seconds_observed=max(0.0,(now-record["alerted_at"]).total_seconds()),
            greek_scores_at_failure=scores,
            greek_rankings_at_failure={"strongest":ordered[:1],"strong":ordered[1:2],"normal":ordered[2:4],"weak":ordered[4:5],"weakest":ordered[5:6]},
            greek_values_at_failure=dict(record.get("greek_values_current") or {}),
        )

    def _start_or_update_shadow(self, record: dict[str, Any], now: datetime, price: float,
        direction: Direction, confirmations: int, state: MarketState) -> None:
        """Paper-track a suppressed Gamma 1.0 opposite candidate."""
        shadows=list(record.get("shadow_challengers") or [])
        shadow=next((item for item in reversed(shadows) if item.get("status")=="TRACKING" and item.get("direction")==direction.value),None)
        if shadow is None:
            points=float(record["target_points"])
            shadow={
                "id":f"{record['call_id']}.shadow.{len(shadows)+1}","direction":direction.value,
                "status":"TRACKING","started_at":now,"entry_price":price,"current_price":price,
                "target_points":points,"target_price":price+points if direction==Direction.UP else price-points,
                "highest_price":price,"lowest_price":price,"minute_bars":[{"timestamp":self._minute_bucket(now),"open":price,"high":price,"low":price,"close":price,"samples":1}],
                "qualification_snapshot":state.gamma_dynamics.model_dump(mode="json") if state.gamma_dynamics else None,
            }
            shadows.append(shadow)
        shadow["confirmations"]=confirmations
        shadow["last_qualified_at"]=now
        record["shadow_challengers"]=shadows[-20:]

    def _update_shadow_challengers(self, record: dict[str, Any], now: datetime, price: float) -> None:
        if record.get("system")!="GAMMA_DYNAMICS":
            return
        for shadow in record.get("shadow_challengers") or []:
            if shadow.get("status")!="TRACKING":
                continue
            bucket=self._minute_bucket(now);bars=shadow["minute_bars"]
            if not bars or bars[-1]["timestamp"]!=bucket:
                bars.append({"timestamp":bucket,"open":price,"high":price,"low":price,"close":price,"samples":1})
            else:
                bar=bars[-1];bar["high"]=max(float(bar["high"]),price);bar["low"]=min(float(bar["low"]),price);bar["close"]=price;bar["samples"]=int(bar.get("samples",0))+1
            shadow["current_price"]=price;shadow["highest_price"]=max(float(shadow["highest_price"]),price);shadow["lowest_price"]=min(float(shadow["lowest_price"]),price)
            if price>=float(shadow["target_price"]) if shadow["direction"]==Direction.UP.value else price<=float(shadow["target_price"]):
                shadow.update(status="TARGET_REACHED",target_reached_at=now,target_reached_price=price)

    def _finalize_shadow_challengers(self, record: dict[str, Any], now: datetime, price: float, reason: str) -> None:
        """Compare paper challengers with the real parent when its path ends."""
        active_sign=1.0 if record["direction"]==Direction.UP.value else -1.0
        active_pnl=active_sign*(float(record.get("final_price",record.get("current_price",price)))-float(record["entry_price"]))
        for shadow in record.get("shadow_challengers") or []:
            if shadow.get("status")!="COMPLETE":
                shadow_price=float(shadow.get("final_price",shadow.get("target_reached_price",shadow.get("current_price",price))))
                shadow_sign=1.0 if shadow["direction"]==Direction.UP.value else -1.0
                shadow_pnl=float(shadow.get("hypothetical_pnl_points",shadow_sign*(shadow_price-float(shadow["entry_price"]))))
                shadow.update(status="COMPLETE",completed_at=now,completion_reason=reason,final_price=shadow_price,hypothetical_pnl_points=shadow_pnl,
                    comparison={"active_pnl_points":active_pnl,"shadow_pnl_points":shadow_pnl,"better_path":"SHADOW" if shadow_pnl>active_pnl else "ACTIVE" if active_pnl>shadow_pnl else "TIE"})

    @staticmethod
    def _qualified_systems(state: MarketState) -> list[tuple[str, Direction]]:
        systems: list[tuple[str, Direction]] = []
        if state.options_bias_qualified and state.options_bias != Direction.NEUTRAL:
            systems.append(("PRIMARY_OPTIONS", state.options_bias))
        gamma = state.gamma_dynamics
        if gamma and gamma.qualified and gamma.decision != Direction.NEUTRAL:
            systems.append(("GAMMA_DYNAMICS", gamma.decision))
        gamma_v2 = getattr(state,"gamma_dynamics_v2",None)
        if gamma_v2 and gamma_v2.qualified and gamma_v2.decision != Direction.NEUTRAL:
            systems.append(("GAMMA_DYNAMICS_V2", gamma_v2.decision))
        zone = getattr(state,"zone_intelligence",None)
        if zone and zone.qualified and zone.direction != Direction.NEUTRAL:
            systems.append(("DELTA_DYNAMICS", zone.direction))
        return systems

    def _relative_scores(self, symbol: str, system: str, state: MarketState, direction: Direction) -> dict[str, float]:
        greeks = state.greeks
        if greeks is None:
            return {}
        direction_sign = self._direction_sign(direction)
        if system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"}:
            model = getattr(state,"gamma_dynamics_v2",None) if system == "GAMMA_DYNAMICS_V2" else state.gamma_dynamics
            if model:
                normalized=getattr(model,"normalized",{})
                return {
                    name: (
                        direction_sign * (1 if float(getattr(greeks,name)) > 0 else -1 if float(getattr(greeks,name)) < 0 else 0) * abs(float(normalized.get(name,0)))
                        if name == "speed" else abs(float(normalized.get(name,0)))
                    ) for name in SYSTEM_GREEKS[system]
                }
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
            # Gamma Dynamics uses Speed as its signed price-direction term.
            # The other terms are curvature/context magnitudes because their
            # raw signs are not directionally interpretable without a complete
            # strike/moneyness and IV-change surface.
            scores[name] = (
                direction_sign * sign * percentile
                if system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"} and name == "speed"
                else percentile if system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"}
                else direction_sign * sign * percentile
            )
        return scores

    @staticmethod
    def _leaders(scores: dict[str, float]) -> tuple[str | None, str | None]:
        if not scores:
            return None, None
        return max(scores, key=scores.get), min(scores, key=scores.get)

    @staticmethod
    def _rankings(scores: dict[str, float]) -> dict[str, list[str]]:
        """Place six deterministic Greek scores into five ordered audit bands."""
        ordered=[name for name,_ in sorted(scores.items(),key=lambda item:(-float(item[1]),item[0]))]
        if not ordered:
            return {name:[] for name in ("strongest","strong","normal","weak","weakest")}
        # Six inputs map to five labels; the two middle inputs share NORMAL.
        slots={"strongest":ordered[:1],"strong":ordered[1:2],"normal":ordered[2:4],"weak":ordered[4:5],"weakest":ordered[5:6]}
        return slots

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
        directional_success = record.get("system") in {"GAMMA_DYNAMICS", "GAMMA_DYNAMICS_V2"} and (
            final_price > float(record["entry_price"]) if is_long else final_price < float(record["entry_price"])
        )
        record.update(
            status="EXPIRED",
            lifecycle_state="COMPLETE",
            completion_reason="HORIZON_EXPIRED",
            outcome_grade="SUCCESS" if directional_success else "PARTIAL" if favorable >= partial_threshold else "FAILED",
            success_basis="DIRECTIONAL_FINAL" if directional_success else None,
            final_favorable_points=favorable,
            expired_at=record["expires_at"],
            final_price=final_price,
            final_price_at=record.get("current_price_at", record["expires_at"]),
            seconds_observed=max(0.0, (record["expires_at"]-record["alerted_at"]).total_seconds()),
            target_shortfall_points=shortfall,
            strongest_greek_current=strongest,
            weakest_greek_current=weakest,
            greek_scores_at_failure=dict(scores),
            greek_rankings_at_failure=self._rankings(scores),
            greek_values_at_failure=dict(record.get("greek_values_current", {})),
        )

    def finalize_active(self, reason: str, ended_at: datetime | None = None) -> list[dict[str, Any]]:
        """Close live calls at their last real tick when their stream ends."""
        updates: list[dict[str, Any]] = []
        for signal_id, record in list(self._active.items()):
            if record.get("system") not in {"GAMMA_DYNAMICS", "GAMMA_DYNAMICS_V2"}:
                continue
            last_observed = record.get("current_price_at") or record.get("price_observed_at") or record["alerted_at"]
            final_at = min(ended_at, last_observed) if ended_at and last_observed else (ended_at or last_observed)
            scores = dict(record.get("greek_scores_current") or {})
            strongest, weakest = self._leaders(scores)
            final_price = float(record.get("current_price", record["entry_price"]))
            favorable = max(0.0, float(record.get("favorable_points", 0.0)))
            partial_threshold = float(record.get("partial_target_points", float(record["target_points"]) * .6))
            reached = record.get("target_reached_at") is not None
            is_long = record["direction"] == Direction.UP.value
            directional_success = final_price > float(record["entry_price"]) if is_long else final_price < float(record["entry_price"])
            record.update(
                status="COMPLETE" if reached else "INTERRUPTED",
                lifecycle_state="COMPLETE",
                completion_reason=reason,
                outcome_grade="SUCCESS" if reached or directional_success else "PARTIAL" if favorable >= partial_threshold else "FAILED",
                success_basis="TARGET" if reached else "DIRECTIONAL_FINAL" if directional_success else None,
                final_favorable_points=favorable,
                final_price=final_price,
                final_price_at=final_at,
                current_price=final_price,
                seconds_observed=max(0.0, (final_at-record["alerted_at"]).total_seconds()),
                strongest_greek_current=strongest,
                weakest_greek_current=weakest,
                greek_scores_at_failure={} if reached else scores,
                greek_rankings_at_failure={} if reached else self._rankings(scores),
                greek_values_at_failure={} if reached else dict(record.get("greek_values_current", {})),
            )
            self._finalize_shadow_challengers(record,final_at,final_price,reason)
            updates.append(dict(record))
            del self._active[signal_id]
        if updates:
            self._episode_direction.clear()
        return updates

    def _call_id(self,timestamp:datetime,system:str)->str:
        stream={"PRIMARY_OPTIONS":1,"GAMMA_DYNAMICS":3,"DELTA_DYNAMICS":4,"GAMMA_DYNAMICS_V2":5}[system]
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
    def _update_risk_family(record:dict[str,Any],price:float,now:datetime,state:MarketState)->None:
        """Activate child legs, requalifying deeper Gamma levels before entry."""
        legs=record.get("family_legs")
        if not legs:
            return
        parent=float(record["entry_price"])
        is_long=record["direction"]==Direction.UP.value
        adverse=max(0.0,parent-price if is_long else price-parent)
        gamma_family=record.get("system") in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"}
        thresholds=[float(value) for value in record.get(
            "family_trigger_levels",
            [0.0,2.0,4.0,6.0,8.0] if gamma_family else [0.0,4.0,6.0,8.0],
        )]
        active_thresholds={float(leg["trigger_adverse_points"]) for leg in legs}
        rechecks=dict(record.get("family_gamma_rechecks") or {})
        for leg_number,threshold in enumerate(thresholds[1:],start=2):
            if adverse<threshold or threshold in active_thresholds:
                continue
            gamma=(getattr(state,"gamma_dynamics_v2",None) if record.get("system")=="GAMMA_DYNAMICS_V2" else state.gamma_dynamics) if gamma_family else None
            requires_recheck=gamma_family and threshold>=4.0
            direction_match=bool(gamma and gamma.decision.value==record["direction"])
            qualified=bool(gamma and gamma.qualified and direction_match)
            recheck={
                "checked_at":now,
                "threshold_adverse_points":threshold,
                "required":requires_recheck,
                "qualified":qualified if requires_recheck else True,
                "direction_match":direction_match if requires_recheck else True,
                "decision":gamma.decision.value if gamma else Direction.NEUTRAL.value,
                "intensity":float(gamma.intensity) if gamma else 0.0,
                "pressure":float(gamma.pressure) if gamma else 0.0,
                "explanation":gamma.explanation if gamma else "Gamma Dynamics unavailable at this observation.",
            }
            rechecks[str(int(threshold))]=recheck
            if requires_recheck and not qualified:
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
                "gamma_recheck":recheck,
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
            leg["status"]=(
                "SUCCEEDED" if value>0
                else "FAILED" if value<0
                else "FLAT"
            )
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
            family_gamma_rechecks=rechecks,
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
            greek_rankings_at_target=self._rankings(scores),
            greek_values_at_target=dict(record.get("greek_values_current", {})),
        )

    @staticmethod
    def _decision_reasons(system: str, state: MarketState, direction: Direction) -> list[str]:
        side = "bullish" if direction == Direction.UP else "bearish"
        sign_word = "positive" if direction == Direction.UP else "negative"
        if system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"}:
            gamma = getattr(state,"gamma_dynamics_v2",None) if system=="GAMMA_DYNAMICS_V2" else state.gamma_dynamics
            if not gamma:return []
            if system == "GAMMA_DYNAMICS_V2":
                metrics = gamma.chain_metrics
                return [
                    f"Key Fault Line {metrics.get('key_fault_line', 0):.2f} carries Net GEX {metrics.get('net_gex_key', 0):+.3g}; squeeze score is {gamma.squeeze_score:+.3f}.",
                    f"OI-weighted Charm plus Net Dealer Delta establish the {side} direction; model probability is {gamma.probability:.1%}.",
                    f"Weighted Speed, Color, liquidity, ATM spread, market-time, and cooldown gates passed for Gamma Dynamics 2.0.",
                ]
            inputs = gamma.inputs
            version = "2.0" if system == "GAMMA_DYNAMICS_V2" else "1.0"
            intensity_terms = "Zomma/Color/Vomma/Ultima" if system == "GAMMA_DYNAMICS_V2" else "Zomma/Color"
            greek_count = "six" if system == "GAMMA_DYNAMICS_V2" else "four"
            return [
                f"Speed {inputs.get('speed', 0):+.4g} supplies the {side} direction while Gamma magnitude {abs(inputs.get('gamma', 0)):.4g} supplies the active curvature base.",
                f"{intensity_terms} normalized intensity is {gamma.intensity:.1%}, against the {gamma.intensity_threshold:.1%} qualification threshold.",
                f"Signed {greek_count}-Greek curvature pressure is {gamma.pressure:+.2f}, confirming the {side} Gamma Dynamics {version} state.",
            ]
        if system == "DELTA_DYNAMICS" and state.zone_intelligence:
            zone=state.zone_intelligence
            passed=sum(zone.rule_checks.get(zone.zone,{}).values())
            total=len(zone.rule_checks.get(zone.zone,{}))
            return [
                f"{zone.zone.replace('_',' ').title()} matched {passed}/{total} numerical gates for a {zone.score:.1%} zone score.",
                f"Normalized Delta {zone.normalized.get('delta',0):+.3f} and Speed {zone.normalized.get('speed',0):+.3f} produce the {side} call.",
                f"Rolling normalization uses clipped three-sigma z-scores; confidence is {zone.confidence:.1%}.",
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
                self._finalize_shadow_challengers(record,now,float(record.get("final_price",record.get("current_price",price))),"PARENT_HORIZON_EXPIRED")
                del self._active[signal_id]
                updates.append(dict(record))
                continue
            scores = self._relative_scores(symbol, record["system"], state, Direction(record["direction"]))
            greek_values = ({name:float(getattr(state.greeks,name)) for name in SYSTEM_GREEKS[record["system"]]} if state.greeks else {})
            greek_highs = dict(record.get("greek_values_highest") or record.get("greek_values_at_signal") or greek_values)
            greek_lows = dict(record.get("greek_values_lowest") or record.get("greek_values_at_signal") or greek_values)
            for name,value in greek_values.items():
                greek_highs[name]=max(float(greek_highs.get(name,value)),value)
                greek_lows[name]=min(float(greek_lows.get(name,value)),value)
            record.update(greek_values_current=greek_values,greek_values_highest=greek_highs,greek_values_lowest=greek_lows)
            self._update_minute_path(record,price,now,scores)
            self._update_shadow_challengers(record,now,price)
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
                    outcome_grade="SUCCESS",success_basis="TARGET",final_favorable_points=max(
                        float(record["target_points"]),float(record.get("favorable_points",0.0))),
                    final_price=final_price,final_price_at=now,
                    current_price=final_price,current_price_at=now,
                )
                self._finalize_shadow_challengers(record,now,final_price,"PARENT_TARGET_REACHED")
                del self._active[signal_id]
                updates.append(dict(record))
                continue
            strongest_current, weakest_current = self._leaders(scores)
            record.update(
                current_price=price,
                current_price_at=now,
                seconds_observed=max(0.0,(now-record["alerted_at"]).total_seconds()),
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
            self._update_risk_family(record,price,now,state)
            self._update_lifecycle(record,now)
            if record.get("target_reached_at") is None and now >= record["expires_at"]:
                self._expire(record)
                self._finalize_shadow_challengers(record,now,float(record.get("final_price",record.get("current_price",price))),"PARENT_HORIZON_EXPIRED")
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
            if next_direction is None:
                del self._episode_direction[key]
                if system=="GAMMA_DYNAMICS":self._gamma_v1_reversal.pop(key,None)

        for system, direction in qualified:
            key = (symbol, system)
            # Gamma 1.0 permits one unresolved parent only. Same-direction
            # repeats are confirmations; an opposite direction is only allowed
            # after three consecutive qualified observations and a meaningful
            # adverse move from the active call's entry price.
            if system=="GAMMA_DYNAMICS":
                active_parent=self._active_parent(self._active,symbol,system)
                if active_parent:
                    active_id,active=active_parent
                    active_direction=Direction(active["direction"])
                    if active_direction==direction:
                        self._episode_direction[key]=direction
                        self._gamma_v1_reversal.pop(key,None)
                        for shadow in active.get("shadow_challengers") or []:
                            if shadow.get("status")=="TRACKING":
                                sign=1.0 if shadow["direction"]==Direction.UP.value else -1.0
                                shadow.update(status="INVALIDATED",completed_at=now,completion_reason="OPPOSITE_QUALIFICATION_LOST",final_price=price,
                                    hypothetical_pnl_points=sign*(price-float(shadow["entry_price"])))
                        self._append_admission_audit(active,now,"DUPLICATE_SAME_DIRECTION",direction)
                        continue
                    active_sign=1.0 if active_direction==Direction.UP else -1.0
                    adverse=max(0.0,active_sign*(float(active["entry_price"])-float(price)))
                    candidate=self._gamma_v1_reversal.get(key)
                    confirmations=(int(candidate.get("confirmations",0))+1 if candidate and candidate.get("direction")==direction.value else 1)
                    self._gamma_v1_reversal[key]={"direction":direction.value,"confirmations":confirmations,"first_seen_at":candidate.get("first_seen_at",now) if candidate and candidate.get("direction")==direction.value else now}
                    self._start_or_update_shadow(active,now,price,direction,confirmations,state)
                    if confirmations<self.gamma_v1_reversal_confirmations or adverse<self.gamma_v1_reversal_min_adverse_points:
                        reason="OPPOSITE_AWAITING_CONFIRMATION" if confirmations<self.gamma_v1_reversal_confirmations else "OPPOSITE_MOVE_TOO_SMALL"
                        self._append_admission_audit(active,now,reason,direction,confirmations)
                        continue
                    self._append_admission_audit(active,now,"CONFIRMED_OPPOSITE_REVERSAL",direction,confirmations)
                    self._finalize_gamma_v1_reversal(active,now,price,direction)
                    self._finalize_shadow_challengers(active,now,price,"SHADOW_PROMOTED_TO_CONFIRMED_REVERSAL")
                    del self._active[active_id]
                    updates.append(dict(active))
                    self._gamma_v1_reversal.pop(key,None)
            if self._episode_direction.get(key)==direction:continue
            self._episode_direction[key]=direction
            # A flickering qualified state must not create several logical
            # calls that all track the same unresolved directional episode.
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
            target_spec=self._target_spec(symbol,now,system)
            if system=="DELTA_DYNAMICS" and symbol!="QQQ":
                target_spec={**target_spec,"target_points":1.25,"target_basis":"ZONE_1_25_POINT_REACH",
                    "target_conversion_method":"DIRECT_ZONE_INSTRUMENT_POINTS",
                    "target_conversion_quality":"OBSERVED_INSTRUMENT_SCALE",
                    "target_label":"1.25-POINT REACH"}
            target_points=float(target_spec["target_points"])
            target_price=price+target_points if direction==Direction.UP else price-target_points
            expires_at=now+self.horizon
            if system=="GAMMA_DYNAMICS_V2" and state.gamma_dynamics_v2:
                metrics=state.gamma_dynamics_v2.chain_metrics
                # The v2 execution model uses the real-zero-gamma take-profit
                # for fades when it is available, and observes a 10-minute
                # hedge window / 20-minute normal timeout.
                model_target=float(metrics.get("take_profit", 0.0) or 0.0)
                if model_target>0:
                    target_price=model_target
                    target_points=abs(model_target-price)
                eastern_now=now.astimezone(self.eastern).time()
                hedge_windows=((time(9,55),time(10,5)),(time(11,55),time(12,5)),(time(14,55),time(15,5)),(time(15,40),time(15,50)))
                timeout_minutes=10 if any(start<=eastern_now<=end for start,end in hedge_windows) else 20
                expires_at=now+timedelta(minutes=timeout_minutes)
            record = {
                "id": signal_id,
                "call_id": call_id,
                "system": system,
                "mode": mode.value,
                "symbol": symbol,
                "proxy_for": None,
                "direction": direction.value,
                "alerted_at": now,
                "expires_at": expires_at,
                "status": "TRACKING",
                "outcome_grade":"TRACKING",
                "admission_policy":"GAMMA_V1_SINGLE_PARENT_CONFIRMED_REVERSAL" if system=="GAMMA_DYNAMICS" else "STANDARD",
                "admission_audit":[],
                "suppressed_signal_count":0,
                "shadow_challengers":[],
                "reversal_confirmations_required":self.gamma_v1_reversal_confirmations if system=="GAMMA_DYNAMICS" else None,
                "reversal_min_adverse_points":self.gamma_v1_reversal_min_adverse_points if system=="GAMMA_DYNAMICS" else None,
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
                "greek_scores_at_failure":{},
                "greek_rankings_at_target":{},
                "greek_rankings_at_failure":{},
                "greek_values_at_target":{},
                "greek_values_at_failure":{},
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
                "greek_rankings_at_signal": self._rankings(scores),
                "greek_scores_current": scores,
                "greek_scores_at_high": scores,
                "greek_scores_at_low": scores,
                "greek_values_at_signal": {
                    name: float(getattr(state.greeks, name)) for name in SYSTEM_GREEKS[system]
                } if state.greeks else {},
                "greek_values_current": {
                    name: float(getattr(state.greeks, name)) for name in SYSTEM_GREEKS[system]
                } if state.greeks else {},
                "greek_values_highest": {
                    name: float(getattr(state.greeks, name)) for name in SYSTEM_GREEKS[system]
                } if state.greeks else {},
                "greek_values_lowest": {
                    name: float(getattr(state.greeks, name)) for name in SYSTEM_GREEKS[system]
                } if state.greeks else {},
                "gamma_dynamics_at_signal": (
                    state.gamma_dynamics.model_dump(mode="json")
                    if system == "GAMMA_DYNAMICS" and state.gamma_dynamics else None
                ),
                "gamma_dynamics_v2_at_signal": (
                    state.gamma_dynamics_v2.model_dump(mode="json")
                    if system == "GAMMA_DYNAMICS_V2" and getattr(state,"gamma_dynamics_v2",None) else None
                ),
                "zone_intelligence_at_signal": (
                    state.zone_intelligence.model_dump(mode="json")
                    if system == "DELTA_DYNAMICS" and state.zone_intelligence else None
                ),
                "price_source": price_source,
                "price_observed_at": price_observed_at,
                "price_source_timestamp": price_source_timestamp,
                "nq_price": price if symbol == "NQ" else None,
                "qqq_price": price if symbol == "QQQ" else None,
                "family_id":call_id,
                "family_parent_call_id":f"{call_id}.1",
                "family_trigger_levels":[0.0,2.0,4.0,6.0,8.0] if system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"} else [0.0,4.0,6.0,8.0],
                "family_legs":[{
                    "call_id":f"{call_id}.1",
                    "leg_number":1,
                    "role":"PARENT",
                    "trigger_adverse_points":0.0,
                    "datum":price,
                    "observed_trigger_price":price,
                    "activated_at":now,
                    "current_pl_points":0.0,
                    "status":"FLAT",
                }],
                "family_active_legs":1,
                "family_average_datum":price,
                "family_total_pl_points":0.0,
                "family_average_pl_points":0.0,
                "family_outcome_state":"BREAK_EVEN",
                "family_stage":"1 OF 5 LEGS" if system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"} else "1 OF 4 LEGS",
                "family_next_trigger_points":2.0 if system in {"GAMMA_DYNAMICS","GAMMA_DYNAMICS_V2"} else 4.0,
                "family_last_updated_at":now,
                "family_gamma_rechecks":{},
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
