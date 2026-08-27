from __future__ import annotations
from datetime import datetime
from axiom.domain.metrics import MaxTrackerToday

class MarketPressureEngine:
    def __init__(self,tracker:MaxTrackerToday):self.tracker=tracker;self.previous={};self.ema={}
    def calculate(self,symbol:str,timestamp:datetime,spot:float,pressure:dict)->dict[str,float]:
        tpi=float(pressure.get("pressure_trend",50));flow=tpi*float(pressure.get("dealer_flow_pct",0))/100
        flow_pct=self.tracker.percent("pressure_flow",flow,timestamp);prior=self.previous.get(symbol)
        dt=max((timestamp-prior[0]).total_seconds(),1) if prior else 1;roc=(tpi-prior[1])/dt if prior else 0;self.previous[symbol]=(timestamp,tpi)
        roc_pct=self.tracker.percent("roc",roc,timestamp);qqq=self.tracker.qqq_percent(spot,timestamp);div=tpi-qqq;div_pct=self.tracker.percent("div",div,timestamp)
        mpi=.4*flow_pct+.3*roc_pct+.3*div_pct;alpha=2/(max(1.0,20/dt)+1);trend=alpha*mpi+(1-alpha)*self.ema.get(symbol,mpi);self.ema[symbol]=trend
        return {"pressure_flow":flow,"pressure_flow_pct":flow_pct,"pressure_roc":roc,"pressure_roc_pct":roc_pct,"roc_vector":1 if roc>0 else -1 if roc<0 else 0,"qqq_norm_pct":qqq,"pressure_div":div,"pressure_div_pct":div_pct,"div_vector":1 if div>0 else -1 if div<0 else 0,"mpi":mpi,"mpi_trend":trend}
