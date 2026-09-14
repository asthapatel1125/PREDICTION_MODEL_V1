from datetime import datetime

from axiom.adapters.thetadata import ThetaDataV3Client
from axiom.jobs.backfill_exposure import calculate_buckets


def test_calculate_buckets_emits_one_compact_row_per_timestamp():
    client=ThetaDataV3Client(api_key="test",max_dte=7)
    common={"timestamp":"2026-08-03 09:30:00","expiration":"2026-08-03",
            "open_interest":1000,"implied_volatility":.25,"underlying_price":705.0}
    rows=[
        {**common,"strike":700.0,"right":"call","delta":.60,"gamma":.02},
        {**common,"strike":710.0,"right":"put","delta":-.55,"gamma":.02},
    ]
    result=calculate_buckets(rows,client,"QQQ",60)
    assert len(result)==1
    assert result[0]["symbol"]=="QQQ"
    assert result[0]["interval_seconds"]==60
    assert result[0]["qqq_price"]==705.0
    assert result[0]["zero_gamma"]>0
    assert result[0]["zero_delta"]>0
    assert datetime.fromisoformat(result[0]["timestamp"])
