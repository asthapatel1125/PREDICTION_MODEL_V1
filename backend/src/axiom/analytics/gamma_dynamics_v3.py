"""Gamma Dynamics 3.0: per-strike early-move alert model.

The model deliberately treats 1.25 QQQ points as a *tracked target*, not as
an uncalibrated promise from options Greeks.  Its alerts identify a quiet
underlying, accelerating short-dated hedge pressure, and enough nearby GEX to
make a five-minute expansion plausible.  Calibration of the probability or
expected magnitude belongs to a separate historical study.
"""
from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, time
from math import isfinite, log, sqrt
from statistics import median
from typing import Any, Sequence
from zoneinfo import ZoneInfo

from axiom.domain.enums import Direction
from axiom.domain.models import GammaDynamics


GAMMA_DYNAMICS_V3_GREEKS = ("gamma", "speed", "vomma", "charm", "delta")


class GammaDynamicsEarlyMove:
    """A small, loop-based per-strike early-alert engine.

    The state is capped and contains only the recent observations required by
    the five-minute gates.  No NumPy/vectorized chain operation is used.
    """

    def __init__(self, cadence_seconds: int = 10, market_timezone: str = "America/New_York"):
        self.cadence_seconds=max(10,min(30,int(cadence_seconds)))
        self.market_tz=ZoneInfo(market_timezone)
        self._last_evaluated: dict[str,datetime]={}
        self._latest: dict[str,GammaDynamics]={}
        self._spots: dict[str,deque[tuple[datetime,float,float]]]=defaultdict(lambda:deque(maxlen=90))
        self._contracts: dict[tuple[str,str,str,float],deque[dict[str,float|datetime]]]=defaultdict(lambda:deque(maxlen=90))
        self._gamma_distribution: dict[str,deque[float]]=defaultdict(lambda:deque(maxlen=6000))
        self._speed_distribution: dict[str,deque[float]]=defaultdict(lambda:deque(maxlen=6000))
        self._vomma_distribution: dict[str,deque[float]]=defaultdict(lambda:deque(maxlen=6000))
        self._charm_distribution: dict[str,deque[float]]=defaultdict(lambda:deque(maxlen=6000))

    @staticmethod
    def _p90(values: Sequence[float]) -> float:
        ordered=sorted(abs(float(value)) for value in values if isfinite(float(value)))
        if not ordered:return 0.0
        return ordered[min(len(ordered)-1,max(0,int(.90*(len(ordered)-1))))]

    @staticmethod
    def _past(rows: Sequence[dict[str,float|datetime]], now: datetime, seconds: float) -> dict[str,float|datetime] | None:
        target=now.timestamp()-seconds
        candidates=[row for row in rows if isinstance(row.get("timestamp"),datetime) and row["timestamp"].timestamp()<=target]
        return candidates[-1] if candidates else None

    @staticmethod
    def _clip(value: float, limit: float=1.0) -> float:
        return max(-limit,min(limit,value)) if isfinite(value) else 0.0

    def _waiting(self,symbol:str,history_points:int,reason:str,metrics:dict[str,Any]|None=None) -> GammaDynamics:
        return GammaDynamics(
            decision=Direction.NEUTRAL,qualified=False,source_symbol=symbol,intensity=0.0,pressure=0.0,
            history_points=history_points,intensity_threshold=1.0,
            inputs={name:0.0 for name in GAMMA_DYNAMICS_V3_GREEKS},percentiles={name:0.0 for name in GAMMA_DYNAMICS_V3_GREEKS},
            normalized={name:0.0 for name in GAMMA_DYNAMICS_V3_GREEKS},
            contributions={name:0.0 for name in GAMMA_DYNAMICS_V3_GREEKS},
            ideal_ranges={
                "gamma":"Near-ATM short-dated curvature above its rolling 90th percentile",
                "speed":"Direction-setting gamma acceleration", "vomma":"Volatility-convexity expansion over five minutes",
                "charm":"Short-dated negative Charm that is becoming more negative", "delta":"Liquid near-ATM contract: |Delta| 0.30–0.70",
            },chain_metrics={"model_version":"GAMMA_3_EARLY_MOVE",**(metrics or {})},
            normalized_features={},squeeze_score=0.0,probability=0.0,target_price=None,
            alert_checks={"baseline":False},explanation=reason,
        )

    def calculate(self,contracts: Sequence[dict[str,Any]], spot: float, timestamp: datetime, source_symbol: str) -> GammaDynamics:
        symbol=source_symbol.upper()
        prior=self._last_evaluated.get(symbol)
        if prior and (timestamp-prior).total_seconds()<self.cadence_seconds:
            return self._latest.get(symbol) or self._waiting(symbol,0,"Waiting for the first 10-second Gamma 3.0 observation.")
        self._last_evaluated[symbol]=timestamp
        clean=[row for row in contracts if float(row.get("underlying_price") or spot or 0)>0]
        option_volume=sum(max(0.0,float(row.get("volume") or 0.0)) for row in clean)
        self._spots[symbol].append((timestamp,float(spot),option_volume))
        # Build signed Net GEX at every observed strike first; alert selection
        # is only then made among liquid near-ATM contracts.
        net_gex: dict[float,float]=defaultdict(float)
        for row in clean:
            strike=float(row.get("strike") or 0.0);gamma=float(row.get("gamma") or 0.0);oi=float(row.get("open_interest") or 0.0)
            right=str(row.get("right") or "").upper()
            if strike>0 and gamma and oi>=0:
                net_gex[strike]+=(1.0 if right.startswith("C") else -1.0)*oi*100.0*gamma*spot*spot*.01
        eligible=[]
        for row in clean:
            gamma=float(row.get("gamma") or 0.0);speed=float(row.get("speed") or 0.0);vomma=float(row.get("vomma") or 0.0);charm=float(row.get("charm") or 0.0);delta=float(row.get("delta") or 0.0)
            strike=float(row.get("strike") or 0.0);bid=float(row.get("bid") or 0.0);ask=float(row.get("ask") or 0.0);iv=float(row.get("implied_volatility") or 0.0);years=float(row.get("time_to_expiry_years") or 0.0)
            mid=(bid+ask)/2.0;spread=max(0.0,ask-bid)
            data_quality=years>0 and mid>0 and spread<.15*mid and iv>0
            short_dated=years<=2.0/365.25
            liquid_delta=.30<=abs(delta)<=.70
            if not (data_quality and short_dated and liquid_delta and strike>0):
                continue
            key=(symbol,str(row.get("expiration") or ""),str(row.get("right") or "").upper(),strike)
            observation={"timestamp":timestamp,"gamma":gamma,"speed":speed,"vomma":vomma,"charm":charm,"delta":delta,"iv":iv,"spot":spot,"volume":float(row.get("volume") or 0.0),"years":years}
            self._contracts[key].append(observation)
            self._gamma_distribution[symbol].append(abs(gamma));self._speed_distribution[symbol].append(abs(speed));self._vomma_distribution[symbol].append(abs(vomma));self._charm_distribution[symbol].append(abs(charm))
            eligible.append((row,key,observation))
        baseline_points=len(self._spots[symbol])
        if baseline_points<31 or len(self._gamma_distribution[symbol])<100:
            result=self._waiting(symbol,baseline_points,f"Building the five-minute Gamma 3.0 coil baseline: {baseline_points}/31 observations.",{"chain_available":float(bool(clean)),"eligible_contracts":len(eligible),"evaluation_cadence_seconds":self.cadence_seconds})
            self._latest[symbol]=result;return result
        gamma_p90=max(self._p90(self._gamma_distribution[symbol]),1e-12);speed_p90=max(self._p90(self._speed_distribution[symbol]),1e-12);vomma_p90=max(self._p90(self._vomma_distribution[symbol]),1e-12);charm_p90=max(self._p90(self._charm_distribution[symbol]),1e-12)
        spot_rows=list(self._spots[symbol]);spot_5m=self._past([{"timestamp":at,"spot":price,"volume":volume} for at,price,volume in spot_rows],timestamp,300.0);spot_1m=self._past([{"timestamp":at,"spot":price,"volume":volume} for at,price,volume in spot_rows],timestamp,60.0)
        range_5m=max(row[1] for row in spot_rows)-min(row[1] for row in spot_rows)
        returns=[log(spot_rows[index][1]/spot_rows[index-1][1]) for index in range(1,len(spot_rows)) if spot_rows[index][1]>0 and spot_rows[index-1][1]>0]
        mean=sum(returns)/max(len(returns),1);variance=sum((value-mean)**2 for value in returns)/max(len(returns),1)
        realized_vol_5m=sqrt(variance)*sqrt(252*78) if len(returns)>=2 else 0.0
        # The feed supplies option-contract volume, not consolidated QQQ
        # share volume.  Use a cross-sectional option-volume participation
        # ratio rather than dividing a dollar exposure by incompatible units.
        # That keeps the fuel score dimensionless and inspectable.
        median_contract_volume=max(median([float(observation["volume"]) for _,_,observation in eligible]),1.0)
        candidates=[]
        for row,key,current in eligible:
            prior_5m=self._past(list(self._contracts[key]),timestamp,300.0);prior_1m=self._past(list(self._contracts[key]),timestamp,60.0)
            if not prior_5m or not prior_1m or not spot_5m or not spot_1m:
                continue
            gamma=float(current["gamma"]);speed=float(current["speed"]);vomma=float(current["vomma"]);charm=float(current["charm"]);delta=float(current["delta"]);years=float(current["years"]);iv=float(current["iv"]);strike=float(row.get("strike") or 0.0)
            direction=Direction.UP if speed>0 else Direction.DOWN if speed<0 else Direction.NEUTRAL
            direction_sign=1.0 if direction==Direction.UP else -1.0
            # Each term is dimensionless and capped.  This prevents a single
            # malformed third-order Greek from creating an e+30 alert score.
            gamma_term=min(abs(gamma)/gamma_p90,3.0);speed_term=min(abs(speed)/speed_p90,3.0);vomma_term=min(abs(vomma)/vomma_p90,3.0);charm_term=min(abs(charm)/charm_p90,3.0);delta_term=abs(delta)/.70
            score=gamma_term*(1.0+.45*speed_term)*(1.0+.25*vomma_term)*(1.0+.20*charm_term)*(0.70+.30*delta_term)
            prior_score=float(prior_5m.get("score") or 0.0)
            current["score"]=score
            dscore=score-prior_score
            directional_speed_accel=direction_sign*(speed-float(prior_5m["speed"]))
            # Vomma measures volatility convexity, not spot direction.  Speed
            # determines direction; this gate requires convexity to be both
            # material and expanding so a static IV sensitivity cannot qualify.
            vomma_acceleration=abs(vomma)-abs(float(prior_5m["vomma"]))
            charm_acceleration=charm-float(prior_1m["charm"])
            strike_gex=net_gex.get(strike,0.0)
            option_volume_participation=min(2.0,max(0.0,float(current["volume"])/median_contract_volume))
            hedge_impulse=(abs(strike_gex)/600_000_000.0)*(abs(speed)/speed_p90)*(.5+.5*option_volume_participation)
            checks={
                "data_quality":True,
                "coil_range":range_5m<=.40,
                "coil_volatility":realized_vol_5m<=.30*iv,
                "pressure_score":dscore>=.80,
                "speed_acceleration":direction!=Direction.NEUTRAL and directional_speed_accel>=.15*max(abs(speed),speed_p90*.10),
                "vomma_expansion":abs(vomma)>=.35*vomma_p90 and vomma_acceleration>=.10*vomma_p90,
                "charm_level":charm<=-.03,
                "charm_acceleration":charm_acceleration<=-.01,
                "short_dated":years<=2.0/365.25,
                "timing":time(11,0)<=timestamp.astimezone(self.market_tz).time()<=time(15,0),
                "net_gex":abs(strike_gex)>=600_000_000.0,
                "hedge_fuel":hedge_impulse>=1.0,
                "early":abs(spot-float(spot_1m["spot"]))<=.20,
            }
            candidates.append((all(checks.values()),score,abs(strike_gex),direction,row,current,checks,{"dscore":dscore,"directional_speed_accel":directional_speed_accel,"vomma_acceleration":vomma_acceleration,"charm_acceleration":charm_acceleration,"hedge_impulse":hedge_impulse,"strike_gex":strike_gex,"option_volume_participation":option_volume_participation,"gamma_term":gamma_term,"speed_term":speed_term,"vomma_term":vomma_term,"charm_term":charm_term,"delta_term":delta_term,"prior_score":prior_score}))
        if not candidates:
            result=self._waiting(symbol,baseline_points,"Waiting for five-minute per-contract comparisons for eligible near-ATM contracts.",{"chain_available":float(bool(clean)),"eligible_contracts":len(eligible),"evaluation_cadence_seconds":self.cadence_seconds})
            self._latest[symbol]=result;return result
        passed,score,_,direction,row,current,checks,detail=max(candidates,key=lambda item:(item[0],item[1],item[2]))
        inputs={name:float(current[name]) for name in GAMMA_DYNAMICS_V3_GREEKS}
        normalized={"gamma":self._clip(inputs["gamma"]/gamma_p90),"speed":self._clip(inputs["speed"]/speed_p90),"vomma":self._clip(inputs["vomma"]/vomma_p90),"charm":self._clip(inputs["charm"]/charm_p90),"delta":self._clip(inputs["delta"]/.70)}
        metrics={"model_version":"GAMMA_3_EARLY_MOVE","chain_available":float(bool(clean)),"eligible_contracts":len(eligible),"selected_strike":float(row.get("strike") or 0.0),"spot":spot,"net_gex_strike":detail["strike_gex"],"gamma_p90_rolling":gamma_p90,"speed_p90_rolling":speed_p90,"vomma_p90_rolling":vomma_p90,"charm_p90_rolling":charm_p90,"score":score,"score_5m_ago":detail["prior_score"],"dscore":detail["dscore"],"directional_speed_acceleration":detail["directional_speed_accel"],"vomma_acceleration_5m":detail["vomma_acceleration"],"charm_acceleration_1m":detail["charm_acceleration"],"realized_range_5m":range_5m,"realized_vol_5m":realized_vol_5m,"implied_volatility":float(current["iv"]),"median_contract_volume":median_contract_volume,"option_volume_participation":detail["option_volume_participation"],"hedge_impulse":detail["hedge_impulse"],"spot_momentum_1m":spot-float(spot_1m["spot"]),"target_points":1.25,"target_horizon_minutes":5.0,"evaluation_cadence_seconds":self.cadence_seconds,"expected_move_label":"1.25-POINT TARGET · CALIBRATION REQUIRED"}
        checks={"baseline":True,**checks}
        qualified=bool(passed)
        if qualified:
            explanation=(f"Quiet 5-minute coil with {direction.value.lower()} Speed acceleration, expanding Vomma, accelerating negative Charm, and ${abs(detail['strike_gex'])/1e9:.2f}B signed strike GEX. Gamma 3.0 is tracking a 1.25-point QQQ target over five minutes.")
        else:
            failed=", ".join(name.replace("_"," ") for name,value in checks.items() if not value)
            explanation=f"Early-move setup is not actionable: {failed} gate{'s' if ',' in failed else ''} not satisfied."
        result=GammaDynamics(decision=direction if qualified else Direction.NEUTRAL,qualified=qualified,source_symbol=symbol,intensity=min(1.0,score/8.0),pressure=(1 if direction==Direction.UP else -1 if direction==Direction.DOWN else 0)*min(1.0,detail["hedge_impulse"]/2.0),history_points=baseline_points,intensity_threshold=1.0,inputs=inputs,percentiles={"gamma":min(1.0,abs(inputs["gamma"])/gamma_p90),"speed":min(1.0,abs(inputs["speed"])/speed_p90),"vomma":min(1.0,abs(inputs["vomma"])/vomma_p90),"charm":min(1.0,abs(inputs["charm"])/charm_p90),"delta":min(1.0,abs(inputs["delta"])/.70)},normalized=normalized,contributions={"gamma":detail["gamma_term"],"speed":detail["speed_term"],"vomma":detail["vomma_term"],"charm":detail["charm_term"],"delta":detail["delta_term"]},ideal_ranges={"gamma":"Rolling p90 curvature participation","speed":"Directional five-minute acceleration","vomma":"Absolute Vomma ≥ 35% of rolling p90 and rising ≥ 10% over five minutes","charm":"≤ -0.03 and falling by at least 0.01 in one minute","delta":"Liquid near-ATM |Delta| 0.30–0.70"},chain_metrics=metrics,normalized_features=normalized,squeeze_score=detail["hedge_impulse"],probability=min(.95,max(0.0,.50+.10*min(score,3)+.08*min(detail["hedge_impulse"],2))),target_price=spot+(1.25 if direction==Direction.UP else -1.25) if qualified else None,alert_checks=checks,explanation=explanation)
        self._latest[symbol]=result
        return result
