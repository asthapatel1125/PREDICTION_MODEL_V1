from datetime import datetime,timezone

from axiom.adapters.thetadata import ThetaDataV3Client


def test_snapshot_aggregation_is_open_interest_weighted():
    client=ThetaDataV3Client(api_key="test")
    rows=[
        {"timestamp":datetime(2026,7,16,14,0,tzinfo=timezone.utc),"right":"call","open_interest":100,
         "underlying_price":500,"bid":1,"ask":1.1,"gamma":.2,"vanna":.1,"charm":.1,"vomma":.3,"veta":.1,"speed":.1,"zomma":.1,"color":.1,"ultima":.1},
        {"timestamp":datetime(2026,7,16,14,0,tzinfo=timezone.utc),"right":"put","open_interest":10,
         "underlying_price":500,"bid":1,"ask":1.1,"gamma":.2,"vanna":.1,"charm":.1,"vomma":.3,"veta":.1,"speed":.1,"zomma":.1,"color":.1,"ultima":.1},
    ]
    bar=client._aggregate(rows,"QQQ",5)[0]
    assert bar.symbol=="QQQ"
    assert bar.close==500
    assert bar.greeks.gamma>0
