from axiom.config.schema import ProfileThresholds
from axiom.domain.enums import Direction
from axiom.domain.models import MarketState


class TradeSignalGenerator:
    """Generate an options-pressure bias without claiming price confirmation."""

    pressure_min = 0.15

    @staticmethod
    def options_confidence(state:MarketState)->float:
        """Renormalize the configured confidence weights over options-only scores."""
        configured=state.confidence.configuration.get("weights",{})
        components={"explosion":state.explosion.value,"direction":abs(state.direction.value)/3,
            "pressure":abs(state.pressure.value)}
        total=sum(float(configured.get(name,0)) for name in components)
        if total<=0:return 0.0
        return sum(float(configured.get(name,0))*value for name,value in components.items())/total

    def should_alert(self,state:MarketState,thresholds:ProfileThresholds) -> tuple[bool,Direction,list[str]]:
        direction=Direction.UP if state.direction.value>0 else Direction.DOWN if state.direction.value<0 else Direction.NEUTRAL
        pressure_aligned=(direction==Direction.UP and state.pressure.value>=self.pressure_min) or (
            direction==Direction.DOWN and state.pressure.value<=-self.pressure_min
        )
        checks={
            "explosion":state.explosion.value>=thresholds.explosion_min,
            "direction":abs(state.direction.value)>=thresholds.direction_min,
            "pressure_alignment":pressure_aligned,
            "confidence":self.options_confidence(state)>=thresholds.confidence_min,
            "risk":state.risk.value<.88,
        }
        return all(checks.values()) and direction!=Direction.NEUTRAL,direction,[name for name,passed in checks.items() if not passed]
