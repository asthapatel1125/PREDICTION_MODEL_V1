from fastapi.testclient import TestClient

from axiom.api.app import create_app
from axiom.config.schema import PlatformSettings


def test_health_endpoint(monkeypatch):
    async def fake_create_database(_url):return None,object()
    monkeypatch.setattr("axiom.api.app.create_database",fake_create_database)
    settings=PlatformSettings(strategy_config_path="config/strategy.yaml")
    with TestClient(create_app(settings)) as client:
        response=client.get("/api/v1/health")
        assert response.status_code==200
        assert response.json()["status"]=="healthy"
