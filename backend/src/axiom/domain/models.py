from __future__ import annotations

from dataclasses import dataclass
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
    # Contract-level Gamma Dynamics 2.0 measurements calculated before the
    # adapter reduces an option chain to a single aggregate Greeks snapshot.
    # Numeric chain measurements plus structured wall metadata.  The latter
    # includes the top-five strike list and the textual pin-state, so this
    # cannot be restricted to float values.
    gamma_metrics: dict[str, Any] = Field(default_factory=dict)
    # The aggregate bar remains the common engine input, but Gamma Dynamics
    # 2.0 also retains every contract in the observed chain for persistence.
    gamma_ticks: list[dict[str, Any]] = Field(default_factory=list)

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


@dataclass(frozen=True)
class GexWall:
    """Typed representation of one signed, strike-level Gamma exposure wall."""
    strike: float
    gex: float
    abs_gex: float
    side: int
    open_interest: int
    distance_pct: float


class GammaDynamicsMetrics(FrozenModel):
    """Typed Gamma 2.0 wall fields embedded in the flexible chain-metric payload."""
    call_wall_strike: float = 0.0
    call_wall_gex: float = 0.0
    call_wall_oi: int = 0
    put_wall_strike: float = 0.0
    put_wall_gex: float = 0.0
    put_wall_oi: int = 0
    gex_walls: list[GexWall] = Field(default_factory=list)
    pin_status: str = "OUTSIDE"


class GammaDynamics(FrozenModel):
    """Normalized six-Greek Gamma dynamics with volatility-curvature context."""
    decision: Direction = Direction.NEUTRAL
    qualified: bool = False
    source_symbol: str
    intensity: float = Field(ge=0, le=1)
    pressure: float = Field(ge=-1, le=1)
    history_points: int = Field(ge=0)
    intensity_threshold: float = Field(ge=0, le=1)
    inputs: dict[str, float]
    percentiles: dict[str, float]
    normalized: dict[str, float] = Field(default_factory=dict)
    contributions: dict[str, float] = Field(default_factory=dict)
    ideal_ranges: dict[str, str] = Field(default_factory=dict)
    # Version 2.0 keeps the six-Greek display contract above, while exposing
    # the chain-level model inputs and decisions used to produce the signal.
    # Most chain metrics are numeric; Gamma Dynamics 2.0 also records the
    # selected execution regime (WAIT / FADE / AMP) alongside them.
    chain_metrics: dict[str, Any] = Field(default_factory=dict)
    normalized_features: dict[str, float] = Field(default_factory=dict)
    squeeze_score: float = 0.0
    probability: float = Field(default=0.5, ge=0, le=0.95)
    target_price: float | None = Field(default=None, gt=0)
    alert_checks: dict[str, bool] = Field(default_factory=dict)
    explanation: str


class ZoneIntelligence(FrozenModel):
    """Rolling-normalized six-Greek intraday zone classification."""
    zone: str
    active_windows: list[str]
    qualified: bool = False
    direction: Direction = Direction.NEUTRAL
    source_symbol: str
    score: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    history_points: int = Field(ge=0)
    normalized: dict[str, float]
    bands: dict[str, str]
    rule_checks: dict[str, dict[str, bool]]
    zone_scores: dict[str, float]
    delta_change: float = 0.0
    gamma_change: float = 0.0
    delta_sign_flipped: bool = False
    explanation: str


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
    # Structured source-of-truth for every Greek. Optional only so historical
    # rows written by older deployments can still be read.
    greeks: Greeks | None = None
    gamma_dynamics: GammaDynamics | None = None
    gamma_dynamics_v2: GammaDynamics | None = None
    zone_intelligence: ZoneIntelligence | None = None
    session_analysis: dict[str, Any] = Field(default_factory=dict)
    # Indicators include numeric scores, integer counts, flags, and labels.
    # A homogeneous union produces serializer warnings for valid int values.
    supporting_indicators: dict[str, Any]
    signal_checks: dict[str, bool] = Field(default_factory=dict)
    active_thresholds: dict[str, float] = Field(default_factory=dict)
    options_bias: Direction = Direction.NEUTRAL
    options_bias_qualified: bool = False


class Alert(FrozenModel):
    id: UUID = Field(default_factory=uuid4)
    display_id: str | None = None
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
    supporting_indicators: dict[str, Any]
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
