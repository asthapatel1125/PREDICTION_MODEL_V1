import asyncio
from datetime import UTC,date,datetime

from axiom.infrastructure.clickhouse import ClickHouseRepository


def test_exposure_candle_query_has_valid_with_alias_syntax():
    repository=ClickHouseRepository("clickhouse",8123,"axiom","user","password")
    captured={}

    async def request(sql,**_kwargs):
        captured["sql"]=sql
        return ""

    repository._request=request
    assert asyncio.run(repository.exposure_candles("QQQ",5,300,100))==[]
    sql=captured["sql"]
    assert "origin AS toDateTime" not in sql
    assert "selected_days AS" in sql
    assert "toTime('07:00:00')" in sql
    assert "toTime('18:00:00')" in sql
    assert "toStartOfInterval(timestamp, INTERVAL 300 SECOND" in sql
    assert "toDateTime('1970-01-01 00:00:00','America/New_York')" in sql
    assert "FORMAT JSONEachRow" in sql


def test_exposure_candle_range_is_bounded_in_clickhouse():
    repository=ClickHouseRepository("clickhouse",8123,"axiom","user","password")
    captured={}

    async def request(sql,**_kwargs):
        captured["sql"]=sql
        return ""

    repository._request=request
    asyncio.run(repository.exposure_candles("QQQ",10,300,5000,date(2026,9,1),date(2026,9,10)))
    assert "BETWEEN toDate('2026-09-01') AND toDate('2026-09-10')" in captured["sql"]


def test_exposure_candle_backfill_page_is_bounded_before_cursor():
    repository=ClickHouseRepository("clickhouse",8123,"axiom","user","password")
    captured={}

    async def request(sql,**_kwargs):
        captured["sql"]=sql
        return ""

    repository._request=request
    before=datetime(2026,9,17,14,30,tzinfo=UTC)
    asyncio.run(repository.exposure_candles("QQQ",10,1800,151,before=before))
    assert "timestamp < toDateTime64('2026-09-17T14:30:00+00:00',3,'UTC')" in captured["sql"]
