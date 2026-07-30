from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime
from math import copysign, sqrt
from zoneinfo import ZoneInfo

from axiom.domain.enums import Direction
from axiom.domain.models import Greeks, ZoneIntelligence

NAMES = ("ultima", "zomma", "gamma", "speed", "color", "delta")


class ZoneIntelligenceEngine:
    """Classify intraday zones from rolling z-scaled six-Greek relationships."""

    def __init__(self, minimum_history: int = 20, delta_stability_samples: int = 5,
                 market_timezone: str = "America/New_York"):
        self.minimum_history = minimum_history
        self.delta_stability_samples = delta_stability_samples
        self.timezone = ZoneInfo(market_timezone)

    @staticmethod
    def _scaled(current: float, values: Sequence[float]) -> float:
        samples = [float(value) for value in values]
        if len(samples) < 2:
            return 0.0
        mean = sum(samples) / len(samples)
        std = sqrt(sum((value - mean) ** 2 for value in samples) / len(samples))
        if std <= 1e-12:
            return 0.0
        return max(-3.0, min(3.0, (float(current) - mean) / std)) / 3.0

    @staticmethod
    def _band(value: float) -> str:
        if value >= .6: return "STRONG_POSITIVE"
        if value >= .3: return "MODERATE_POSITIVE"
        if value <= -.6: return "STRONG_NEGATIVE"
        if value <= -.3: return "MODERATE_NEGATIVE"
        return "NEUTRAL"

    def _windows(self, timestamp: datetime) -> list[str]:
        local = timestamp.astimezone(self.timezone)
        if local.weekday() >= 5:
            return ["CLOSED"]
        minute = local.hour * 60 + local.minute
        second = local.second
        active = []
        if 240 <= minute < 570: active.append("PRE_MARKET")
        if minute == 570: active.append("OPENING_AUCTION")
        if 571 <= minute < 600: active.append("OPENING_RANGE")
        if 571 <= minute < 630: active.append("OPENING_DRIVE")
        if 630 <= minute < 720: active.append("LATE_MORNING")
        if 720 <= minute < 840: active.append("MIDDAY")
        if 840 <= minute < 900: active.append("AFTERNOON")
        if 900 <= minute < 960: active.append("POWER_HOUR")
        if 950 <= minute < 960: active.append("CLOSING_IMBALANCE")
        if minute == 960 and second < 60: active.append("CLOSING_AUCTION")
        return active or ["CLOSED"]

    @staticmethod
    def _rules(v: dict[str, float], delta_change: float, gamma_change: float,
               delta_flipped: bool) -> dict[str, list[tuple[str, bool]]]:
        U, Z, G, S, C, D = (v[name] for name in NAMES)
        return {
            "PRE_MARKET":[("|U| >= 0.5",abs(U)>=.5),("|Z| >= 0.5",abs(Z)>=.5),("|G| <= 0.2",abs(G)<=.2),("|S| <= 0.2",abs(S)<=.2),("C >= 0.3",C>=.3),("|D| <= 0.3",abs(D)<=.3)],
            "OPENING_AUCTION":[("G <= -0.4",G<=-.4),("S >= 0.7",S>=.7),("C <= -0.5",C<=-.5),("Z <= -0.4",Z<=-.4),("U >= 0.7",U>=.7),("|D| <= 0.4",abs(D)<=.4)],
            "OPENING_RANGE":[("G <= -0.3",G<=-.3),("S >= 0.5",S>=.5),("C <= -0.3",C<=-.3),("Z <= -0.3",Z<=-.3),("U >= 0.5",U>=.5),("|D| >= 0.3",abs(D)>=.3)],
            "OPENING_DRIVE":[("|D| >= 0.7",abs(D)>=.7),("S >= 0.6",S>=.6),("C >= 0.3",C>=.3),("|G| <= 0.3",abs(G)<=.3),("|Z| <= 0.3",abs(Z)<=.3),("|U| <= 0.4",abs(U)<=.4)],
            "LATE_MORNING":[("|D| >= 0.4",abs(D)>=.4),("|ΔD| <= 0.2",abs(delta_change)<=.2),("G >= 0.3",G>=.3),("S <= 0.3",S<=.3),("C >= 0.3",C>=.3),("Z >= 0.3",Z>=.3),("U <= 0.3",U<=.3)],
            "MIDDAY":[("|D| <= 0.2",abs(D)<=.2),("G >= 0.6",G>=.6),("|S| <= 0.2",abs(S)<=.2),("C >= 0.6",C>=.6),("Z >= 0.6",Z>=.6),("U <= 0.2",U<=.2)],
            "AFTERNOON":[("G <= -0.3",G<=-.3),("S >= 0.4",S>=.4),("C <= -0.3",C<=-.3),("Z <= -0.3",Z<=-.3),("U >= 0.4",U>=.4),("|D| >= 0.3",abs(D)>=.3)],
            "POWER_HOUR":[("|D| >= 0.7",abs(D)>=.7),("S >= 0.7",S>=.7),("C >= 0.3",C>=.3),("|G| <= 0.3",abs(G)<=.3),("|Z| <= 0.3",abs(Z)<=.3),("U >= 0.4",U>=.4)],
            "CLOSING_IMBALANCE":[("|ΔG| >= 0.5",abs(gamma_change)>=.5),("S >= 0.5",S>=.5),("C <= -0.3",C<=-.3),("Z >= 0.4",Z>=.4),("U >= 0.7",U>=.7),("|D| <= 0.4 or sign flip",abs(D)<=.4 or delta_flipped)],
            "CLOSING_AUCTION":[("G >= 0.6",G>=.6),("S <= 0.2",S<=.2),("C >= 0.6",C>=.6),("Z >= 0.4",Z>=.4),("U <= 0.2",U<=.2),("|D| <= 0.2",abs(D)<=.2)],
        }

    def calculate(self, greeks: Greeks, history: Sequence[Greeks], timestamp: datetime,
                  source_symbol: str) -> ZoneIntelligence:
        samples = list(history)[-120:]
        scaled = {name:self._scaled(getattr(greeks,name),[getattr(item,name) for item in samples]) for name in NAMES}
        scaled_history = [
            {name:self._scaled(getattr(item,name),[getattr(prior,name) for prior in samples[:index+1]])
             for name in NAMES} for index,item in enumerate(samples)
        ]
        previous = scaled_history[-2] if len(scaled_history)>=2 else scaled
        recent_delta = [row["delta"] for row in scaled_history[-self.delta_stability_samples:]] + [scaled["delta"]]
        delta_change = max(recent_delta)-min(recent_delta) if recent_delta else 0.0
        gamma_change = scaled["gamma"]-previous["gamma"]
        delta_flipped = any(a*b<0 for a,b in zip(recent_delta,recent_delta[1:]))
        rules = self._rules(scaled,delta_change,gamma_change,delta_flipped)
        windows = self._windows(timestamp)
        checks = {zone:{label:passed for label,passed in rules.get(zone,[])} for zone in windows}
        scores = {zone:(sum(result.values())/len(result) if result else 0.0) for zone,result in checks.items()}
        priority=("CLOSING_AUCTION","CLOSING_IMBALANCE","OPENING_AUCTION","OPENING_RANGE","OPENING_DRIVE",
                  "POWER_HOUR","AFTERNOON","MIDDAY","LATE_MORNING","PRE_MARKET","CLOSED")
        zone = max(windows,key=lambda item:(scores.get(item,0),-priority.index(item)))
        score = scores.get(zone,0.0)
        warmed = len(samples)>=self.minimum_history
        qualified = warmed and zone!="CLOSED" and score>=.80
        direction = Direction.NEUTRAL
        if qualified and abs(scaled["delta"])>=.3:
            direction = Direction.UP if scaled["delta"]>0 else Direction.DOWN
        elif qualified and zone in {"OPENING_AUCTION","OPENING_RANGE","AFTERNOON","CLOSING_IMBALANCE"}:
            direction = Direction.UP if scaled["speed"]>=0 else Direction.DOWN
        passed = sum(checks.get(zone,{}).values())
        total = len(checks.get(zone,{}))
        explanation = (f"Building rolling normalization: {len(samples)}/{self.minimum_history} observations."
            if not warmed else f"{zone.replace('_',' ').title()} matched {passed}/{total} rules; "
            f"{'qualified' if qualified else '80% required'} with {self._band(scaled['delta']).replace('_',' ').lower()} Delta.")
        return ZoneIntelligence(zone=zone,active_windows=windows,qualified=qualified,direction=direction,
            source_symbol=source_symbol,score=score,confidence=score if warmed else 0.0,
            history_points=len(samples),normalized=scaled,bands={name:self._band(value) for name,value in scaled.items()},
            rule_checks=checks,zone_scores=scores,delta_change=delta_change,gamma_change=gamma_change,
            delta_sign_flipped=delta_flipped,explanation=explanation)
