from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
from datetime import date, datetime, timedelta
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

from axiom.adapters.thetadata import ThetaDataV3Client
from axiom.config.schema import PlatformSettings
from axiom.infrastructure.clickhouse import ClickHouseRepository


def _settings_repository(settings: PlatformSettings) -> ClickHouseRepository:
    if not settings.clickhouse_host or not settings.clickhouse_password:
        raise RuntimeError("CLICKHOUSE_HOST and CLICKHOUSE_PASSWORD are required")
    return ClickHouseRepository(settings.clickhouse_host, settings.clickhouse_port, settings.clickhouse_database,
                                settings.clickhouse_user, settings.clickhouse_password.get_secret_value(), settings.clickhouse_secure)


def calculate_buckets(rows: list[dict[str, Any]], calculator: ThetaDataV3Client, symbol: str, interval_seconds: int) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row["timestamp"])].append(row)
    output=[]
    for timestamp in sorted(grouped):
        contracts=grouped[timestamp]
        spots=[float(row["underlying_price"]) for row in contracts if float(row.get("underlying_price") or 0)>0]
        if not spots:
            continue
        observed=datetime.fromisoformat(timestamp).replace(tzinfo=ZoneInfo("America/New_York"))
        metrics=calculator._gamma_metrics(contracts, median(spots), observed, symbol)
        if not metrics.get("chain_available"):
            continue
        output.append({
            "symbol":symbol.upper(), "timestamp":observed.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3], "interval_seconds":interval_seconds,
            "qqq_price":float(metrics["spot"]), "zero_gamma":float(metrics["zero_gamma"]),
            "zero_gamma_raw":float(metrics["zero_gamma_raw"]),
            "zero_gamma_confidence":float(metrics["zero_gamma_confidence"]),
            "zero_gamma_method":str(metrics["zero_gamma_method"]), "zero_delta":float(metrics["zero_delta"]),
            "zero_delta_method":str(metrics["zero_delta_method"]),
            "contract_count":int(metrics["zero_gamma_contracts"]),
        })
    return output


async def run(start: date, end: date, symbol: str, interval_seconds: int) -> None:
    settings=PlatformSettings()
    repository=_settings_repository(settings)
    if not await repository.exposure_history_ready():
        raise RuntimeError("axiom.exposure_history is missing; create it once from the ClickHouse shell before running this job")
    calculator=ThetaDataV3Client(settings.thetadata_base_url, settings.thetadata_timeout_seconds,
        transport=settings.thetadata_transport, max_dte=settings.thetadata_max_dte,
        strike_range=settings.thetadata_strike_range, market_timezone=settings.market_timezone)
    current=start
    while current<=end:
        inputs=await repository.exposure_inputs(symbol,current,interval_seconds)
        calculated=calculate_buckets(inputs,calculator,symbol,interval_seconds)
        await repository.replace_exposure_day(symbol,current,calculated,interval_seconds)
        print(f"{current}: {len(inputs):,} contract buckets -> {len(calculated):,} chart buckets",flush=True)
        current+=timedelta(days=1)


def main() -> None:
    parser=argparse.ArgumentParser(description="Build compact historical Zero Gamma/Zero Delta buckets")
    parser.add_argument("--start-date",type=date.fromisoformat,required=True)
    parser.add_argument("--end-date",type=date.fromisoformat,required=True)
    parser.add_argument("--symbol",default="QQQ")
    parser.add_argument("--interval",type=int,default=60,choices=(60,300,900,1800,3600))
    args=parser.parse_args()
    if args.end_date<args.start_date:parser.error("--end-date must not precede --start-date")
    asyncio.run(run(args.start_date,args.end_date,args.symbol,args.interval))


if __name__ == "__main__":
    main()
