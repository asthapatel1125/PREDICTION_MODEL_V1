from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .enums import AlertProfile, Direction, EngineMode, Regime, RiskLevel


GREEK_NAMES = (
    "delta", "theta", "vega", "rho",
    "gamma", "vanna", "charm", "vomma", "veta",
    "speed", "zomma", "color", "ultima",
)


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Greeks(FrozenModel):
    delta: float = 0.0
    theta: float = 0.0
    vega: float = 0.0
    rho: float = 0.0
    gamma: float = 0.0
    vanna: float = 0.0
    charm: float = 0.0
    vomma: float = 0.0
    veta: float = 0.0
    speed: float = 0.0
    zomma: float = 0.0
    color: float = 0.0
    ultima: float = 0.0


class MarketBar(FrozenModel):
    timestamp: datetime
    symbol: str = Field(min_length=1, max_length=16)
    timeframe_seconds: int = Field(gt=0)
    open: float = Field(gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)
    volume: float = Field(ge=0)
    bid_ask_spread: float = Field(ge=0)
    greeks: Greeks
    contract_count: int = Field(default=0, ge=0)
    open_interest: float = Field(default=0, ge=0)

    @field_validator("symbol")
    @classmethod
    def uppercase_symbol(cls, value: str) -> str:
        return value.upper()


class ScoreResult(FrozenModel):
    name: str
    value: float
    confidence: float = Field(ge=0, le=1)
    inputs: dict[str, float]
    configuration: dict[str, Any]
    explanation: str
    components: dict[str, float] = Field(default_factory=dict)


class MicroRange(FrozenModel):
    high: float
    low: float
    breakout: Direction = Direction.NEUTRAL
    confirmed: bool = False
    snapback: bool = False


class MarketState(FrozenModel):
    timestamp: datetime
    symbol: str
    regime: Regime
    profile: AlertProfile
    explosion: ScoreResult
    direction: ScoreResult
    pressure: ScoreResult
    dealer_hedging: ScoreResult
    momentum: ScoreResult
    confidence: ScoreResult
    risk: ScoreResult
    micro_range: MicroRange
    timeframe_alignment: dict[str, float]
    supporting_indicators: dict[str, float]
    signal_checks: dict[str, bool] = Field(default_factory=dict)
    active_thresholds: dict[str, float] = Field(default_factory=dict)
    options_bias: Direction = Direction.NEUTRAL
    options_bias_qualified: bool = False


class Alert(FrozenModel):
    id: UUID = Field(default_factory=uuid4)
    timestamp: datetime
    symbol: str
    engine_mode: EngineMode
    direction: Direction
    confidence: float = Field(ge=0, le=1)
    explosion_score: float = Field(ge=0, le=1)
    direction_score: int = Field(ge=-3, le=3)
    regime: Regime
    profile: AlertProfile
    micro_range: MicroRange
    reasoning: list[str]
    supporting_indicators: dict[str, float]
    recommended_action: str
    risk_level: RiskLevel
    price: float
    expected_move: float = Field(ge=0)
    entry_price: float | None = Field(default=None, gt=0)
    invalidation_price: float | None = Field(default=None, gt=0)
    target_price: float | None = Field(default=None, gt=0)
    config_version: str


class Outcome(FrozenModel):
    alert_id: UUID
    evaluated_at: datetime
    direction_accuracy: float = Field(ge=0, le=1)
    magnitude_accuracy: float = Field(ge=0, le=1)
    timing_accuracy: float = Field(ge=0, le=1)
    precision: float = Field(ge=0, le=1)
    actual_move: float
    lead_time_seconds: float = Field(ge=0)
    false_positive_reason: str | None = None
    false_negative_reason: str | None = None
    recommendation: str | None = None


class PipelineResult(FrozenModel):
    state: MarketState
    alert: Alert | None
    processing_latency_ms: float = Field(ge=0)
