import pytest
from pydantic import ValidationError

from axiom.config.schema import PlatformSettings
from axiom.infrastructure.database import Base


def test_supabase_uri_selects_async_postgres_driver(monkeypatch):
    monkeypatch.setenv(
        "SUPABASE_DATABASE_URL",
        "postgresql://postgres.ref:password@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require",
    )
    settings=PlatformSettings()
    assert settings.database_url.startswith("postgresql+asyncpg://")
    assert settings.database_url.endswith("ssl=require")


def test_non_supabase_database_is_rejected(monkeypatch):
    monkeypatch.setenv("SUPABASE_DATABASE_URL","postgresql://user:pass@localhost:5432/postgres")
    with pytest.raises(ValidationError):PlatformSettings()


def test_normalized_schema_contains_persistence_tables():
    expected={"alerts","historical_alerts","live_alerts","market_states","metrics","performance","regimes","trades","configurations","model_versions","system_events"}
    assert expected.issubset(Base.metadata.tables)
