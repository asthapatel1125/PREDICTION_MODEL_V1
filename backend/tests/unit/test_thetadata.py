from datetime import datetime,timezone

import pytest

from axiom.adapters.thetadata import ThetaDataProtocolError,ThetaDataV3Client


def test_snapshot_aggregation_is_open_interest_weighted():
    client=ThetaDataV3Client(api_key="test")
    rows=[
        {"timestamp":datetime(2026,7,16,14,0,tzinfo=timezone.utc),"right":"call","open_interest":100,
         "underlying_price":500,"bid":1,"ask":1.1,"delta":.6,"theta":-.2,"vega":.4,"rho":.1,"gamma":.2,"vanna":.1,"charm":.1,"vomma":.3,"veta":.1,"speed":.1,"zomma":.1,"color":.1,"ultima":.1},
        {"timestamp":datetime(2026,7,16,14,0,tzinfo=timezone.utc),"right":"put","open_interest":10,
         "underlying_price":500,"bid":1,"ask":1.1,"delta":-.4,"theta":-.2,"vega":.4,"rho":-.1,"gamma":.2,"vanna":.1,"charm":.1,"vomma":.3,"veta":.1,"speed":.1,"zomma":.1,"color":.1,"ultima":.1},
    ]
    bar=client._aggregate(rows,"QQQ",5)[0]
    assert bar.symbol=="QQQ"
    assert bar.close==500
    assert bar.greeks.gamma>0
    assert bar.greeks.delta>0
    assert bar.greeks.vega>0
    assert bar.contract_count==2
    assert bar.open_interest==110


def test_live_polling_defaults_to_5_seconds():
    assert ThetaDataV3Client(api_key="test").poll_seconds==5


def test_open_interest_merge_normalizes_contract_identifiers():
    greeks=[{"expiration":"2026-07-24","strike":500.0,"right":"call","open_interest":0}]
    interest=[{"expiration":20260724,"strike":"500.000","right":"C","open_interest":321}]
    ThetaDataV3Client._merge_open_interest(greeks,interest)
    assert greeks[0]["open_interest"]==321


def test_first_order_preserves_provider_native_signs():
    client=ThetaDataV3Client(api_key="test")
    timestamp=datetime(2026,7,16,14,0,tzinfo=timezone.utc)
    common={"timestamp":timestamp,"expiration":"20260724","strike":500,"underlying_price":500,
            "bid":1,"ask":1.1,"theta":-.2,"vega":.4,"gamma":.2,"vanna":.1,"charm":.1,
            "vomma":.3,"veta":.1,"speed":.1,"zomma":.1,"color":.1,"ultima":.1}
    rows=[{**common,"right":"call","open_interest":100,"delta":.6,"rho":.1},
          {**common,"right":"put","open_interest":100,"delta":-.4,"rho":-.1}]
    greeks=client._aggregate(rows,"QQQ",5)[0].greeks
    assert greeks.delta==pytest.approx(.1)
    assert greeks.theta==pytest.approx(-.2)
    assert greeks.vega==pytest.approx(.4)


def test_all_three_greek_orders_are_required_in_snapshots():
    client=ThetaDataV3Client(api_key="test")
    incomplete=[{"timestamp":datetime(2026,7,16,14,0,tzinfo=timezone.utc),"delta":.5,"gamma":.1}]
    with pytest.raises(ThetaDataProtocolError,match="missing numeric fields"):
        client._require_all_greek_orders(incomplete)


def test_all_zero_first_order_provider_snapshot_is_rejected():
    client=ThetaDataV3Client(api_key="test")
    rows=[{"delta":0,"theta":0,"vega":0,"rho":0} for _ in range(4)]
    with pytest.raises(ThetaDataProtocolError,match="all-zero first-order"):
        client._require_live_first_order_values(rows)


def test_valid_zero_delta_does_not_reject_other_live_first_order_values():
    client=ThetaDataV3Client(api_key="test")
    rows=[{"delta":0,"theta":-.05,"vega":.12,"rho":0}]
    client._require_live_first_order_values(rows)


def test_dataframe_column_names_and_nested_greeks_are_normalized():
    rows=ThetaDataV3Client._normalize_rows([{
        "UnderlyingPrice":500,"Open Interest":12,"Greeks":{"Delta":.4,"Vanna":.2}
    }])
    assert rows[0]["underlying_price"]==500
    assert rows[0]["open_interest"]==12
    assert rows[0]["delta"]==.4
    assert rows[0]["vanna"]==.2
