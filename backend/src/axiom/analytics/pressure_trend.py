from __future__ import annotations
from datetime import datetime
from axiom.domain.metrics import MaxTrackerToday

class PressureTrendEngine:
    def __init__(self,tracker:MaxTrackerToday):self.tracker=tracker;self.previous={};self.ema={}
    def calculate(self,symbol:str,timestamp:datetime,spot:float,metrics:dict,zomma:float=0.0)->dict[str,float]:
        dealer_delta=float(metrics.get("net_dealer_delta",0));prior=self.previous.get(symbol)
        dt=max((timestamp-prior[0]).total_seconds(),1.0) if prior else 1.0
        velocity=(dealer_delta-prior[1])/dt if prior else 0.0;self.previous[symbol]=(timestamp,dealer_delta)
        values={
            "speed_pct":self.tracker.percent("speed",velocity,timestamp),
            "zomma_pct":self.tracker.percent("zomma",zomma,timestamp) if zomma else 0.0,
            "dex_pct":self.tracker.percent("dex",float(metrics.get("dex",0)),timestamp),
            "gex_pct":self.tracker.percent("gex",float(metrics.get("gex_raw",0)),timestamp),
            "dealer_flow_pct":self.tracker.percent("dealer_flow",velocity,timestamp),
            "zero_gamma_pct":self.tracker.percent("zero_gamma",abs(spot-float(metrics.get("zero_gamma",spot))),timestamp),
        }
        raw=.22*values["speed_pct"]+.18*(100-values["zomma_pct"])+.20*values["dex_pct"]+.18*(100-values["gex_pct"])+.12*values["dealer_flow_pct"]+.10*values["zero_gamma_pct"]
        alpha=2/(max(1.0,20/dt)+1);ema=alpha*raw+(1-alpha)*self.ema.get(symbol,raw);self.ema[symbol]=ema
        return {**values,"pressure_trend":max(0,min(100,ema)),"pressure_composite_raw":raw,"effective_gex_pct":100-values["gex_pct"],"dealer_delta_velocity":velocity}
