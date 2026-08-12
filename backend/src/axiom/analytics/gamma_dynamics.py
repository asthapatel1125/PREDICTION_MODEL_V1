from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, time
from math import sqrt
from zoneinfo import ZoneInfo

from axiom.domain.enums import Direction
from axiom.domain.models import GammaDynamics, Greeks


GAMMA_DYNAMICS_V1_GREEKS = ("zomma", "color", "speed", "gamma")
GAMMA_DYNAMICS_V2_GREEKS = (*GAMMA_DYNAMICS_V1_GREEKS, "vomma", "ultima")
GAMMA_DYNAMICS_V2_IDEALS = {
    "zomma": 0.40,
    "color": 0.35,
    "speed": 0.30,
    "gamma": 0.25,
    "vomma": 0.30,
    "ultima": 0.40,
}


class GammaDynamicsSix:
    """Gamma Dynamics 2.0: chain-level dealer-positioning model.

    The public result continues to expose the six native Greeks for the live
    stream and event log. Qualification itself is calculated from the
    contract-level, open-interest-weighted features in the supplied spec.
    """

    feature_weights = {
        "gamma_squeeze_score": 0.35,
        "weighted_charm": 0.20,
        "weighted_speed": 0.15,
        "weighted_vanna": 0.15,
        "weighted_color": 0.10,
        "net_dealer_delta": 0.10,
    }

    def __init__(self, intensity_threshold: float = 0.65, minimum_history: int = 720,
                 zero_tolerance: float = 1e-12, speed_threshold: float = 0.30,
                 color_threshold: float = -0.35, cooldown_seconds: int = 600,
                 market_timezone: str = "America/New_York"):
        self.intensity_threshold = intensity_threshold
        self.minimum_history = minimum_history
        self.zero_tolerance = zero_tolerance
        self.speed_threshold = speed_threshold
        self.color_threshold = color_threshold
        self.cooldown_seconds = cooldown_seconds
        self.market_tz = ZoneInfo(market_timezone)
        self._last_alert: dict[str, datetime] = {}

    @staticmethod
    def _absolute_percentile(current: float, values: Sequence[float]) -> float:
        finite = [abs(float(value)) for value in values]
        if not finite:
            return 0.0
        target = abs(float(current))
        below = sum(value < target for value in finite)
        equal = sum(value == target for value in finite)
        return min(1.0, max(0.0, (below + 0.5 * equal) / len(finite)))

    def _scaled(self, current: float, values: Sequence[float]) -> float:
        samples = [float(value) for value in values]
        if not samples:
            return 0.0
        mean = sum(samples) / len(samples)
        variance = sum((value - mean) ** 2 for value in samples) / len(samples)
        standard_deviation = sqrt(variance)
        # Greek units span many orders of magnitude. An absolute 1e-12 floor
        # incorrectly flattened real variation in small higher-order Greeks.
        # Only treat dispersion at machine precision relative to the series
        # level as constant; otherwise apply the requested z-score formula.
        numerical_floor = max(abs(mean) * 1e-15, 1e-18)
        if standard_deviation <= numerical_floor:
            return 0.0
        return max(-3.0, min(3.0, (float(current) - mean) / standard_deviation)) / 3.0

    def calculate(self, greeks: Greeks, history: Sequence[Greeks], source_symbol: str,
                  chain_metrics: dict[str, object] | None = None,
                  metric_history: Sequence[dict[str, object]] = (),
                  timestamp: datetime | None = None) -> GammaDynamics:
        inputs = {name: float(getattr(greeks, name)) for name in GAMMA_DYNAMICS_V2_GREEKS}
        samples = list(history)
        percentiles = {name: self._absolute_percentile(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        normalized = {name: self._scaled(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        # Preserve structured per-strike wall records alongside numeric chain
        # features; only arithmetic fields are converted at their use sites.
        metrics = dict(chain_metrics or {})
        metric_samples = list(metric_history)
        # Primary bars are one minute, so five earlier observations represent
        # the specification's t - 300 second ATM-IV reference point.
        previous_iv = metric_samples[-5].get("atm_iv", 0.0) if len(metric_samples) >= 5 else 0.0
        iv_available = metrics.get("atm_iv_available", 0.0) > 0 and previous_iv > self.zero_tolerance
        metrics["iv_expansion"] = (metrics.get("atm_iv", 0.0) - previous_iv) / previous_iv if iv_available else 0.0
        metrics["iv_expansion_available"] = float(iv_available)
        # OI is delayed. Infer the intervening flow from the change in raw
        # GEX after removing the observed Color and Speed components, then
        # forward-fill it across the standard 15-minute OI lag.
        previous = metric_samples[-1] if metric_samples else {}
        spot = metrics.get("spot", 0.0)
        prior_spot = previous.get("spot", spot)
        delta_spot = spot - prior_spot
        dt_seconds = max(0.0, metrics.get("observed_epoch", 0.0) - previous.get("observed_epoch", 0.0)) if previous else 0.0
        # A historical provider can omit observation epochs; retain the live
        # engine's five-second cadence rather than treating the interval as 0.
        dt_seconds = dt_seconds or (5.0 if previous else 0.0)
        flow_hack = (
            metrics.get("gex_raw", 0.0) - previous.get("gex_raw", metrics.get("gex_raw", 0.0))
            - metrics.get("color_ex", 0.0) * dt_seconds - metrics.get("speed_ex", 0.0) * delta_spot
        ) if previous else 0.0
        metrics["flow_dt_seconds"] = dt_seconds
        metrics["flow_hack"] = flow_hack
        metrics["gex_real"] = metrics.get("gex_raw", 0.0) + flow_hack * 15.0
        gamma_denominator = abs(metrics.get("gamma_open_interest", 0.0) * spot ** 2 * .01 * 100.0) + 1.0
        metrics["vol_hack"] = flow_hack / gamma_denominator
        flow_samples = []
        for earlier, later in zip(metric_samples[-720:-1], metric_samples[-719:]):
            change_spot = later.get("spot", 0.0) - earlier.get("spot", 0.0)
            interval=max(0.0,later.get("observed_epoch",0.0)-earlier.get("observed_epoch",0.0)) or 5.0
            flow_samples.append(later.get("gex_raw", 0.0) - earlier.get("gex_raw", 0.0) - later.get("color_ex", 0.0) * interval - later.get("speed_ex", 0.0) * change_spot)
        flow_samples.append(flow_hack)
        positive_flow = sum(value for value in flow_samples if value > 0)
        negative_flow = sum(-value for value in flow_samples if value < 0)
        total_oi = max(metrics.get("total_open_interest", 0.0), 1.0)
        metrics["rr"] = positive_flow / (negative_flow + 1.0)
        metrics["dr"] = -negative_flow / total_oi
        outflow_average = negative_flow / max(len(flow_samples), 1)
        flow_change = flow_samples[-1] - flow_samples[-2] if len(flow_samples) > 1 else 0.0
        metrics["rr_t10"] = metrics["rr"] + (flow_change * 10.0) / max(outflow_average, 1.0)
        metrics["dr_t10"] = metrics["dr"] + (negative_flow - positive_flow) / total_oi * 10.0
        dealer_flow = -metrics["vol_hack"] * metrics.get("dex", 0.0)
        metrics["dealer_flow"] = dealer_flow
        metrics["pos_inventory"] = max(0.0, dealer_flow) * 720.0
        metrics["neg_inventory"] = min(0.0, dealer_flow) * 720.0
        density_samples = [item.get("gex_density", 0.0) for item in metric_samples[-11:]] + [metrics.get("gex_density", 0.0)]
        metrics["tw_gex"] = sum(density_samples) / max(len(density_samples), 1)
        metrics["spoof_score"] = abs(metrics.get("gex_raw", 0.0) - previous.get("gex_raw", metrics.get("gex_raw", 0.0))) / (abs(metrics["vol_hack"]) + 1.0)
        metrics["damping"] = 1.0 + metrics.get("gex_dollar_density", 0.0) / max(metrics.get("market_depth", 0.0), 1.0)
        distance_support = abs(spot - metrics.get("support_level", spot)) + .001 * max(spot, 1.0)
        metrics["fade_score"] = metrics.get("gex_dollar_density", 0.0) * metrics["pos_inventory"] * metrics["rr_t10"] / distance_support
        metrics["amp_score"] = abs(metrics.get("gex_dollar_density", 0.0)) * abs(metrics["neg_inventory"]) * metrics["dr_t10"] * abs(metrics.get("speed_ex", 0.0))
        theta_boost = 3.0 if timestamp and timestamp.astimezone(self.market_tz).time() >= time(15, 30) else 1.0
        gex_real = metrics["gex_real"]
        charm_shift = metrics.get("charm_ex", 0.0) / (gex_real if abs(gex_real) > 1e-12 else 1.0) * spot * 10.0 * theta_boost
        metrics["ksup_t10"] = metrics.get("support_level", spot) + charm_shift
        metrics["kres_t10"] = metrics.get("resistance_level", spot) + charm_shift
        metrics["edge"] = abs(metrics["kres_t10"] - metrics["ksup_t10"]) / max(metrics.get("atm_spread", 0.0), .01)
        metrics["urgency_minutes"] = abs(metrics.get("dex", 0.0)) / max(abs(metrics.get("charm_ex", 0.0)), 1.0)
        metrics["final_score_clean"] = (
            (metrics["fade_score"] - metrics["amp_score"]) * metrics.get("concentration", 0.0) * metrics["edge"] / 4.0
            * metrics["tw_gex"] / (abs(metrics.get("gex_density", 0.0)) + .1) / (metrics["spoof_score"] + .5)
        )
        normalized_features = {
            name: self._scaled(metrics.get(name, 0.0), [item.get(name, 0.0) for item in metric_samples])
            for name in self.feature_weights
        }
        squeeze_score = sum(self.feature_weights[name] * normalized_features[name] for name in self.feature_weights)
        probability = min(0.95, max(0.0, 0.50 + squeeze_score / 20.0))
        direction_value = metrics.get("net_dealer_delta", 0.0) + metrics.get("weighted_charm", 0.0)
        direction = Direction.UP if direction_value > self.zero_tolerance else Direction.DOWN if direction_value < -self.zero_tolerance else Direction.NEUTRAL
        observed_at = timestamp.astimezone(self.market_tz) if timestamp else None
        active_window = bool(observed_at and (
            time(10, 0) <= observed_at.time() <= time(11, 30)
            or time(13, 30) <= observed_at.time() <= time(15, 30)
        ))
        previous_alert = self._last_alert.get(source_symbol)
        cooldown_ok = previous_alert is None or timestamp is None or (timestamp - previous_alert).total_seconds() >= self.cooldown_seconds
        warmed = len(metric_samples) >= self.minimum_history
        fade = metrics["fade_score"] > 120.0 and metrics["amp_score"] < 60.0
        amp = metrics["amp_score"] > 2.0 * metrics["fade_score"] and metrics["amp_score"] > 120.0 and metrics["dr_t10"] > .7
        regime = "FADE" if fade else "AMP" if amp else "WAIT"
        metrics["regime"] = regime
        metrics["entry"] = metrics["ksup_t10"] if fade else metrics["kres_t10"] if amp else 0.0
        metrics["take_profit"] = metrics.get("zero_gamma", 0.0) if fade else 0.0
        metrics["stop_loss"] = metrics["entry"] * (.998 if fade else 1.002) if metrics["entry"] else 0.0
        checks = {
            "chain_available": metrics.get("chain_available", 0.0) > 0,
            "baseline": warmed,
            "regime": regime != "WAIT",
            "density": metrics.get("gex_dollar_density", 0.0) > 100_000_000.0 if fade else True,
            "persistence": metrics["tw_gex"] > .7 if fade else True,
            "spoof": metrics["spoof_score"] < 2.0,
            "flow_ratio": metrics["rr_t10"] > 1.2 if fade else metrics["dr_t10"] > .7,
            "inventory": metrics["pos_inventory"] > 300_000_000.0 if fade else True,
            "edge": metrics["edge"] > 4.0,
            "liquidity": metrics.get("liquidity_score", float("inf")) < .6,
            "urgency": metrics["urgency_minutes"] < 10.0,
            "vix": metrics.get("vix", 0.0) < 22.0 if fade else True,
            "news": not (metrics.get("high_impact_news", 0.0) > 0 and observed_at and time(9, 55) <= observed_at.time() <= time(10, 15)),
            "active_window": active_window,
            "cooldown": cooldown_ok,
        }
        qualified = all(checks.values())
        if qualified and timestamp is not None:
            self._last_alert[source_symbol] = timestamp
        decision = (Direction.UP if fade else Direction.DOWN if amp else Direction.NEUTRAL) if qualified else Direction.NEUTRAL
        pressure = (1.0 if direction == Direction.UP else -1.0 if direction == Direction.DOWN else 0.0) * min(1.0, abs(squeeze_score) / 3.0)
        intensity = probability
        contributions = {name: self.feature_weights[name] * normalized_features[name] for name in self.feature_weights}
        ideal_ranges = {
            "zomma": "native stream display; chain model uses OI-weighted features",
            "color": "normalized weighted Color < -0.35",
            "speed": "|normalized weighted Speed| > 0.30",
            "gamma": "Net GEX determines the Key Fault Line",
            "ultima": "native stream display; preserved for the six-Greek engine",
            "vomma": "native stream display; preserved for the six-Greek engine",
        }
        if not checks["chain_available"]:
            explanation = "Waiting for a contract-level option-chain snapshot; aggregate Greeks alone cannot calculate Gamma Dynamics 2.0."
        elif not warmed:
            explanation = f"Building the chain-feature baseline: {len(metric_samples)}/{self.minimum_history} observations."
        elif not qualified:
            failed = ", ".join(name.replace("_", " ") for name, passed in checks.items() if not passed)
            explanation = f"Chain model is not actionable: {failed} gate{'s' if ',' in failed else ''} not satisfied."
        else:
            explanation = (
                f"OI-weighted Charm plus Net Dealer Delta establish {direction.value.lower()} direction; "
                f"GEX fault-line pressure, Speed, Color, liquidity, spread, time, and cooldown all qualify."
            )
        return GammaDynamics(
            decision=decision, qualified=qualified, source_symbol=source_symbol, intensity=intensity,
            pressure=pressure, history_points=len(metric_samples), intensity_threshold=self.intensity_threshold,
            inputs=inputs, percentiles=percentiles, normalized=normalized,
            contributions=contributions, ideal_ranges=ideal_ranges, chain_metrics=metrics,
            normalized_features=normalized_features, squeeze_score=squeeze_score,
            probability=probability,
            target_price=(metrics.get("spot", 0.0) + 0.75 * (1 if direction == Direction.UP else -1)) if metrics.get("spot", 0.0) > 0 and direction != Direction.NEUTRAL else None,
            alert_checks=checks, explanation=explanation,
        )


class GammaDynamicsQuartet(GammaDynamicsSix):
    """Original Gamma Dynamics 1.0: Zomma, Color, Speed, and Gamma."""

    def calculate(self, greeks: Greeks, history: Sequence[Greeks], source_symbol: str) -> GammaDynamics:
        inputs = {name: float(getattr(greeks, name)) for name in GAMMA_DYNAMICS_V1_GREEKS}
        samples = list(history)
        percentiles = {name: self._absolute_percentile(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        normalized = {name: self._scaled(value, [getattr(item, name) for item in samples]) for name, value in inputs.items()}
        intensity = (abs(normalized["zomma"]) + abs(normalized["color"])) / 2
        pressure_magnitude = (abs(normalized["speed"]) + abs(normalized["gamma"])) / 2
        gamma_active = abs(inputs["gamma"]) > self.zero_tolerance
        aligned_up = inputs["speed"] > self.zero_tolerance and gamma_active
        aligned_down = inputs["speed"] < -self.zero_tolerance and gamma_active
        pressure = pressure_magnitude if aligned_up else -pressure_magnitude if aligned_down else 0.0
        warmed = len(samples) >= self.minimum_history
        qualified = warmed and intensity >= self.intensity_threshold and (aligned_up or aligned_down)
        decision = Direction.UP if qualified and aligned_up else Direction.DOWN if qualified and aligned_down else Direction.NEUTRAL
        contributions = {
            "zomma": .5 * abs(normalized["zomma"]), "color": .5 * abs(normalized["color"]),
            "speed": .5 * abs(normalized["speed"]) * (1 if aligned_up else -1 if aligned_down else 0),
            "gamma": .5 * abs(normalized["gamma"]),
        }
        ideal_ranges = {
            "zomma":"|normalized| >= 0.30",
            "color":"|normalized| >= 0.30",
            "speed":"|normalized| >= 0.30 and signed with the call direction",
            "gamma":"|normalized| >= 0.30; active curvature base",
        }
        if not warmed:
            explanation=f"Building a relative baseline: {len(samples)}/{self.minimum_history} observations."
        elif not gamma_active or abs(inputs["speed"])<=self.zero_tolerance:
            explanation="Gamma or Speed is effectively zero, so signed curvature pressure is not confirmed."
        elif intensity<self.intensity_threshold:
            explanation="Gamma and Speed align, but average |normalized| Zomma/Color intensity is below 0.65."
        else:
            explanation=f"Speed indicates {'upward' if aligned_up else 'downward'} curvature change while Gamma supplies the base and Zomma/Color confirm intensity."
        return GammaDynamics(
            decision=decision,qualified=qualified,source_symbol=source_symbol,intensity=intensity,
            pressure=pressure,history_points=len(samples),intensity_threshold=self.intensity_threshold,
            inputs=inputs,percentiles=percentiles,normalized=normalized,
            contributions=contributions,ideal_ranges=ideal_ranges,explanation=explanation,
        )
