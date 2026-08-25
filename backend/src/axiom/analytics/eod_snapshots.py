from __future__ import annotations

from datetime import datetime
from html import escape
from math import isfinite
from typing import Any, Callable
from zoneinfo import ZoneInfo


COLORS={"qqq":"#e6edf3","call":"#00d084","put":"#ff4f69","zero_gamma":"#b56cff","zero_delta":"#62c8ff","dealer_flow":"#ff9f43","tpi":"#4dd4ac","mpi":"#ff6b9d","cvd":"#58a6ff"}


def _number(value:Any)->float|None:
    try:
        result=float(value)
        return result if isfinite(result) else None
    except (TypeError,ValueError):
        return None


def _wall(row:dict[str,Any],name:str)->float|None:
    return _number((row.get("walls") or {}).get(name,{}).get("strike"))


def _derived(rows:list[dict[str,Any]])->list[dict[str,Any]]:
    if not rows:return []
    flows=[abs(_number(row.get("dealer_flow")) or 0) for row in rows];max_flow=max(flows or [1]) or 1
    output=[];cvd=0.0;trend=50.0
    for index,row in enumerate(rows):
        spot=_number(row.get("spot"));flow=_number(row.get("dealer_flow")) or 0;tpi=max(0,min(100,_number(row.get("pressure_trend")) or 50));previous=rows[index-1] if index else row
        previous_tpi=max(0,min(100,_number(previous.get("pressure_trend")) or 50));dt=max((datetime.fromisoformat(str(row["timestamp"]).replace("Z","+00:00"))-datetime.fromisoformat(str(previous["timestamp"]).replace("Z","+00:00"))).total_seconds(),1)
        previous_spot=_number(previous.get("spot")) or spot or 0;roc=min(100,abs(tpi-previous_tpi)/dt*20);flow_pct=tpi*abs(flow)/max_flow;div=max(0,min(100,50+((spot or 0)-previous_spot)*250));mpi=.4*flow_pct+.3*roc+.3*div;trend=.1*mpi+.9*trend if index else mpi;cvd+=flow
        output.append({**row,"spot":spot,"tpi":tpi,"mpi":mpi,"mpi_trend":trend,"cvd":cvd})
    return output


def render_eod_svg(rows:list[dict[str,Any]],map_name:str,market_timezone:str="America/New_York")->str:
    rows=sorted((row for row in rows if row.get("timestamp")),key=lambda row:str(row["timestamp"]));derived=_derived(rows)
    definitions:dict[str,tuple[str,str,list[tuple[str,str,Callable[[dict[str,Any]],float|None]]]]]={
        "hedge-levels":("Wall Intelligence · Daily Hedge Levels","PRICE · USD",[("QQQ","qqq",lambda r:_number(r.get("spot"))),("CALL WALL","call",lambda r:_wall(r,"CALL_WALL")),("PUT WALL","put",lambda r:_wall(r,"PUT_WALL")),("ZERO GAMMA","zero_gamma",lambda r:_wall(r,"ZERO_GAMMA")),("ZERO DELTA","zero_delta",lambda r:_wall(r,"ZERO_DELTA"))]),
        "zero-gamma":("Wall Intelligence · Zero Gamma","PRICE · USD",[("QQQ","qqq",lambda r:_number(r.get("spot"))),("ZERO GAMMA","zero_gamma",lambda r:_wall(r,"ZERO_GAMMA"))]),
        "zero-delta":("Wall Intelligence · Zero Delta","PRICE · USD",[("QQQ","qqq",lambda r:_number(r.get("spot"))),("ZERO DELTA","zero_delta",lambda r:_wall(r,"ZERO_DELTA"))]),
        "dealer-flow":("Wall Intelligence · Dealer Flow","FLOW PROXY",[("DEALER FLOW","dealer_flow",lambda r:_number(r.get("dealer_flow")))]),
        "tpi":("MPI · Pressure Trend","QQQ USD / TPI",[("QQQ","qqq",lambda r:_number(r.get("spot"))),("TPI","tpi",lambda r:_number(r.get("tpi")))]),
        "mpi":("MPI · Market Pressure Index","QQQ USD / MPI",[("QQQ","qqq",lambda r:_number(r.get("spot"))),("MPI","mpi",lambda r:_number(r.get("mpi")))]),
        "cvd":("MPI · Cumulative Flow","QQQ USD / FLOW PROXY",[("QQQ","qqq",lambda r:_number(r.get("spot"))),("CVD","cvd",lambda r:_number(r.get("cvd")))]),
    }
    if map_name not in definitions:raise ValueError("Unsupported EOD snapshot map")
    title,y_label,series=definitions[map_name];source=derived if map_name in {"tpi","mpi","cvd"} else rows
    width,height,left,right,top,bottom=1800,980,118,42,152,112;plot_w=width-left-right;plot_h=height-top-bottom
    values=[value for _,_,getter in series for row in source if (value:=getter(row)) is not None]
    if not values:return _empty_svg(width,height,title)
    low,high=min(values),max(values);padding=max((high-low)*.08,.01);low-=padding;high+=padding
    x=lambda index:left+index*plot_w/max(len(source)-1,1);y=lambda value:top+(high-value)/max(high-low,1e-9)*plot_h
    parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">', '<rect width="100%" height="100%" fill="#071019"/>',f'<text x="42" y="48" fill="#e4edf3" font-family="monospace" font-size="30" font-weight="700">{escape(title)}</text>', '<text x="42" y="79" fill="#8eb5c8" font-family="monospace" font-size="19" font-weight="700">END-OF-DAY SNAPSHOT · EASTERN TIME (EST)</text>','<rect x="30" y="91" width="1740" height="45" rx="7" fill="#0b1d2a" stroke="#28546d"/>']
    for index in range(7):
        ratio=index/6;yy=top+ratio*plot_h;value=high-ratio*(high-low);parts.extend([f'<line x1="{left}" y1="{yy:.1f}" x2="{width-right}" y2="{yy:.1f}" stroke="#24495e"/>',f'<text x="{left-14}" y="{yy+5:.1f}" text-anchor="end" fill="#b9ced9" font-family="monospace" font-size="16">{value:.2f}</text>'])
    tz=ZoneInfo(market_timezone)
    for index in range(9):
        ratio=index/8;row_index=round(ratio*(len(source)-1));xx=left+ratio*plot_w;observed=datetime.fromisoformat(str(source[row_index]["timestamp"]).replace("Z","+00:00")).astimezone(tz);stamp=observed.strftime("%I:%M %p").lstrip("0")+" EST";parts.extend([f'<line x1="{xx:.1f}" y1="{top}" x2="{xx:.1f}" y2="{height-bottom}" stroke="#24495e" stroke-dasharray="3 6"/>',f'<text x="{xx:.1f}" y="{height-bottom+32}" text-anchor="middle" fill="#d4e5ee" font-family="monospace" font-size="17" font-weight="700">{stamp}</text>'])
    parts.extend([f'<text x="30" y="{top+plot_h/2}" transform="rotate(-90 30 {top+plot_h/2})" text-anchor="middle" fill="#b9ced9" font-family="monospace" font-size="17">Y AXIS · {escape(y_label)}</text>',f'<text x="{left+plot_w/2}" y="{height-25}" text-anchor="middle" fill="#b9ced9" font-family="monospace" font-size="17">X AXIS · EASTERN TIME (EST)</text>'])
    legend_x=50
    for label,color_key,getter in series:
        path=[]
        for index,row in enumerate(source):
            value=getter(row)
            if value is not None:path.append(f'{"M" if not path else "L"}{x(index):.1f},{y(value):.1f}')
        color=COLORS[color_key];dash=' stroke-dasharray="12 8"' if "zero" in color_key else "";parts.append(f'<path d="{" ".join(path)}" fill="none" stroke="{color}" stroke-width="4"{dash}/>' )
        parts.extend([f'<line x1="{legend_x}" y1="114" x2="{legend_x+34}" y2="114" stroke="{color}" stroke-width="6"/>',f'<text x="{legend_x+45}" y="121" fill="#f1f8fb" font-family="monospace" font-size="20" font-weight="700">{escape(label)}</text>']);legend_x+=max(205,len(label)*15+90)
    parts.append("</svg>");return "".join(parts)


def _empty_svg(width:int,height:int,title:str)->str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"><rect width="100%" height="100%" fill="#071019"/><text x="50%" y="45%" text-anchor="middle" fill="#e4edf3" font-family="monospace" font-size="28">{escape(title)}</text><text x="50%" y="52%" text-anchor="middle" fill="#8eb5c8" font-family="monospace" font-size="20">NO STORED OBSERVATIONS FOR THIS DATE</text></svg>'
