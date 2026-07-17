from collections.abc import Sequence

import numpy as np

from axiom.config.schema import StrategyConfig
from axiom.domain.models import MarketBar, ScoreResult

from .base import clamp


class RiskScorer:
    def __init__(self, config: StrategyConfig): self.config=config

    def calculate(self,current:MarketBar,history:Sequence[MarketBar]) -> ScoreResult:
        spreads=[b.bid_ask_spread for b in history[-100:]]; volumes=[b.volume for b in history[-100:]]
        spread_ratio=current.bid_ask_spread/max(float(np.median(spreads)) if spreads else current.bid_ask_spread,1e-9)
        volume_ratio=current.volume/max(float(np.median(volumes)) if volumes else current.volume,1e-9)
        closes=[b.close for b in history[-30:]]+[current.close]; returns=np.diff(np.log(closes)) if len(closes)>2 else np.array([0.])
        vol_ratio=float(np.std(returns[-5:])/max(np.std(returns),1e-9))
        risk=clamp(.40*min(spread_ratio/3,1)+.35*min(vol_ratio/4,1)+.25*(1-min(volume_ratio,1)))
        return ScoreResult(name="risk",value=risk,confidence=clamp(len(history)/50),inputs={"spread_ratio":spread_ratio,"volume_ratio":volume_ratio,"vol_ratio":vol_ratio},
            configuration=self.config.risk_limits,explanation=f"Signal risk {risk:.1%}: spread {spread_ratio:.2f}x, volume {volume_ratio:.2f}x, vol {vol_ratio:.2f}x.")

