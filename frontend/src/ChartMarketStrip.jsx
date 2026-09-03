import React from "react";

const finite=value=>Number.isFinite(Number(value));
const defaultPrice=row=>row?.spot??row?.close??row?.price??row?.supporting_indicators?.price;
const defaultTime=timestamp=>timestamp?new Date(timestamp).toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit"})+" ET":"WAITING";

export default function ChartMarketStrip({active=null,live=null,items=[],priceFor=defaultPrice,timeFor=defaultTime,label="QQQ"}){
  const row=active??live;
  const price=priceFor(row);
  return <div className={`chart-market-strip ${active?"is-hovered":"is-live"}`} aria-live="polite">
    <span className="chart-market-symbol">{label}</span>
    <b className="chart-market-price">{finite(price)?Number(price).toFixed(2):"WAITING"}</b>
    <small>{active?`${timeFor(row?.timestamp)} · CURSOR`:row?.timestamp?`${timeFor(row.timestamp)} · LIVE`:"WAITING FOR STREAM"}</small>
    {items.map((item,index)=><span className={`chart-market-item ${item.tone??""}`} style={{"--chart-item-color":item.color??"#9fc5d8"}} key={`${item.label}-${index}`}>
      <em>{item.label}</em><strong>{item.value??"—"}</strong>
    </span>)}
  </div>;
}
