from axiom.domain.enums import Direction, Regime, RiskLevel
from axiom.domain.models import MarketState


class AlertExplanationEngine:
    def explain(self,state:MarketState,direction:Direction) -> tuple[list[str],str,RiskLevel]:
        reasons=[state.explosion.explanation,state.direction.explanation,state.dealer_hedging.explanation]
        if state.micro_range.confirmed: reasons.append(f"Price confirmed {direction} above/below the {state.micro_range.low:.2f}–{state.micro_range.high:.2f} micro-range.")
        if state.regime in {Regime.LOW_LIQUIDITY,Regime.HIGH_VOLATILITY_EVENT} or state.risk.value>=.72: level=RiskLevel.EXTREME
        elif state.risk.value>=.55: level=RiskLevel.HIGH
        elif state.risk.value>=.30: level=RiskLevel.MODERATE
        else: level=RiskLevel.LOW
        action="Observe only" if level==RiskLevel.EXTREME else f"Monitor {direction} continuation; invalidate on micro-range re-entry"
        return reasons,action,level

