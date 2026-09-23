"""Fill SPY/QQQ four-Greek exposure history in Supabase from ThetaData.

Run from the project root with the backend environment configured:
    python -m axiom.jobs.backfill_greek_exposure --sessions 5

The job is explicit, idempotent, and never writes ClickHouse or replaces live
Wall Intelligence points. Missing historical OI causes a failure, not zeros.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import date,datetime,time,timedelta,timezone
from zoneinfo import ZoneInfo

from axiom.adapters.thetadata import ThetaDataV3Client
from axiom.config.schema import PlatformSettings
from axiom.infrastructure.database import create_database


def trading_days_ending(day:date,count:int)->list[date]:
    days=[]
    while len(days)<count:
        if day.weekday()<5:days.append(day)
        day-=timedelta(days=1)
    return list(reversed(days))


async def run(*,sessions:int=5,symbols:tuple[str,...]=("SPY","QQQ"),day:date|None=None)->dict[str,int]:
    settings=PlatformSettings()
    market_tz=ZoneInfo(settings.market_timezone)
    now=datetime.now(market_tz)
    days=trading_days_ending(day or now.date(),sessions)
    key=settings.thetadata_api_key.get_secret_value() if settings.thetadata_api_key else None
    data=ThetaDataV3Client(settings.thetadata_base_url,settings.thetadata_timeout_seconds,
        api_key=key,transport=settings.thetadata_transport,max_dte=settings.thetadata_max_dte,
        strike_range=settings.thetadata_strike_range,market_timezone=settings.market_timezone,
        capture_gamma_ticks=False)
    _,repository=await create_database(settings.database_url)
    counts:dict[str,int]={};errors=[]
    for session_day in days:
        opening=datetime.combine(session_day,time(9,30),market_tz).astimezone(timezone.utc)
        closing=datetime.combine(session_day,time(16,0),market_tz).astimezone(timezone.utc)
        if session_day==now.date():closing=min(closing,now.astimezone(timezone.utc))
        if closing<=opening:continue
        for symbol in symbols:
            points=[]
            try:
                async for bar in data.historical_exposure_bars(symbol,opening,closing):
                    metrics=bar.gamma_metrics
                    points.append({"timestamp":bar.timestamp.astimezone(timezone.utc).replace(second=0,microsecond=0),
                        "symbol":symbol,"spot":float(bar.close),
                        "dex_signed_raw":float(metrics["dex_signed_raw"]),
                        "gamma_exposure_raw":float(metrics["gex_raw"]),
                        "charm_exposure_raw":float(metrics["charm_exposure_raw"]),
                        "speed_exposure_raw":float(metrics["speed_exposure_raw"]),
                        "contracts_used":int(bar.contract_count),
                        "source":"THETADATA_HISTORY_GREEKS_PLUS_DAILY_OI"})
                if not points:
                    raise RuntimeError("no Greek/OI observations returned")
                await repository.save_greek_exposure_history(points)
                counts[symbol]=counts.get(symbol,0)+len(points)
                print(f"{session_day} {symbol}: stored {len(points)} 1m exposure points in Supabase",flush=True)
            except Exception as exc:
                errors.append(f"{session_day} {symbol}: {type(exc).__name__}: {exc}")
    if errors:raise RuntimeError("Historical exposure backfill incomplete: "+"; ".join(errors))
    return counts


def main()->None:
    parser=argparse.ArgumentParser(description="Backfill SPY/QQQ four-Greek exposure into Supabase")
    parser.add_argument("--sessions",type=int,default=5,help="Recent trading sessions, including today (default: 5)")
    parser.add_argument("--day",type=date.fromisoformat,help="Final exchange-local date (default: today)")
    parser.add_argument("--symbol",action="append",choices=("SPY","QQQ"),help="Limit to a symbol; omit for both")
    args=parser.parse_args()
    if not 1<=args.sessions<=20:parser.error("--sessions must be between 1 and 20")
    asyncio.run(run(sessions=args.sessions,symbols=tuple(dict.fromkeys(args.symbol or ("SPY","QQQ"))),day=args.day))


if __name__=="__main__":main()
