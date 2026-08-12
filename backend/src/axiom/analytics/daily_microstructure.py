from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import date, datetime
from typing import Any


@dataclass(frozen=True)
class KeyLevel:
    type: str
    strike: float
    gex_dollar: float
    oi: int
    distance_pct: float
    side: int


@dataclass(frozen=True)
class ParadigmShiftLevel:
    strike: float
    type: str
    cumulative_gex_before: float
    cumulative_gex_after: float
    time_first_seen: datetime | None


@dataclass(frozen=True)
class DailyMicrostructureReport:
    date: date
    symbol: str
    total_levels_count: int
    call_levels_count: int
    put_levels_count: int
    dense_levels_count: int
    avg_levels_per_hour: float
    call_wall_strike: float
    put_wall_strike: float
    zero_gamma: float
    max_oi_strike: float
    key_levels: list[KeyLevel]
    paradigm_shift_levels: list[ParadigmShiftLevel]

    def payload(self) -> dict[str, Any]:
        result=asdict(self)
        result["date"]=self.date.isoformat()
        result["key_levels_count"]=len(self.key_levels)
        result["paradigm_shift_count"]=len(self.paradigm_shift_levels)
        return result


class DailyMicrostructure:
    """Build a day-level, chain-derived level map without inventing system-specific GEX."""

    threshold=100_000_000.0

    @classmethod
    def build(cls, day: date, symbol: str, ticks: list[dict[str, Any]],
              confluence: list[dict[str, Any]], market_hours: float = 6.5) -> DailyMicrostructureReport:
        snapshots: dict[datetime, list[dict[str, Any]]] = defaultdict(list)
        for tick in ticks:
            snapshots[tick["timestamp"]].append(tick)
        observed: dict[float, dict[str, Any]] = {}
        shift_levels: list[ParadigmShiftLevel] = []
        last_regime_gap: float | None = None
        for timestamp, rows in sorted(snapshots.items()):
            spot=float(rows[0].get("underlying_price") or 0)
            if spot<=0: continue
            by_strike: dict[float, list[dict[str, Any]]] = defaultdict(list)
            for row in rows: by_strike[float(row["strike"])].append(row)
            signed={strike:sum((-1 if str(item.get("right","")).lower() in {"p","put"} else 1)
                *float(item.get("open_interest",0))*100*float(item.get("gamma",0))*spot**2*.01 for item in items)
                for strike,items in by_strike.items()}
            absolute_total=sum(abs(value) for value in signed.values()) or 1.0
            for strike,gex in signed.items():
                if abs(gex)>=cls.threshold:
                    prior=observed.get(strike)
                    if prior is None or abs(gex)>abs(prior["gex_dollar"]):
                        observed[strike]={"gex_dollar":gex,"oi":int(sum(float(item.get("open_interest",0)) for item in by_strike[strike])),
                            "spot":spot,"density":abs(gex)/absolute_total,"timestamp":timestamp}
            ordered=sorted(signed)
            cumulative=0.0
            for strike in ordered:
                before=cumulative; cumulative+=signed[strike]
                if before and before*cumulative<0:
                    shift_levels.append(ParadigmShiftLevel(strike,"ZERO_CROSS",before,cumulative,timestamp))
        latest_rows=snapshots[max(snapshots)] if snapshots else []
        spot=float(latest_rows[0].get("underlying_price") or 0) if latest_rows else 0
        latest: dict[float, dict[str, Any]]=defaultdict(lambda:{"gex":0.0,"oi":0})
        for row in latest_rows:
            strike=float(row["strike"]);sign=-1 if str(row.get("right","")).lower() in {"p","put"} else 1
            gex=sign*float(row.get("open_interest",0))*100*float(row.get("gamma",0))*spot**2*.01
            latest[strike]["gex"]+=gex;latest[strike]["oi"]+=int(float(row.get("open_interest",0)))
        call=max((strike for strike,data in latest.items() if data["gex"]>0),key=lambda strike:latest[strike]["gex"],default=0.0)
        put=min((strike for strike,data in latest.items() if data["gex"]<0),key=lambda strike:latest[strike]["gex"],default=0.0)
        total=sum(data["gex"] for data in latest.values()); zg=sum(strike*data["gex"] for strike,data in latest.items())/total if total else spot
        support=max((strike for strike,data in latest.items() if strike<=spot and data["gex"]>0),key=lambda strike:latest[strike]["gex"],default=0.0)
        resistance=min((strike for strike,data in latest.items() if strike>=spot and data["gex"]<0),key=lambda strike:latest[strike]["gex"],default=0.0)
        max_oi=max(latest,key=lambda strike:latest[strike]["oi"],default=0.0)
        def level(kind: str,strike: float,side: int)->KeyLevel:
            data=latest.get(strike,{"gex":0.0,"oi":0});return KeyLevel(kind,strike,float(data["gex"]),int(data["oi"]),(strike-spot)/spot*100 if spot else 0.0,side)
        key=[level("CALL_WALL",call,1),level("PUT_WALL",put,-1),level("ZERO_GAMMA",zg,0),level("SUPPORT",support,1),level("RESISTANCE",resistance,-1),level("MAX_OI",max_oi,0)]
        key.extend(level("GEX_WALL",strike,1 if latest[strike]["gex"]>=0 else -1) for strike in sorted(latest,key=lambda strike:-abs(latest[strike]["gex"]))[:5])
        for point in confluence:
            gap=float(point.get("fade_score",0))-float(point.get("amp_score",0))
            if last_regime_gap is not None and last_regime_gap*gap<0:
                shift_levels.append(ParadigmShiftLevel(float(point.get("strike",0)),"REGIME_SHIFT",last_regime_gap,gap,point.get("timestamp")))
            last_regime_gap=gap
        unique_shifts=[];seen=set()
        for item in shift_levels:
            marker=(item.type,round(item.strike,2))
            if marker not in seen: unique_shifts.append(item);seen.add(marker)
        levels=list(observed.values())
        return DailyMicrostructureReport(day,symbol.upper(),len(levels),sum(item["gex_dollar"]>0 for item in levels),sum(item["gex_dollar"]<0 for item in levels),sum(item["density"]>.5 for item in levels),len(levels)/max(market_hours,1),call,put,zg,max_oi,key,unique_shifts[:5])
