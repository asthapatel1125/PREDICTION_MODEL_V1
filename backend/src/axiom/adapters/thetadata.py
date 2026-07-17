from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator,Callable
from datetime import datetime,timezone
from typing import Any

import httpx

from axiom.domain.models import Greeks,MarketBar
from axiom.ports.interfaces import MarketDataPort


class ThetaDataProtocolError(RuntimeError):pass


class ThetaDataV3Client(MarketDataPort):
    """Theta Terminal v3 adapter using the Options Pro all-Greeks endpoint.

    The terminal must run locally. Rows are aggregated to signed exposure using
    option right and open interest/volume weights before entering the pipeline.
    """
    def __init__(self,base_url:str="http://127.0.0.1:25503/v3",timeout:float=60,
                 expiration_selector:Callable[[str,datetime],str]|None=None):
        self.base_url=base_url.rstrip("/");self.timeout=timeout;self.expiration_selector=expiration_selector or (lambda _s,ts:ts.strftime("%Y%m%d"))

    async def historical_bars(self,symbol:str,start:datetime,end:datetime,resolution_seconds:int)->AsyncIterator[MarketBar]:
        expiration=self.expiration_selector(symbol,start)
        params={"symbol":symbol,"expiration":expiration,"strike":"*","right":"both","start_date":start.strftime("%Y%m%d"),
            "end_date":end.strftime("%Y%m%d"),"start_time":start.strftime("%H:%M:%S"),"end_time":end.strftime("%H:%M:%S"),
            "interval":f"{resolution_seconds}s","format":"json"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response=await client.get(f"{self.base_url}/option/history/greeks/all",params=params);response.raise_for_status()
            rows=self._rows(response.json()); grouped=self._aggregate(rows,symbol,resolution_seconds)
            for bar in grouped:
                if start<=bar.timestamp<=end:yield bar

    async def live_bars(self,symbol:str,resolution_seconds:int)->AsyncIterator[MarketBar]:
        # Theta v3 exposes real-time snapshots locally; polling is intentionally
        # isolated here so it can be swapped for Terminal streaming transport.
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            while True:
                expiration=self.expiration_selector(symbol,datetime.now(timezone.utc))
                response=await client.get(f"{self.base_url}/option/snapshot/greeks/all",params={"symbol":symbol,"expiration":expiration,"strike":"*","right":"both","format":"json"})
                response.raise_for_status();bars=self._aggregate(self._rows(response.json()),symbol,resolution_seconds)
                if bars:yield bars[-1]
                await asyncio.sleep(resolution_seconds)

    @staticmethod
    def _rows(payload:Any)->list[dict[str,Any]]:
        if isinstance(payload,list):return [r for r in payload if isinstance(r,dict)]
        if isinstance(payload,dict):
            for key in ("response","data","results"):
                value=payload.get(key)
                if isinstance(value,list):return [r for r in value if isinstance(r,dict)]
        raise ThetaDataProtocolError("ThetaData response did not contain object rows")

    def _aggregate(self,rows:list[dict[str,Any]],symbol:str,resolution_seconds:int)->list[MarketBar]:
        buckets:dict[int,list[dict[str,Any]]]={}
        for row in rows:
            ts=self._timestamp(row);buckets.setdefault(int(ts.timestamp())//resolution_seconds,[]).append(row)
        result=[]
        for _,group in sorted(buckets.items()):
            ts=self._timestamp(group[-1]);weights=[max(float(r.get("open_interest") or r.get("volume") or 1),1) for r in group]
            total=sum(weights);signed=[]
            for r,w in zip(group,weights):
                right=str(r.get("right","")).lower();sign=1 if right in {"call","c"} else -1
                signed.append((r,w,sign))
            def exposure(name:str)->float:return sum(float(r.get(name,0))*w*sign for r,w,sign in signed)/total
            price=float(group[-1].get("underlying_price") or group[-1].get("stock_price") or group[-1].get("price") or 0)
            if price<=0:continue
            greeks=Greeks(**{n:exposure(n) for n in Greeks.model_fields})
            result.append(MarketBar(timestamp=ts,symbol=symbol,timeframe_seconds=resolution_seconds,open=price,high=price,low=price,close=price,
                volume=sum(float(r.get("volume") or 0) for r in group),bid_ask_spread=sum(max(0,float(r.get("ask",0))-float(r.get("bid",0))) for r in group)/len(group),greeks=greeks))
        return result

    @staticmethod
    def _timestamp(row:dict[str,Any])->datetime:
        value=row.get("timestamp") or row.get("datetime")
        if isinstance(value,(int,float)):return datetime.fromtimestamp(value/1000 if value>10**12 else value,tz=timezone.utc)
        if isinstance(value,str):return datetime.fromisoformat(value.replace("Z","+00:00"))
        raise ThetaDataProtocolError("Row missing timestamp")
