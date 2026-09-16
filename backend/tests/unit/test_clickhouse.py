import asyncio
from datetime import date

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
    assert "INTERVAL 7 HOUR" in sql
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
