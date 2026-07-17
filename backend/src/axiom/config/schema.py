from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import AliasChoices, BaseModel, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProfileThresholds(BaseModel):
    explosion_min: float = Field(ge=0, le=1)
    direction_min: int = Field(ge=1, le=3)
    confidence_min: float = Field(ge=0, le=1)
    micro_range_minutes: int = Field(gt=0)
    require_breakout: bool = True
    expected_move_vol_multiple: float = Field(gt=0)


class StrategyConfig(BaseModel):
    version: str = "1.0.0"
    timeframes_seconds: list[int] = [5, 10, 30, 60, 180, 300, 900]
    primary_timeframe_seconds: int = 60
    regime_timeframe_seconds: int = 300
    score_history: int = 250
    evaluation_horizon_bars: int = 12
    max_lead_seconds: int = 600
    profiles: dict[str, ProfileThresholds]
    regime_thresholds: dict[str, dict[str, float]]
    score_weights: dict[str, dict[str, float]]
    risk_limits: dict[str, float]

    @classmethod
    def from_yaml(cls, path: str | Path) -> "StrategyConfig":
        return cls.model_validate(yaml.safe_load(Path(path).read_text(encoding="utf-8")))

    def to_yaml(self, path: str | Path) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(yaml.safe_dump(self.model_dump(mode="json"), sort_keys=False), encoding="utf-8")


class PlatformSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AXIOM_", env_file=".env", extra="ignore")
    environment: str = "development"
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    database_url: str = Field(
        validation_alias="SUPABASE_DATABASE_URL",
    )
    strategy_config_path: str = "config/strategy.yaml"
    thetadata_base_url: str = "http://127.0.0.1:25503/v3"
    thetadata_timeout_seconds: float = 60
    thetadata_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("THETADATA_API_KEY", "AXIOM_THETADATA_API_KEY"),
    )
    market_timezone: str = "America/New_York"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:5173"]
    websocket_queue_size: int = 4096

    @field_validator("database_url")
    @classmethod
    def normalize_postgres_driver(cls, value: str) -> str:
        """Accept the URI copied from Supabase and select SQLAlchemy's async driver."""
        value = value.replace("sslmode=require", "ssl=require")
        if value.startswith("postgres://"):
            value = value.replace("postgres://", "postgresql+asyncpg://", 1)
        if value.startswith("postgresql://"):
            value = value.replace("postgresql://", "postgresql+asyncpg://", 1)
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError("SUPABASE_DATABASE_URL must be a PostgreSQL connection URI")
        host = value.split("@", 1)[-1].split("/", 1)[0].split(":", 1)[0].lower()
        if not (host.endswith(".supabase.co") or host.endswith(".pooler.supabase.com")):
            raise ValueError("SUPABASE_DATABASE_URL must point to a Supabase database host")
        return value
