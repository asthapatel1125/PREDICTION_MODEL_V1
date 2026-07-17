from __future__ import annotations

from collections import defaultdict
from datetime import datetime,timezone
from pathlib import Path
from statistics import mean

from axiom.config.schema import StrategyConfig
from axiom.domain.models import Alert,Outcome


class OutcomeEvaluator:
    def evaluate(self,alert:Alert,prices:list[tuple[datetime,float]],max_lead_seconds:int)->Outcome:
        if not prices:raise ValueError("Outcome evaluation requires future prices")
        signed=[(p-alert.price) if alert.direction.value=="UP" else (alert.price-p) for _,p in prices]
        best_index=max(range(len(signed)),key=signed.__getitem__);actual=max(0.0,signed[best_index])
        direction=float(actual>0);magnitude=min(1.0,actual/max(alert.expected_move,1e-9));lead=max(0,(prices[best_index][0]-alert.timestamp).total_seconds())
        timing=max(0,1-lead/max(max_lead_seconds,1));precision=.4*direction+.4*magnitude+.2*timing
        reason=None if precision>=.6 else ("direction_conflict" if not direction else "insufficient_follow_through")
        return Outcome(alert_id=alert.id,evaluated_at=datetime.now(timezone.utc),direction_accuracy=direction,magnitude_accuracy=magnitude,
            timing_accuracy=timing,precision=precision,actual_move=actual,lead_time_seconds=lead,false_positive_reason=reason,
            recommendation=None if precision>=.6 else "Increase profile threshold or require sustained pressure confirmation")


class MetaEngine:
    def analyze(self,alerts:list[Alert],outcomes:list[Outcome])->dict[str,object]:
        by_id={o.alert_id:o for o in outcomes};paired=[(a,by_id[a.id]) for a in alerts if a.id in by_id]
        groups:dict[str,list[float]]=defaultdict(list)
        for alert,outcome in paired:
            groups[f"regime:{alert.regime.value}"].append(outcome.precision);groups[f"profile:{alert.profile.value}"].append(outcome.precision)
        calibration=mean([abs(a.confidence-o.precision) for a,o in paired]) if paired else 0
        return {"evaluated":len(paired),"precision":mean([o.precision for _,o in paired]) if paired else 0,
            "success_rate":mean([o.precision>=.6 for _,o in paired]) if paired else 0,"calibration_error":calibration,
            "segments":{k:{"count":len(v),"precision":mean(v)} for k,v in groups.items()},
            "failure_modes":dict(__import__("collections").Counter(o.false_positive_reason for _,o in paired if o.false_positive_reason))}

    def tune(self,config:StrategyConfig,analysis:dict[str,object])->StrategyConfig:
        updates={};segments=analysis.get("segments",{})
        for name,base in config.profiles.items():
            performance=segments.get(f"profile:{name}",{}).get("precision",.65) if isinstance(segments,dict) else .65
            updates[name]=base.model_copy(update={"explosion_min":max(.35,min(.92,base.explosion_min+(.03 if performance<.55 else -.01 if performance>.75 else 0)))})
        stamp=datetime.now(timezone.utc).strftime("%Y%m%d.%H%M%S")
        return config.model_copy(update={"version":f"{config.version}+tuned.{stamp}","profiles":updates})

