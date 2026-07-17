from enum import StrEnum


class Direction(StrEnum):
    UP = "UP"
    DOWN = "DOWN"
    NEUTRAL = "NEUTRAL"


class Regime(StrEnum):
    CALM = "CALM"
    EXPANSION = "EXPANSION"
    GAMMA_UNSTABLE = "GAMMA_UNSTABLE"
    HEDGING_ACTIVE = "HEDGING_ACTIVE"
    HIGH_VOLATILITY_EVENT = "HIGH_VOLATILITY_EVENT"
    LOW_LIQUIDITY = "LOW_LIQUIDITY"
    TRENDING = "TRENDING"
    CHOPPY = "CHOPPY"


class AlertProfile(StrEnum):
    NEWS = "NEWS"
    MARKET_OPEN = "MARKET_OPEN"
    NORMAL_SESSION = "NORMAL_SESSION"
    POWER_HOUR = "POWER_HOUR"
    OVERNIGHT = "OVERNIGHT"


class RiskLevel(StrEnum):
    LOW = "LOW"
    MODERATE = "MODERATE"
    HIGH = "HIGH"
    EXTREME = "EXTREME"


class EngineMode(StrEnum):
    TRAINING = "TRAINING"
    LIVE = "LIVE"

