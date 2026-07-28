from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

from axiom.domain.models import MarketBar


SESSION_ORDER = ("OPENING", "LATE_MORNING", "LUNCH", "AFTERNOON", "POWER_HOUR")
DEFAULT_WINDOWS = {
    "OPENING": ("09:30", "10:45"),
    "LATE_MORNING": ("10:00", "12:30"),
    "LUNCH": ("11:30", "14:30"),
    "AFTERNOON": ("13:30", "15:15"),
    "POWER_HOUR": ("14:45", "16:00"),
}
DEFAULT_TRANSITION_WEIGHTS = {
    "OPENING": {"gamma": .35, "vanna": .35, "charm": .10, "confirmation": .20},
    "LATE_MORNING": {"gamma": .45, "vanna": .20, "charm": .25, "confirmation": .10},
    "LUNCH": {"gamma": .25, "vanna": .10, "charm": .45, "confirmation": .20},
    "AFTERNOON": {"gamma": .40, "vanna": .15, "charm": .25, "confirmation": .20},
    "POWER_HOUR": {"gamma": .40, "vanna": .05, "charm": .35, "confirmation": .20},
}
DEFAULT_ACTIVE_WEIGHTS = {
    "OPENING": {"gamma": .45, "vanna": .35, "charm": .20},
    "LATE_MORNING": {"gamma": .55, "vanna": .20, "charm": .25},
    "LUNCH": {"gamma": .35, "vanna": .15, "charm": .50},
    "AFTERNOON": {"gamma": .50, "vanna": .20, "charm": .30},
    "POWER_HOUR": {"gamma": .50, "vanna": .10, "charm": .40},
}


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _clock_minutes(value: str) -> int:
    hours, minutes = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def rolling_percentile(value: float, samples: Sequence[float]) -> float:
    """Deterministic empirical percentile; uses only observations already seen."""
    clean = [float(item) for item in samples if np.isfinite(item)]
    if not clean:
        return 0.0
    target = float(value)
    return _clamp((sum(item < target for item in clean) + .5 * sum(item == target for item in clean)) / len(clean))


def greek_features(name: str, current: MarketBar, history: Sequence[MarketBar]) -> dict[str, float]:
    values = [float(getattr(bar.greeks, name)) for bar in history]
    current_value = float(getattr(current.greeks, name))
    magnitude = rolling_percentile(abs(current_value), [abs(value) for value in values])
    prior = values[-1] if values else current_value
    changes = [abs(right - left) for left, right in zip(values, values[1:])]
    change = rolling_percentile(abs(current_value - prior), changes)
    return {
        "raw": current_value,
        "magnitude": magnitude,
        "change": change,
        "transition_signal": _clamp(.55 * magnitude + .45 * change),
    }


def market_confirmations(current: MarketBar, history: Sequence[MarketBar], contraction: bool) -> dict[str, Any]:
    volumes = [float(bar.volume) for bar in history]
    current_range = max(0.0, current.high - current.low) / max(current.close, 1e-9)
    ranges = [max(0.0, bar.high - bar.low) / max(bar.close, 1e-9) for bar in history]
    previous_close = history[-1].close if history else current.close
    current_return = abs(current.close / max(previous_close, 1e-9) - 1)
    returns = [abs(right.close / max(left.close, 1e-9) - 1) for left, right in zip(history, history[1:])]
    levels = {
        "volume": rolling_percentile(current.volume, volumes),
        "realized_volatility": rolling_percentile(current_return, returns),
        "range_expansion": rolling_percentile(current_range, ranges),
    }
    if contraction:
        flags = {name: value <= .40 for name, value in levels.items()}
        signals = {name: 1 - value for name, value in levels.items()}
    else:
        flags = {name: value >= .60 for name, value in levels.items()}
        signals = levels
    return {
        "levels": levels,
        "signals": signals,
        "flags": {
            "volume_confirmation": flags["volume"],
            "realized_volatility_confirmation": flags["realized_volatility"],
            "range_confirmation": flags["range_expansion"],
            "iv_confirmation": False,
        },
        "available_count": 3,
        "agreement_count": sum(flags.values()),
        "score": float(np.mean(list(signals.values()))) if signals else 0.0,
    }


class IntradaySessionClassifier:
    """Clock-gated session transition model and separate active-session Greek model."""

    def __init__(self, configuration: dict[str, Any] | None = None, timezone_name: str = "America/New_York"):
        cfg = configuration or {}
        self.timezone = ZoneInfo(timezone_name)
        self.windows = cfg.get("windows", DEFAULT_WINDOWS)
        self.transition_weights = cfg.get("transition_weights", DEFAULT_TRANSITION_WEIGHTS)
        self.active_weights = cfg.get("active_weights", DEFAULT_ACTIVE_WEIGHTS)
        self.transition_threshold = float(cfg.get("transition_threshold", .60))
        self.separation_threshold = float(cfg.get("separation_threshold", .15))
        self.persistence_bars = int(cfg.get("persistence_bars", 3))
        self.minimum_confirmations = int(cfg.get("minimum_confirmations", 2))
        self.early_close_dates = {str(value) for value in cfg.get("early_close_dates", [])}
        self._state: dict[str, dict[str, Any]] = {}
        self._previous_gamma_sign: dict[str, int] = {}
        self._validate_weights()

    def _validate_weights(self) -> None:
        for session in SESSION_ORDER:
            transition = self.transition_weights[session]
            active = self.active_weights[session]
            if not np.isclose(sum(float(value) for value in transition.values()), 1.0):
                raise ValueError(f"{session} transition weights must total 1.0")
            if not np.isclose(sum(float(value) for value in active.values()), 1.0):
                raise ValueError(f"{session} active weights must total 1.0")

    def _window(self, session: str, timestamp_et: datetime) -> tuple[int, int]:
        start, end = self.windows[session]
        start_minute, end_minute = _clock_minutes(start), _clock_minutes(end)
        if timestamp_et.date().isoformat() in self.early_close_dates:
            close_minute = 13 * 60
            end_minute = min(end_minute, close_minute)
            if session == "POWER_HOUR":
                start_minute = min(start_minute, close_minute - 75)
        return start_minute, end_minute

    def eligible_sessions(self, timestamp: datetime) -> list[str]:
        eastern = timestamp.astimezone(self.timezone)
        minute = eastern.hour * 60 + eastern.minute
        if minute < 9 * 60 + 30:
            return []
        close = 13 * 60 if eastern.date().isoformat() in self.early_close_dates else 16 * 60
        if minute > close:
            return []
        return [session for session in SESSION_ORDER if self._window(session, eastern)[0] <= minute <= self._window(session, eastern)[1]]

    def _clock_session(self, timestamp: datetime) -> str:
        eligible = self.eligible_sessions(timestamp)
        return eligible[-1] if eligible else "CLOSED"

    def calculate(self, current: MarketBar, history: Sequence[MarketBar]) -> dict[str, Any]:
        timestamp_et = current.timestamp.astimezone(self.timezone)
        prior = [bar for bar in history if bar.timestamp < current.timestamp]
        eligible = self.eligible_sessions(current.timestamp)
        if not eligible:
            return {
                "timestamp_et": timestamp_et.isoformat(),
                "clock_session": "CLOSED",
                "detected_session": "CLOSED",
                "session_state": "CURRENT",
                "transition_confidence": 0.0,
                "current_session_score": 0.0,
                "candidate_session_score": 0.0,
                "gamma_regime": "UNAVAILABLE",
                "greek_transition_support": {},
                "active_alert_weights": {},
                "effective_directional_weights": {},
                "confirmations": {},
                "active_greek_score": 0.0,
                "active_direction": "NEUTRAL",
                "directional_votes": {},
                "directional_agreement": 0,
                "price_confirmation": False,
                "directional_qualified": False,
                "alerts": ["LOW_CONFIDENCE_NO_TRADE"],
                "explanation": ["Outside configured regular trading hours."],
                "weight_status": "INITIAL_HYPOTHESIS_NOT_BACKTESTED",
            }

        features = {name: greek_features(name, current, prior) for name in ("gamma", "vanna", "charm")}
        symbol_state = self._state.setdefault(current.symbol, {
            "active": self._clock_session(current.timestamp), "candidate": None, "count": 0,
        })
        if symbol_state["active"] not in SESSION_ORDER:
            symbol_state["active"] = eligible[0]
        active = symbol_state["active"]
        active_index = SESSION_ORDER.index(active)
        later_eligible = [session for session in eligible if SESSION_ORDER.index(session) > active_index]
        candidates = later_eligible[-1:]  # chronological progression; never jump to an impossible clock window

        scores: dict[str, float] = {}
        confirmation_sets: dict[str, dict[str, Any]] = {}
        for session in set([active, *candidates]):
            confirmations = market_confirmations(current, prior, session == "LUNCH")
            confirmation_sets[session] = confirmations
            weights = self.transition_weights[session]
            scores[session] = _clamp(
                weights["gamma"] * features["gamma"]["transition_signal"]
                + weights["vanna"] * features["vanna"]["transition_signal"]
                + weights["charm"] * features["charm"]["transition_signal"]
                + weights["confirmation"] * confirmations["score"]
            )

        candidate = candidates[0] if candidates else None
        current_score = scores.get(active, 0.0)
        candidate_score = scores.get(candidate, 0.0) if candidate else 0.0
        confirmations = confirmation_sets.get(candidate or active, market_confirmations(current, prior, False))
        separation = candidate_score - current_score
        condition = bool(candidate and candidate_score >= self.transition_threshold
            and separation >= self.separation_threshold
            and confirmations["agreement_count"] >= self.minimum_confirmations)
        previous_candidate = symbol_state["candidate"]
        alerts: list[str] = []
        forced_by_clock=bool(candidate and active not in eligible)
        if forced_by_clock:
            active=candidate
            symbol_state.update(active=active,candidate=None,count=0)
            state_name="CONFIRMED"
            alerts.append("SESSION_TRANSITION_CONFIRMED")
        elif condition:
            if previous_candidate == candidate:
                symbol_state["count"] += 1
            else:
                symbol_state.update(candidate=candidate, count=1)
            state_name = "TRANSITIONING"
            alerts.append("SESSION_TRANSITION_DEVELOPING")
            if symbol_state["count"] >= self.persistence_bars:
                active = candidate
                symbol_state.update(active=active, candidate=None, count=0)
                state_name = "CONFIRMED"
                alerts = ["SESSION_TRANSITION_CONFIRMED"]
        else:
            if previous_candidate is not None:
                alerts.append("SESSION_TRANSITION_FAILED")
            symbol_state.update(candidate=None, count=0)
            state_name = "CURRENT"

        persistence = 1.0 if state_name == "CONFIRMED" else symbol_state["count"] / max(self.persistence_bars, 1)
        separation_strength = _clamp(max(0.0, separation) / max(self.separation_threshold * 2, 1e-9))
        confirmation_rate = confirmations["agreement_count"] / max(confirmations["available_count"], 1)
        confidence = 100 * _clamp(.40 * candidate_score + .20 * separation_strength
            + .20 * persistence + .20 * confirmation_rate)

        weights = self.active_weights[active]
        # IV change is unavailable in the current adapter. Vanna therefore
        # remains visible as magnitude evidence but receives no direction.
        directional_available = {"gamma": True, "vanna": False, "charm": True}
        available_weight = sum(weights[name] for name, available in directional_available.items() if available)
        effective_weights = {
            name: (weights[name] / available_weight if available and available_weight else 0.0)
            for name, available in directional_available.items()
        }
        directional_signals = {
            "gamma": np.sign(features["gamma"]["raw"]) * features["gamma"]["magnitude"],
            "vanna": 0.0,
            "charm": np.sign(features["charm"]["raw"]) * features["charm"]["magnitude"],
        }
        votes = {name: (1 if value >= .20 else -1 if value <= -.20 else 0) for name, value in directional_signals.items()}
        nonzero_votes = [vote for vote in votes.values() if vote]
        agreement = max(nonzero_votes.count(1), nonzero_votes.count(-1)) if nonzero_votes else 0
        agreed_sign = 1 if nonzero_votes.count(1) >= 2 else -1 if nonzero_votes.count(-1) >= 2 else 0
        signed_score = sum(effective_weights[name] * directional_signals[name] for name in directional_signals)
        lookback_close = prior[-3].close if len(prior) >= 3 else prior[0].close if prior else current.close
        price_sign = int(current.close > lookback_close) - int(current.close < lookback_close)
        price_confirmation = agreed_sign != 0 and price_sign == agreed_sign
        directional_qualified = agreement >= 2 and price_confirmation
        active_direction = "UP" if directional_qualified and agreed_sign > 0 else "DOWN" if directional_qualified else "NEUTRAL"
        if directional_qualified:
            alerts.append("ACTIVE_SESSION_BULLISH_ALIGNMENT" if agreed_sign > 0 else "ACTIVE_SESSION_BEARISH_ALIGNMENT")
        elif len(set(nonzero_votes)) > 1:
            alerts.append("ACTIVE_SESSION_CONFLICT")

        gamma_sign = int(features["gamma"]["raw"] > 0) - int(features["gamma"]["raw"] < 0)
        previous_gamma = self._previous_gamma_sign.get(current.symbol, gamma_sign)
        self._previous_gamma_sign[current.symbol] = gamma_sign
        gamma_regime = "POSITIVE_ESTIMATED" if gamma_sign > 0 else "NEGATIVE_ESTIMATED" if gamma_sign < 0 else "NEUTRAL"
        if gamma_sign:
            alerts.append("GAMMA_REGIME_POSITIVE" if gamma_sign > 0 else "GAMMA_REGIME_NEGATIVE")
        if previous_gamma and gamma_sign and previous_gamma != gamma_sign:
            alerts.append("ZERO_GAMMA_CROSS")
        if features["gamma"]["change"] >= .75 and gamma_sign < 0:
            alerts.append("GAMMA_ACCELERATION")
        if features["charm"]["magnitude"] >= .75:
            alerts.append("CHARM_HEDGE_PRESSURE")
        if confidence < 50 or not directional_qualified:
            alerts.append("LOW_CONFIDENCE_NO_TRADE")

        transition_session = candidate or active
        transition_weights = self.transition_weights[transition_session]
        support = {}
        for name in ("gamma", "vanna", "charm"):
            signal = features[name]["transition_signal"]
            support[name] = {
                "weight": transition_weights[name],
                "normalized_signal": signal,
                "weighted_contribution": transition_weights[name] * signal,
                "direction": "SUPPORTS_TRANSITION" if signal >= .60 else "CONTRADICTS_TRANSITION" if signal <= .25 else "NEUTRAL",
            }
        explanation = [
            f"Clock permits {', '.join(eligible)}; impossible sessions were excluded.",
            f"{transition_session.replace('_', ' ').title()} transition score is {candidate_score if candidate else current_score:.2f}.",
            f"Gamma, Vanna and Charm use rolling magnitude/change percentiles; {confirmations['agreement_count']}/3 available market confirmations agree.",
            "Vanna is excluded from direction because near-term ATM IV change is unavailable.",
            f"Active {active.replace('_', ' ').title()} weights are Gamma {weights['gamma']:.0%}, Vanna {weights['vanna']:.0%}, Charm {weights['charm']:.0%}.",
        ]
        return {
            "timestamp_et": timestamp_et.isoformat(),
            "clock_session": self._clock_session(current.timestamp),
            "detected_session": active,
            "candidate_session": candidate,
            "session_state": state_name,
            "transition_confidence": round(confidence, 2),
            "current_session_score": round(current_score, 6),
            "candidate_session_score": round(candidate_score, 6),
            "gamma_regime": gamma_regime,
            "greek_transition_support": support,
            "active_alert_weights": weights,
            "effective_directional_weights": effective_weights,
            "confirmations": confirmations["flags"],
            "confirmation_levels": confirmations["levels"],
            "active_greek_score": round(float(signed_score), 6),
            "active_direction": active_direction,
            "directional_votes": votes,
            "directional_agreement": agreement,
            "price_confirmation": price_confirmation,
            "directional_qualified": directional_qualified,
            "alerts": list(dict.fromkeys(alerts)),
            "explanation": explanation,
            "weight_status": "INITIAL_HYPOTHESIS_NOT_BACKTESTED",
            "data_limitations": {
                "dealer_positioning_observed": False,
                "open_interest_is_realtime": False,
                "atm_iv_change_available": False,
                "same_time_20_day_baseline_available": False,
            },
        }
