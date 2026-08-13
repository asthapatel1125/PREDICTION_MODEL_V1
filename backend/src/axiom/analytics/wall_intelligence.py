"""Standalone Wall Intelligence market-structure module.

Wall Intelligence observes point-in-time option-chain wall estimates.  It is
not a Gamma Dynamics 1.0, Gamma Dynamics 2.0, Delta Dynamics, or Primary
Options Bias model, and it must never change any of those systems' decisions.

Every wall is an estimate from delayed open interest multiplied by Greeks;
DealerFlow is a model proxy and is not tape-confirmed order flow.
"""
from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from math import sqrt
from typing import Any


WALL_INTELLIGENCE_DISCLAIMER = (
    "Estimated wall: delayed OI x Greek. DealerFlow is a proxy, not tape."
)


@dataclass(frozen=True)
class WallIntelligenceSnapshot:
    """Independent point-in-time market-structure observation contract."""

    timestamp: str
    symbol: str
    spot: float
    walls: dict[str, dict[str, Any]]
    dealer_flow: float = 0.0
    is_point_in_time: bool = True
    is_estimated_oi_delayed: bool = True
    disclaimer: str = WALL_INTELLIGENCE_DISCLAIMER


def wall_intelligence_snapshot(*, timestamp: Any, symbol: str, spot: float,
                               walls: dict[str, dict[str, Any]], dealer_flow: float = 0.0) -> WallIntelligenceSnapshot:
    """Create an isolated wall-market observation without model side effects."""
    value = timestamp.isoformat() if hasattr(timestamp, "isoformat") else str(timestamp)
    return WallIntelligenceSnapshot(value, symbol.upper(), float(spot), dict(walls), float(dealer_flow))


WALL_TYPES=("CALL_WALL","PUT_WALL","ZERO_GAMMA","SUPPORT","RESISTANCE")

def tier_for(z:float, percentile:float, dollar:float, tw_gex:float)->str:
    if (z>.6 or percentile>80) and dollar>100_000_000 and tw_gex>.7:return "STRONGEST"
    if z>.2 or percentile>60:return "STRONG"
    if z>-.2 or percentile>40:return "NORMAL"
    if z>-.6 or percentile>20:return "WEAK"
    return "WEAKEST"

def detect_break(previous_spot:float,current_spot:float,previous_strike:float)->str|None:
    if previous_spot<previous_strike<=current_spot:return "BREAK_UP"
    if previous_spot>previous_strike>=current_spot:return "BREAK_DOWN"
    return None

class WallIntelligenceService:
    """Independent market observer; it never changes any strategy decision."""
    def __init__(self,history_len:int=720,volume_sma:int=20):
        self.history=defaultdict(lambda:deque(maxlen=history_len));self.previous={};self.volumes=deque(maxlen=volume_sma);self.last_summary_epoch=0.0
    @staticmethod
    def _z(value:float,values:list[float])->float:
        if len(values)<2:return 0.0
        mean=sum(values)/len(values);std=sqrt(sum((item-mean)**2 for item in values)/len(values))
        return 0.0 if std<=max(abs(mean)*1e-15,1e-12) else max(-3.,min(3.,(value-mean)/std))/3
    @staticmethod
    def _pct(value:float,values:list[float])->float:
        return 50. if not values else 100*(sum(item<value for item in values)+.5*sum(item==value for item in values))/len(values)
    def observe(self,timestamp:Any,symbol:str,spot:float,metrics:dict[str,Any],regime:str,volume:float)->tuple[dict[str,Any],list[dict[str,Any]]]:
        gex={float(item.get("strike",0)):abs(float(item.get("gex",0))) for item in metrics.get("gex_walls",[]) if float(item.get("strike",0))>0};estimates=metrics.get("wall_estimates",{})
        levels={"CALL_WALL":float(metrics.get("call_wall_strike",0)),"PUT_WALL":float(metrics.get("put_wall_strike",0)),"ZERO_GAMMA":float(metrics.get("zero_gamma",0)),"SUPPORT":float(metrics.get("support_level",0)),"RESISTANCE":float(metrics.get("resistance_level",0))}
        tw=float(metrics.get("tw_gex",0));spoof=float(metrics.get("spoof_score",0));edge=float(metrics.get("edge",0));walls={};breaks=[];prior_vol=list(self.volumes);surge=float(volume)/max(sum(prior_vol)/len(prior_vol),1.) if prior_vol and float(volume)>0 else None
        for kind,strike in levels.items():
            raw=abs(float(estimates.get(kind,{}).get("gex",gex.get(strike,abs(float(metrics.get("call_wall_gex",0))) if kind=="CALL_WALL" else abs(float(metrics.get("put_wall_gex",0))) if kind=="PUT_WALL" else 0.))));hist=list(self.history[kind]);z=self._z(raw,hist);pct=self._pct(raw,hist);dollar=raw
            reading={"strike":strike,"raw":raw,"dollar":dollar,"z":z,"percentile":pct,"tier":tier_for(z,pct,dollar,tw),"tw_gex":tw,"spoof":spoof,"edge":edge,"is_estimated_oi_delayed":True};walls[kind]=reading;prior=self.previous.get((symbol,kind));direction=detect_break(prior[0],spot,prior[1]) if prior else None
            if direction:breaks.append({"timestamp":timestamp,"symbol":symbol,"wall_type":kind,"strike":strike,"direction":direction,"tier":reading["tier"],"spot":spot,"gex_dollar":dollar,"build_intensity":max(.01,(pct/100)*max(tw,.25)/(max(spoof,0)+.5)),"edge":edge,"liquidity":float(metrics.get("liquidity_score",0)),"vix":float(metrics.get("vix",0)),"volume":float(volume) if float(volume)>0 else None,"volume_surge":surge,"delta_change":0.,"spot_change":spot-prior[0],"qqq_return":(spot-prior[0])/prior[0] if prior[0] else 0.,"retest_count":0,"path_efficiency_5m":None,"outcome":"PENDING","regime":regime,"is_point_in_time":True,"is_estimated_oi_delayed":True})
            self.history[kind].append(raw)
            if strike>0:self.previous[(symbol,kind)]=(spot,strike)
        self.volumes.append(float(volume))
        point={"timestamp":timestamp,"symbol":symbol,"spot":spot,"walls":walls,"dex":float(metrics.get("dex",0)),"vol_hack":float(metrics.get("vol_hack",0)),"dealer_flow":float(metrics.get("dealer_flow",0)),"pos_inventory":float(metrics.get("pos_inventory",0)),"neg_inventory":float(metrics.get("neg_inventory",0)),"tw_gex":tw,"gex_density":float(metrics.get("gex_density",0)),"gex_dollar_density":float(metrics.get("gex_dollar_density",0)),"spoof_score":spoof,"edge":edge,"liquidity":float(metrics.get("liquidity_score",0)),"vix":float(metrics.get("vix",0)),"regime":regime,"is_point_in_time":True,"is_estimated_oi_delayed":True,"disclaimer":WALL_INTELLIGENCE_DISCLAIMER}
        return point,breaks

    def summary_due(self,timestamp:Any,interval_seconds:int=30)->bool:
        epoch=float(timestamp.timestamp()) if hasattr(timestamp,"timestamp") else 0.0
        if epoch-self.last_summary_epoch<interval_seconds:return False
        self.last_summary_epoch=epoch;return True

    @staticmethod
    def summarize(point:dict[str,Any],breaks:list[dict[str,Any]])->dict[str,Any]:
        walls=point.get("walls",{});spot=float(point.get("spot",0));call=walls.get("CALL_WALL",{});put=walls.get("PUT_WALL",{})
        strongest=max(walls.items(),key=lambda item:float(item[1].get("dollar",0)),default=("WAITING",{}))[0]
        pin=bool(float(put.get("strike",0))<spot<float(call.get("strike",0)))
        flow=float(point.get("dealer_flow",0));bias="BUYING" if flow>0 else "SELLING" if flow<0 else "NEUTRAL"
        return {"timestamp":point["timestamp"],"symbol":point["symbol"],"spot":spot,"strongest_wall":strongest,"pin_status":"BETWEEN_WALLS" if pin else "OUTSIDE_WALLS","bias":bias,"wall_summary":{"walls":walls,"last_break":breaks[-1] if breaks else None},"dealerflow_summary":{"dealer_flow":flow,"pos_inventory":point.get("pos_inventory",0),"neg_inventory":point.get("neg_inventory",0),"tw_gex":point.get("tw_gex",0),"spoof_score":point.get("spoof_score",0),"edge":point.get("edge",0)}}
