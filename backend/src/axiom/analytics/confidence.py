from axiom.domain.models import ScoreResult

from .base import clamp


class AlertConfidenceScorer:
    def __init__(self, weights: dict[str,float]):
        if abs(sum(weights.values())-1)>1e-6: raise ValueError("Confidence weights must total 1")
        self.weights=weights

    def calculate(self, explosion: ScoreResult, direction: ScoreResult, pressure: ScoreResult,
                  momentum: ScoreResult, timeframe_alignment: dict[str,float]) -> ScoreResult:
        aligned = abs(sum(timeframe_alignment.values()))/max(len(timeframe_alignment),1)
        components={"explosion":explosion.value,"direction":abs(direction.value)/3,"pressure":abs(pressure.value),"momentum":abs(momentum.value),"timeframe":aligned}
        value=clamp(sum(self.weights[k]*components[k] for k in self.weights))
        confidence=clamp(sum([explosion.confidence,direction.confidence,pressure.confidence,momentum.confidence])/4)
        return ScoreResult(name="confidence",value=value,confidence=confidence,inputs=components,configuration={"weights":self.weights},
            explanation=f"Composite alert confidence {value:.1%}; cross-timeframe alignment {aligned:.1%}.",components=components)

