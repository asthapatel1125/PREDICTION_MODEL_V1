from axiom.config.schema import ProfileThresholds
from axiom.domain.enums import Direction
from axiom.domain.models import MarketState


class TradeSignalGenerator:
    def should_alert(self,state:MarketState,thresholds:ProfileThresholds) -> tuple[bool,Direction,list[str]]:
        direction=Direction.UP if state.direction.value>0 else Direction.DOWN if state.direction.value<0 else Direction.NEUTRAL
        checks={
            "explosion":state.explosion.value>=thresholds.explosion_min,
            "direction":abs(state.direction.value)>=thresholds.direction_min,
            "confidence":state.confidence.value>=thresholds.confidence_min,
            "breakout":not thresholds.require_breakout or (state.micro_range.breakout==direction and state.micro_range.confirmed),
            "snapback":not state.micro_range.snapback,
            "risk":state.risk.value<.88,
        }
        return all(checks.values()) and direction!=Direction.NEUTRAL,direction,[name for name,passed in checks.items() if not passed]
