import asyncio
from datetime import UTC,datetime

from axiom.infrastructure.database import SqlAlchemyRepository


class _Result:
    def mappings(self):return self
    def all(self):
        return [{"timestamp":datetime(2026,9,21,14,30,tzinfo=UTC),"open":740.0,"high":742.0,
            "low":739.5,"close":741.5,"zero_gamma":745.0,"zero_delta":738.0}]


class _Session:
    def __init__(self,captured):self.captured=captured
    async def __aenter__(self):return self
    async def __aexit__(self,*_args):return None
    async def execute(self,statement,params):
        self.captured.update(sql=str(statement),params=params)
        return _Result()


def test_supabase_exposure_candles_are_calendar_bucketed_in_postgres():
    captured={}
    repository=SqlAlchemyRepository(lambda:_Session(captured))
    rows=asyncio.run(repository.wall_exposure_candles("QQQ",1800,151,days=14))
    assert rows[0]["close"]==741.5
    assert "FROM wall_intelligence" in captured["sql"]
    assert "AT TIME ZONE :tz" in captured["sql"]
    assert "date_trunc('day',local_timestamp)" in captured["sql"]
    assert captured["params"]["bucket"]==1800
    assert captured["params"]["limit"]==151
    assert captured["params"]["tz"]=="America/New_York"
