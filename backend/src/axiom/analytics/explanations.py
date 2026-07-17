from axiom.domain.enums import Direction, Regime, RiskLevel
from axiom.domain.models import MarketState


class AlertExplanationEngine:
    def explain(self,state:MarketState,direction:Direction) -> tuple[list[str],str,RiskLevel]:
        reasons=[state.explosion.explanation,state.direction.explanation,state.pressure.explanation,state.dealer_hedging.explanation]
        if state.regime in {Regime.LOW_LIQUIDITY,Regime.HIGH_VOLATILITY_EVENT} or state.risk.value>=.72: level=RiskLevel.EXTREME
        elif state.risk.value>=.55: level=RiskLevel.HIGH
        elif state.risk.value>=.30: level=RiskLevel.MODERATE
        else: level=RiskLevel.LOW
        side="LONG" if direction==Direction.UP else "SHORT"
        action="WAIT; options pressure risk is extreme" if level==RiskLevel.EXTREME else f"Options-pressure {side} bias; confirm entry, stop, and target manually from a live price feed"
        return reasons,action,level
