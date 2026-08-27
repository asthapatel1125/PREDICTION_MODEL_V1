from __future__ import annotations
from datetime import datetime
from axiom.domain.metrics import MaxTrackerToday

class CvdProxyEngine:
    def __init__(self,tracker:MaxTrackerToday):self.tracker=tracker;self.cumulative={}
    def calculate(self,symbol:str,timestamp:datetime,dealer_flow:float)->dict[str,float]:
        previous=self.cumulative.get(symbol,0.0);current=previous+float(dealer_flow);self.cumulative[symbol]=current
        maximum=self.tracker.update("cvd_proxy",current,timestamp)
        return {"cvd_proxy_raw":current,"cvd_proxy_pct":current/maximum*100 if maximum else 0.0,"cvd_proxy_vector":1 if current>previous else -1 if current<previous else 0}
