import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchChart, fetchConfiguration, fetchDashboard, fetchInstruments, fetchReplay, fetchStateHistory, fetchSystem, startLiveEngine,
  startReplay, stopLiveEngine, subscribeToEvents, toDashboardAlert,
} from "./api";

const OVERVIEW_SECTIONS = [
  ["One-screen focus", "decision"], ["Signal scores", "score-modules"], ["Greek orders", "greek-orders"],
  ["Custom Greek graphs", "custom-greeks"], ["Live alerts", "live-alerts"],
];
const GREEKS = ["gamma", "vanna", "charm", "vomma", "veta", "speed", "zomma", "color", "ultima"];
const CHART_INTERVALS = [
  ["5s", 5], ["15s", 15], ["1m", 60], ["3m", 180], ["5m", 300],
  ["15m", 900], ["30m", 1800], ["1h", 3600], ["4h", 14400], ["1D", 86400],
];
const GREEK_ORDERS = {
  first: { label: "1st order · pink", series: [["delta", "#ff4f9a"], ["theta", "#ff79b5"], ["vega", "#d94dff"], ["rho", "#ffafd2"]] },
  second: { label: "2nd order · sky blue", series: [["gamma", "#43bfff"], ["vanna", "#75d8ff"], ["charm", "#438dff"], ["vomma", "#a5e8ff"], ["veta", "#6aa8ff"]] },
  third: { label: "3rd order · lime green", series: [["speed", "#a8f05a"], ["zomma", "#62df72"], ["color", "#d2ff66"], ["ultima", "#77f6a5"]] },
};
const FALLBACK_INSTRUMENTS = ["SPY", "QQQ", "NDX", "NQ", "ES", "YM"].map(symbol => ({
  symbol, available: ["SPY", "QQQ", "NDX"].includes(symbol),
  provider: ["SPY", "QQQ", "NDX"].includes(symbol) ? "ThetaData options" : "Futures feed required",
}));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const pct = (value) => `${(number(value) * 100).toFixed(1)}%`;
const pretty = (value = "") => String(value).replaceAll("_", " ");
const biasLabel = (value) => value === "UP" ? "LONG" : value === "DOWN" ? "SHORT" : "WAIT";
const time = (value) => value ? new Date(value).toLocaleTimeString([], { hour12: false }) : "—";

function deriveOptionsDecision(state) {
  if (!state) return { qualified:false, direction:"NEUTRAL", failed:[], checks:{} };
  const directionValue=number(state.direction?.value), pressure=number(state.pressure?.value);
  const direction=directionValue>0?"UP":directionValue<0?"DOWN":"NEUTRAL";
  const thresholds={explosion:number(state.active_thresholds?.explosion_min,.58),direction:number(state.active_thresholds?.direction_min,2),pressure:number(state.active_thresholds?.pressure_min,.15),confidence:number(state.active_thresholds?.confidence_min,.68),risk:number(state.active_thresholds?.risk_max,.88)};
  const fallbackConfidence=(.30*number(state.explosion?.value)+.25*Math.abs(directionValue)/3+.20*Math.abs(pressure))/.75;
  const optionsConfidence=number(state.supporting_indicators?.options_confidence,fallbackConfidence);
  const derived={explosion:number(state.explosion?.value)>=thresholds.explosion,direction:Math.abs(directionValue)>=thresholds.direction,
    pressure_alignment:(direction==="UP"&&pressure>=thresholds.pressure)||(direction==="DOWN"&&pressure<=-thresholds.pressure),
    confidence:optionsConfidence>=thresholds.confidence,risk:number(state.risk?.value)<thresholds.risk};
  const requiredChecks=["explosion","direction","pressure_alignment","confidence","risk"];
  const hasCurrentChecks=requiredChecks.every(name=>typeof state.signal_checks?.[name]==="boolean");
  const checks=hasCurrentChecks?Object.fromEntries(requiredChecks.map(name=>[name,state.signal_checks[name]])):derived;
  const failed=Object.entries(checks).filter(([,passed])=>!passed).map(([name])=>pretty(name));
  const qualified=Object.values(checks).every(Boolean)&&direction!=="NEUTRAL";
  return {qualified,direction,failed,checks,optionsConfidence,thresholds};
}

const FORECAST_GREEKS=["delta","gamma","vanna","charm","speed","zomma","color","ultima"];
function forecastVector(row){const indicators=row?.supporting_indicators??{};return [number(row?.explosion?.value),number(row?.direction?.value)/3,number(row?.pressure?.value),number(indicators.options_confidence),number(row?.risk?.value),number(row?.dealer_hedging?.value),...FORECAST_GREEKS.map(name=>number(indicators[`greek_${name}`]))]}
function deriveFiveMinuteForecast(history,state){
  const rows=[...history.filter(row=>row?.timestamp&&Number.isFinite(number(row?.supporting_indicators?.price,NaN)))];
  if(state?.timestamp&&Number.isFinite(number(state?.supporting_indicators?.price,NaN))&&!rows.some(row=>row.timestamp===state.timestamp))rows.push(state);
  rows.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const samples=[];
  for(let index=0;index<rows.length-1;index++){const start=new Date(rows[index].timestamp).getTime(),horizon=start+300000,price=number(rows[index].supporting_indicators.price);let label="WAIT",complete=false,move=0;for(let future=index+1;future<rows.length;future++){const timestamp=new Date(rows[future].timestamp).getTime();if(timestamp>horizon){complete=true;break}const delta=number(rows[future].supporting_indicators.price)-price;if(Math.abs(delta)>Math.abs(move))move=delta;if(delta>=30){label="UP";complete=true;break}if(delta<=-30){label="DOWN";complete=true;break}}if(complete)samples.push({features:forecastVector(rows[index]),label,move})}
  const current=state??rows.at(-1),price=number(current?.supporting_indicators?.price,NaN),eventCount=samples.filter(sample=>sample.label!=="WAIT").length;
  if(!current||!Number.isFinite(price)||samples.length<120)return {ready:false,label:"WAIT",price,samples:samples.length,eventCount,reason:`Need ${Math.max(0,120-samples.length)} more fully labeled five-minute observations.`};
  const width=samples[0].features.length,means=Array.from({length:width},(_,column)=>samples.reduce((sum,sample)=>sum+sample.features[column],0)/samples.length),scales=Array.from({length:width},(_,column)=>Math.sqrt(samples.reduce((sum,sample)=>sum+(sample.features[column]-means[column])**2,0)/samples.length)||1),query=forecastVector(current);
  const ranked=samples.map(sample=>({label:sample.label,distance:Math.sqrt(sample.features.reduce((sum,value,column)=>sum+((value-query[column])/scales[column])**2,0))})).sort((a,b)=>a.distance-b.distance),neighbors=ranked.slice(0,Math.min(41,ranked.length)),weights={UP:0,DOWN:0,WAIT:0};
  neighbors.forEach(neighbor=>weights[neighbor.label]+=1/(neighbor.distance+.15));const total=weights.UP+weights.DOWN+weights.WAIT||1,probabilities=Object.fromEntries(Object.entries(weights).map(([label,value])=>[label,value/total])),label=Object.entries(probabilities).sort((a,b)=>b[1]-a[1])[0][0];
  return {ready:true,label,price,samples:samples.length,eventCount,neighbors:neighbors.length,probabilities,confidence:probabilities[label],reason:eventCount?"Nearest historical options-pressure states with observed five-minute outcomes.":"No 30-point event exists in the loaded labeled history; WAIT is the only observed class."};
}

function Sparkline({ values = [], color = "#4de0bd", fill = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const data = values.length > 1 ? values.map(Number) : [0, 0];
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 240;
    const height = canvas.clientHeight || 72;
    canvas.width = width * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
    const min = Math.min(...data), max = Math.max(...data), pad = 4;
    const pts = data.map((v, i) => [pad + i * (width - pad * 2) / (data.length - 1), height - pad - (v - min) / (max - min || 1) * (height - pad * 2)]);
    if (fill) {
      const grad = ctx.createLinearGradient(0, 0, 0, height); grad.addColorStop(0, `${color}44`); grad.addColorStop(1, `${color}00`);
      ctx.beginPath(); ctx.moveTo(pts[0][0], height); pts.forEach(p => ctx.lineTo(...p)); ctx.lineTo(pts.at(-1)[0], height); ctx.fillStyle = grad; ctx.fill();
    }
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  }, [values, color, fill]);
  return <canvas className="sparkline" ref={ref} />;
}

function PriceChart({ history = [] }) {
  const prices = history.map(row => number(row.supporting_indicators?.price)).filter(Boolean);
  return <div className="live-price-chart"><Sparkline values={prices} color="#4de0bd" />
    {!prices.length && <div className="empty-state">Waiting for the first ThetaData market state…</div>}
  </div>;
}

const ALL_GREEKS = Object.values(GREEK_ORDERS).flatMap(order => order.series.map(([name, color]) => [name, color]));

function aggregateGreekRows(history, state, symbol, intervalSeconds) {
  const source=[...history.filter(row=>row.symbol===symbol)];
  if(state?.symbol===symbol){const index=source.findIndex(row=>row.timestamp===state.timestamp);if(index>=0)source[index]=state;else source.push(state)}
  const unique=[...new Map(source.filter(row=>row.timestamp).map(row=>[row.timestamp,row])).values()].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const buckets=new Map();
  unique.forEach(row=>{
    const bucketMs=Math.floor(new Date(row.timestamp).getTime()/(intervalSeconds*1000))*intervalSeconds*1000;
    if(!Number.isFinite(bucketMs))return;
    const bucket=buckets.get(bucketMs)??{timestamp:new Date(bucketMs).toISOString(),symbol,count:0,sums:{}};
    bucket.count+=1;
    ALL_GREEKS.forEach(([name])=>{const value=number(row.supporting_indicators?.[`greek_${name}`],NaN);if(Number.isFinite(value))bucket.sums[name]=(bucket.sums[name]??0)+value});
    buckets.set(bucketMs,bucket);
  });
  return [...buckets.values()].map(bucket=>({timestamp:bucket.timestamp,symbol,supporting_indicators:Object.fromEntries(ALL_GREEKS.map(([name])=>[`greek_${name}`,number(bucket.sums[name])/bucket.count]))}));
}

function useGreekViewport(history,state,symbol,intervalSeconds,visibleCount=96){
  const [offset,setOffset]=useState(0);
  const rows=useMemo(()=>aggregateGreekRows(history,state,symbol,intervalSeconds),[history,state,symbol,intervalSeconds]);
  useEffect(()=>setOffset(0),[symbol,intervalSeconds]);
  const maxOffset=Math.max(0,rows.length-visibleCount),safeOffset=Math.min(offset,maxOffset),end=rows.length-safeOffset;
  const visible=rows.slice(Math.max(0,end-visibleCount),end);
  const move=amount=>setOffset(current=>Math.max(0,Math.min(maxOffset,Math.min(current,maxOffset)+amount)));
  return {rows,visible,offset:safeOffset,setOffset,move,isLive:safeOffset===0,maxOffset};
}

function ChartShell({expanded,setExpanded,children,className=""}){
  useEffect(()=>{if(!expanded)return;const previousOverflow=document.body.style.overflow;document.body.style.overflow="hidden";const close=event=>event.key==="Escape"&&setExpanded(false);window.addEventListener("keydown",close);return()=>{document.body.style.overflow=previousOverflow;window.removeEventListener("keydown",close)}},[expanded,setExpanded]);
  const chart=<div className={`expandable-chart ${expanded?"chart-expanded":""} ${className}`}>{children}</div>;
  return expanded?createPortal(chart,document.body):chart;
}

function ChartTimeControls({intervalSeconds,setIntervalSeconds,isLive,setOffset,expanded,setExpanded,zoom,onZoom}){
  const changeZoom=amount=>onZoom(amount);
  return <div className="greek-chart-controls"><div className="timeframe-buttons" aria-label="Chart aggregation interval">{CHART_INTERVALS.map(([label,seconds])=><button key={label} className={intervalSeconds===seconds?"active":""} onClick={()=>setIntervalSeconds(seconds)}>{label}</button>)}</div><div className="chart-zoom" aria-label="Coordinate zoom"><button onClick={()=>changeZoom(-.5)} disabled={zoom<=1}>−</button><span>{zoom.toFixed(1)}×</span><button onClick={()=>changeZoom(.5)} disabled={zoom>=8}>+</button></div><button className={`return-live ${isLive?"is-live":"is-back"}`} onClick={()=>setOffset(0)}>{isLive?"● LIVE":"↪ RETURN LIVE"}</button><button className="expand-chart" onClick={()=>setExpanded(!expanded)}>{expanded?"↙ MINIMIZE":"↗ EXPAND"}</button></div>;
}

function chartCursor(event,dims,rowCount,maxAbs){
  const bounds=event.currentTarget.getBoundingClientRect(),svgX=(event.clientX-bounds.left)/Math.max(bounds.width,1)*dims.width,svgY=(event.clientY-bounds.top)/Math.max(bounds.height,1)*dims.height;
  const plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom,clampedX=Math.max(dims.left,Math.min(dims.width-dims.right,svgX)),clampedY=Math.max(dims.top,Math.min(dims.height-dims.bottom,svgY));
  return {index:Math.max(0,Math.min(rowCount-1,Math.round((clampedX-dims.left)/Math.max(plotWidth,1)*Math.max(rowCount-1,0)))),value:maxAbs-(clampedY-dims.top)/Math.max(plotHeight,1)*maxAbs*2,left:(clampedX/dims.width)*100,top:(clampedY/dims.height)*100};
}

function greekSignedScale(values){
  const finite=values.filter(Number.isFinite),absolute=finite.map(Math.abs),nonZero=absolute.filter(value=>value>0).sort((a,b)=>a-b);
  const rawMax=Math.max(...absolute,1e-12),constant=Math.max(nonZero[Math.floor(nonZero.length*.2)]??rawMax,rawMax*1e-6,1e-12);
  const project=value=>Math.sign(number(value))*Math.log1p(Math.abs(number(value))/constant);
  const unproject=value=>Math.sign(number(value))*constant*Math.expm1(Math.abs(number(value)));
  const projectedMax=Math.max(project(rawMax),1);
  return {projectedMax,project,unproject};
}

const greekDash=index=>[undefined,"12 5","3 5","16 5 3 5","8 4 2 4"][index%5];

function ChartHistoryNavigator({viewport}){
  const position=viewport.maxOffset-viewport.offset;
  const step=Math.max(1,Math.round(viewport.maxOffset*.05));
  return <div className="chart-history"><button type="button" disabled={!viewport.maxOffset||viewport.offset>=viewport.maxOffset} onClick={()=>viewport.move(step)}>← OLDER</button><input type="range" min="0" max={Math.max(1,viewport.maxOffset)} value={viewport.maxOffset?position:1} disabled={!viewport.maxOffset} onChange={event=>viewport.setOffset(viewport.maxOffset-Number(event.target.value))} aria-label="Scroll through previously streamed chart data"/><button type="button" disabled={!viewport.offset} onClick={()=>viewport.move(-step)}>NEWER →</button><button type="button" className={viewport.isLive?"is-live":"is-back"} onClick={()=>viewport.setOffset(0)}>{viewport.isLive?"LIVE · NOW":"RETURN LIVE"}</button><b>{viewport.offset?`${viewport.offset} buckets back`:"Following current stream"}</b></div>;
}

function ChartCoordinateTooltip({cursor,row,series,formatTime,formatValue,seriesValue}){
  if(!cursor||!row)return null;
  return <div className="chart-coordinate-tooltip" style={{left:`${cursor.left}%`,top:`${Math.max(16,Math.min(82,cursor.top))}%`,transform:cursor.left>68?"translate(calc(-100% - 12px),-50%)":"translate(12px,-50%)"}}><b>{formatTime(row.timestamp)}</b><span>Cursor Y {formatValue(cursor.value)}</span>{series.map(([name,color])=><span key={name}><i style={{backgroundColor:color}}/>{pretty(name)} {formatValue(seriesValue(row,name))}</span>)}</div>;
}

function GreekOrderChart({ history = [], state, symbol }) {
  const [order,setOrder]=useState("first"),[intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1);
  const [cursor,setCursor]=useState(null);
  const drag=useRef(null),config=GREEK_ORDERS[order];
  const viewport=useGreekViewport(history,state,symbol,intervalSeconds,Math.max(12,Math.round((expanded?120:96)/zoom))),rows=viewport.visible;
  const dims={width:1200,height:expanded?650:300,left:92,right:30,top:20,bottom:50};
  const plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom;
  const seriesValue=(row,name)=>number(row.supporting_indicators?.[`greek_${name}`],NaN);
  const values=rows.flatMap(row=>config.series.map(([name])=>seriesValue(row,name))).filter(Number.isFinite);
  const scale=greekSignedScale(values),maxAbs=scale.projectedMax;
  const x=index=>dims.left+index*plotWidth/Math.max(1,rows.length-1);
  const y=value=>dims.top+(maxAbs-scale.project(value))*plotHeight/(maxAbs*2);
  const formatValue=value=>{const magnitude=Math.abs(number(value));return magnitude>0&&magnitude<.001?number(value).toExponential(2):number(value).toFixed(4)};
  const formatTime=value=>value?new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}):"—";
  const hovered=rows[cursor?.index??rows.length-1];
  const zoomChart=amount=>{const next=Math.max(1,Math.min(8,Math.round((zoom+amount)*2)/2));if(next===zoom)return;const fraction=rows.length>1?(cursor?.index??rows.length-1)/(rows.length-1):1,globalIndex=viewport.rows.length-viewport.offset-rows.length+(cursor?.index??rows.length-1),nextCount=Math.max(12,Math.round((expanded?120:96)/next)),nextIndex=Math.round(fraction*Math.max(nextCount-1,0)),nextOffset=Math.max(0,Math.min(Math.max(0,viewport.rows.length-nextCount),viewport.rows.length-(globalIndex-nextIndex+nextCount)));setZoom(next);viewport.setOffset(nextOffset);setCursor(current=>current?{...current,index:nextIndex}:current)};
  const onPointerMove=event=>{const next=chartCursor(event,dims,rows.length,maxAbs);setCursor({...next,value:scale.unproject(next.value)});if(drag.current){const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/7))))}};
  const onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)};
  const onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className={`greek-order-chart order-${order}`}>
    <div className="greek-chart-header"><div><span>LIVE OPTIONS GREEKS</span><h2>{symbol} · open-interest-weighted exposures</h2></div><div className="greek-header-actions"><div className="greek-order-tabs" role="tablist">{Object.entries(GREEK_ORDERS).map(([key,item])=><button role="tab" aria-selected={order===key} className={order===key?"active":""} key={key} onClick={()=>{setOrder(key);setCursor(null)}}>{item.label}</button>)}</div><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded,zoom,onZoom:zoomChart}}/></div></div>
    <div className="greek-chart-legend">{config.series.map(([name,color])=><div key={name}><i style={{backgroundColor:color}}/><span>{pretty(name)}</span><b>{formatValue(seriesValue(rows.at(-1)??{},name))}</b></div>)}</div>
    <div className="greek-chart-stage" onWheel={event=>{event.preventDefault();if(event.ctrlKey||event.metaKey)zoomChart(event.deltaY<0?.5:-.5);else viewport.move(event.deltaY>0?10:-10)}} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={()=>{drag.current=null;setCursor(null)}}>
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={`${config.label} live options Greeks over time with signed exposure on the y axis`}>
        <title>{config.label} live options Greeks for {symbol}</title><desc>The horizontal axis is observation time and the vertical axis is signed open-interest-weighted Greek exposure.</desc>
        {[0,1,2,3,4].map(tick=>{const projected=maxAbs-tick*maxAbs/2,value=scale.unproject(projected),yy=y(value);return <g key={`gy-${tick}`}><line className="greek-grid" x1={dims.left} x2={dims.width-dims.right} y1={yy} y2={yy}/><text className="greek-axis" x={dims.left-10} y={yy+4} textAnchor="end">{formatValue(value)}</text></g>})}
        {[0,1,2,3,4,5].map(tick=>{const index=Math.round(tick*Math.max(rows.length-1,0)/5),xx=x(index);return <g key={`gx-${tick}`}><line className="greek-grid" x1={xx} x2={xx} y1={dims.top} y2={dims.height-dims.bottom}/><text className="greek-axis" x={xx} y={dims.height-15} textAnchor="middle">{formatTime(rows[index]?.timestamp)}</text></g>})}
        <line className="greek-zero" x1={dims.left} x2={dims.width-dims.right} y1={y(0)} y2={y(0)}/>
        {config.series.map(([name,color],seriesIndex)=>{const path=rows.map((row,index)=>`${index?"L":"M"}${x(index).toFixed(1)},${y(seriesValue(row,name)||0).toFixed(1)}`).join(" ");return <g key={name}><path className="greek-series" d={path} style={{stroke:color,strokeDasharray:greekDash(seriesIndex)}}/>{rows.length>0&&<circle className="greek-current-dot" cx={x(rows.length-1)} cy={y(seriesValue(rows.at(-1),name)||0)} r={3.5+seriesIndex*.35} style={{fill:color}}/>}</g>})}
        {cursor&&<g><line className="greek-crosshair" x1={x(cursor.index)} x2={x(cursor.index)} y1={dims.top} y2={dims.height-dims.bottom}/><line className="greek-crosshair horizontal" x1={dims.left} x2={dims.width-dims.right} y1={y(cursor.value)} y2={y(cursor.value)}/>{config.series.map(([name,color])=><circle key={name} className="greek-hover-dot" cx={x(cursor.index)} cy={y(seriesValue(hovered,name)||0)} r="4" style={{fill:color}}/>)}</g>} 
      </svg>
      <ChartCoordinateTooltip {...{cursor,row:hovered,series:config.series,formatTime,formatValue,seriesValue}}/>
      {!rows.length&&<div className="chart-empty">Waiting for the first live Options Pro state…</div>}
    </div>
    <ChartHistoryNavigator viewport={viewport}/><div className="greek-chart-readout"><span>{viewport.isLive?"Following current stream":`${viewport.offset} buckets behind live`}</span><span>X · {formatTime(hovered?.timestamp)}</span>{config.series.map(([name,color])=><span key={name}><i style={{backgroundColor:color}}/>{pretty(name)} Y · {formatValue(seriesValue(hovered??{},name))}</span>)}</div>
  </ChartShell>;
}

function GreekPressureChart({history=[],state,symbol}){
  const [intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[hovered,setHovered]=useState(null);
  const viewport=useGreekViewport(history,state,symbol,intervalSeconds,1),row=viewport.visible.at(-1),drag=useRef(null);
  const values=ALL_GREEKS.map(([name,color])=>({name,color,value:number(row?.supporting_indicators?.[`greek_${name}`])})).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
  const maxAbs=Math.max(...values.map(item=>Math.abs(item.value)),1e-6),formatValue=value=>Math.abs(value)>0&&Math.abs(value)<.001?value.toExponential(2):value.toFixed(4);
  const onWheel=event=>{event.preventDefault();viewport.move(event.deltaY>0?1:-1)};
  const onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)};
  const onPointerMove=event=>{if(!drag.current)return;const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/24))))};
  const onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className="greek-pressure-chart"><div className="greek-chart-header"><div><span>GREEKS PRESSURE</span><h2>{symbol} · signed call/put exposure at {row?new Date(row.timestamp).toLocaleString():"—"}</h2></div><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded}}/></div><div className="pressure-axis"><span>SELL / PUT-SIGNED</span><b>0</b><span>BUY / CALL-SIGNED</span></div><div className="pressure-bars" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={()=>{drag.current=null;setHovered(null)}}>{values.map(item=><div className={`pressure-bar ${hovered===item.name?"hovered":""}`} key={item.name} onPointerEnter={()=>setHovered(item.name)}><span>{pretty(item.name)}</span><div className="pressure-track"><i className={item.value<0?"negative":"positive"} style={{width:`${Math.max(item.value===0?0:1,Math.abs(item.value)/maxAbs*50)}%`,backgroundColor:item.color}}/></div><b className={item.value<0?"neg":"pos"}>{item.value>=0?"+":""}{formatValue(item.value)}</b></div>)}</div><div className="greek-chart-readout"><span>{viewport.isLive?"Current pressure snapshot":`${viewport.offset} buckets behind live`}</span><span>Wheel or drag to inspect older streamed snapshots</span><span>Scale ±{formatValue(maxAbs)}</span></div><div className="greeks-note">Bars share one centered signed scale. Call exposure is positive and put exposure negative, weighted by open interest. This is a model inference—not observed dealer inventory.</div></ChartShell>;
}

function OverviewSectionHeading({number:sectionNumber,title,description,action}){
  return <div className="overview-section-heading"><div><span>{sectionNumber}</span><div><h2>{title}</h2><p>{description}</p></div></div>{action}</div>;
}

function GreekMultiSelect({selected,onChange}){
  const toggle=name=>onChange(selected.includes(name)?(selected.length===1?selected:selected.filter(item=>item!==name)):[...selected,name]);
  return <details className="greek-multiselect"><summary>{selected.length===ALL_GREEKS.length?"All Greeks":`${selected.length} Greek${selected.length===1?"":"s"}`} ▾</summary><div className="greek-options"><div className="greek-options-head"><span>DISPLAYED SERIES</span><button type="button" onClick={()=>onChange(ALL_GREEKS.map(([name])=>name))}>Select all</button></div>{ALL_GREEKS.map(([name,color])=><label key={name}><input type="checkbox" checked={selected.includes(name)} onChange={()=>toggle(name)}/><i style={{backgroundColor:color}}/><span>{pretty(name)}</span></label>)}<small>At least one Greek remains selected.</small></div></details>;
}

function CustomGreekChart({chart,index,history,state,symbol,onChange,onRemove,canRemove}){
  const [intervalSeconds,setIntervalSeconds]=useState(5),[expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(1),[cursor,setCursor]=useState(null);
  const drag=useRef(null),viewport=useGreekViewport(history,state,symbol,intervalSeconds,Math.max(12,Math.round((expanded?120:96)/zoom))),rows=viewport.visible;
  const series=ALL_GREEKS.filter(([name])=>chart.selected.includes(name));
  const dims={width:1200,height:expanded?650:300,left:92,right:30,top:20,bottom:50},plotWidth=dims.width-dims.left-dims.right,plotHeight=dims.height-dims.top-dims.bottom;
  const seriesValue=(row,name)=>number(row?.supporting_indicators?.[`greek_${name}`],NaN),values=rows.flatMap(row=>series.map(([name])=>seriesValue(row,name))).filter(Number.isFinite);
  const maxAbs=Math.max(...values.map(Math.abs),1e-6),x=point=>dims.left+point*plotWidth/Math.max(1,rows.length-1),y=value=>dims.top+(maxAbs-value)*plotHeight/(maxAbs*2);
  const formatValue=value=>{const magnitude=Math.abs(number(value));return magnitude>0&&magnitude<.001?number(value).toExponential(2):number(value).toFixed(4)};
  const formatTime=value=>value?new Date(value).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"}):"—",hovered=rows[cursor?.index??rows.length-1];
  const zoomChart=amount=>{const next=Math.max(1,Math.min(8,Math.round((zoom+amount)*2)/2));if(next===zoom)return;const fraction=rows.length>1?(cursor?.index??rows.length-1)/(rows.length-1):1,globalIndex=viewport.rows.length-viewport.offset-rows.length+(cursor?.index??rows.length-1),nextCount=Math.max(12,Math.round((expanded?120:96)/next)),nextIndex=Math.round(fraction*Math.max(nextCount-1,0)),nextOffset=Math.max(0,Math.min(Math.max(0,viewport.rows.length-nextCount),viewport.rows.length-(globalIndex-nextIndex+nextCount)));setZoom(next);viewport.setOffset(nextOffset);setCursor(current=>current?{...current,index:nextIndex}:current)};
  const onPointerMove=event=>{setCursor(chartCursor(event,dims,rows.length,maxAbs));if(drag.current){const delta=event.clientX-drag.current.x;if(Math.abs(delta)>3)drag.current.moved=true;viewport.setOffset(Math.max(0,Math.min(viewport.maxOffset,drag.current.offset-Math.round(delta/7))))}};
  const onPointerDown=event=>{drag.current={x:event.clientX,offset:viewport.offset,moved:false};event.currentTarget.setPointerCapture(event.pointerId)},onPointerUp=()=>{if(!expanded&&!drag.current?.moved)setExpanded(true);drag.current=null};
  return <ChartShell expanded={expanded} setExpanded={setExpanded} className="custom-greek-chart"><div className="greek-chart-header"><div><span>CUSTOM GREEK GRAPH {String(index+1).padStart(2,"0")}</span><h2>{symbol} · selected live exposures</h2></div><div className="custom-chart-actions"><GreekMultiSelect selected={chart.selected} onChange={selected=>onChange({...chart,selected})}/><ChartTimeControls {...{intervalSeconds,setIntervalSeconds,isLive:viewport.isLive,setOffset:viewport.setOffset,expanded,setExpanded,zoom,onZoom:zoomChart}}/>{canRemove&&<button className="remove-chart" onClick={onRemove}>Remove</button>}</div></div><div className="greek-chart-legend custom-live-values">{series.map(([name,color])=><div key={name}><i style={{backgroundColor:color}}/><span>{pretty(name)}</span><b>{formatValue(seriesValue(rows.at(-1),name))}</b><small>LIVE</small></div>)}</div><div className="greek-chart-stage" onWheel={event=>{event.preventDefault();if(event.ctrlKey||event.metaKey)zoomChart(event.deltaY<0?.5:-.5);else viewport.move(event.deltaY>0?10:-10)}} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={()=>{drag.current=null;setCursor(null)}}><svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={`Custom live Greek chart ${index+1} showing ${chart.selected.join(", ")}`}><title>Custom Greek graph {index+1}</title><desc>Selected open-interest-weighted Greek exposures over streamed time.</desc>{[0,1,2,3,4].map(tick=>{const value=maxAbs-tick*maxAbs/2,yy=y(value);return <g key={`gy-${tick}`}><line className="greek-grid" x1={dims.left} x2={dims.width-dims.right} y1={yy} y2={yy}/><text className="greek-axis" x={dims.left-10} y={yy+4} textAnchor="end">{formatValue(value)}</text></g>})}{[0,1,2,3,4,5].map(tick=>{const point=Math.round(tick*Math.max(rows.length-1,0)/5),xx=x(point);return <g key={`gx-${tick}`}><line className="greek-grid" x1={xx} x2={xx} y1={dims.top} y2={dims.height-dims.bottom}/><text className="greek-axis" x={xx} y={dims.height-15} textAnchor="middle">{formatTime(rows[point]?.timestamp)}</text></g>})}<line className="greek-zero" x1={dims.left} x2={dims.width-dims.right} y1={y(0)} y2={y(0)}/>{series.map(([name,color])=>{const path=rows.map((row,point)=>`${point?"L":"M"}${x(point).toFixed(1)},${y(seriesValue(row,name)||0).toFixed(1)}`).join(" ");return <g key={name}><path className="greek-series" d={path} style={{stroke:color}}/>{rows.length>0&&<circle className="greek-current-dot" cx={x(rows.length-1)} cy={y(seriesValue(rows.at(-1),name)||0)} r="3.5" style={{fill:color}}/>}</g>})}{cursor&&<g><line className="greek-crosshair" x1={x(cursor.index)} x2={x(cursor.index)} y1={dims.top} y2={dims.height-dims.bottom}/><line className="greek-crosshair horizontal" x1={dims.left} x2={dims.width-dims.right} y1={y(cursor.value)} y2={y(cursor.value)}/>{series.map(([name,color])=><circle key={name} className="greek-hover-dot" cx={x(cursor.index)} cy={y(seriesValue(hovered,name)||0)} r="4" style={{fill:color}}/>)}</g>}</svg><ChartCoordinateTooltip {...{cursor,row:hovered,series,formatTime,formatValue,seriesValue}}/>{!rows.length&&<div className="chart-empty">Waiting for live Options Pro states…</div>}</div><ChartHistoryNavigator viewport={viewport}/><div className="greek-chart-readout"><span>{viewport.isLive?"Following current stream":`${viewport.offset} buckets behind live`}</span><span>{formatTime(hovered?.timestamp)}</span>{series.map(([name,color])=><span key={name}><i style={{backgroundColor:color}}/>{pretty(name)} {formatValue(seriesValue(hovered,name))}</span>)}</div></ChartShell>;
}

function CustomGreekWorkspace({history,state,symbol}){
  const nextId=useRef(2),[charts,setCharts]=useState([{id:1,selected:["gamma","vanna","charm"]}]);
  const addChart=()=>setCharts(current=>current.length>=5?current:[...current,{id:nextId.current++,selected:["delta","gamma","vanna"]}]);
  return <section id="custom-greeks" className="custom-greek-workspace overview-section"><OverviewSectionHeading number="04" title="Build your Greek graphs" description="Select one, several, or every Greek. Each graph follows the live stream independently." action={<button className="add-greek-chart" disabled={charts.length>=5} onClick={addChart}>+ Add graph <span>{charts.length}/5</span></button>}/><div className="custom-graph-stack">{charts.map((chart,index)=><article className="panel chart-panel" key={chart.id}><CustomGreekChart {...{chart,index,history,state,symbol}} onChange={next=>setCharts(current=>current.map(item=>item.id===chart.id?next:item))} onRemove={()=>setCharts(current=>current.filter(item=>item.id!==chart.id))} canRemove={charts.length>1}/></article>)}</div></section>;
}

function StreamingPriceChart({ symbol, liveState, alert }) {
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [points, setPoints] = useState([]);
  const [offset, setOffset] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hoverIndex, setHoverIndex] = useState(null);
  const drag = useRef(null);
  const visibleCount = 84;

  const load = async (before = null) => {
    if (before && loadingOlder) return;
    if (before) setLoadingOlder(true);
    try {
      const rows = await fetchChart(symbol, intervalSeconds, before);
      setPoints(current => before
        ? [...rows, ...current].filter((row, index, all) => index === all.findIndex(item => item.timestamp === row.timestamp))
        : rows);
      if (!before) setOffset(0);
    } finally { if (before) setLoadingOlder(false); }
  };

  useEffect(() => { load(); }, [symbol, intervalSeconds]);
  useEffect(() => {
    if (!liveState || liveState.symbol !== symbol) return;
    const price = number(liveState.supporting_indicators?.price, NaN);
    if (!Number.isFinite(price)) return;
    const bucket = Math.floor(new Date(liveState.timestamp).getTime() / 1000 / intervalSeconds) * intervalSeconds * 1000;
    const timestamp = new Date(bucket).toISOString();
    setPoints(current => {
      const next = [...current];
      const last = next.at(-1);
      if (last?.timestamp === timestamp) next[next.length - 1] = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, samples: (last.samples ?? 0) + 1 };
      else next.push({ timestamp, open: price, high: price, low: price, close: price, samples: 1 });
      return next.slice(-1200);
    });
  }, [liveState, symbol, intervalSeconds]);

  const maxOffset = Math.max(0, points.length - visibleCount);
  const safeOffset = Math.min(offset, maxOffset);
  const end = points.length - safeOffset;
  const visible = points.slice(Math.max(0, end - visibleCount), end);
  const isLive = safeOffset === 0;
  const values = visible.flatMap(point => [point.low, point.high]).filter(Number.isFinite);
  const minRaw = values.length ? Math.min(...values) : 0;
  const maxRaw = values.length ? Math.max(...values) : 1;
  const padding = Math.max((maxRaw - minRaw) * .12, Math.abs(maxRaw) * .0005, .01);
  const min = minRaw - padding, max = maxRaw + padding;
  const dims = { width: 900, height: 330, left: 72, right: 20, top: 22, bottom: 42 };
  const plotWidth = dims.width - dims.left - dims.right, plotHeight = dims.height - dims.top - dims.bottom;
  const x = index => dims.left + index * plotWidth / Math.max(1, visible.length - 1);
  const y = value => dims.top + (max - value) * plotHeight / Math.max(max - min, .00001);
  const line = visible.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.close).toFixed(1)}`).join(" ");
  const priceDigits = maxRaw >= 10000 ? 0 : maxRaw >= 1000 ? 1 : 2;
  const formatPrice = value => number(value).toLocaleString(undefined, { minimumFractionDigits: priceDigits, maximumFractionDigits: priceDigits });
  const formatTime = value => new Date(value).toLocaleString([], intervalSeconds >= 86400
    ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" });

  const moveBack = amount => {
    const next = Math.max(0, Math.min(maxOffset, safeOffset + amount));
    setOffset(next);
    if (next >= maxOffset - 8 && points[0] && !loadingOlder) load(points[0].timestamp);
  };
  const onWheel = event => { event.preventDefault(); moveBack(event.deltaY > 0 ? 8 : -8); };
  const onPointerDown = event => { drag.current = { x: event.clientX, offset: safeOffset }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onPointerMove = event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.round((event.clientX - bounds.left) / bounds.width * (visible.length - 1));
    setHoverIndex(Math.max(0, Math.min(visible.length - 1, index)));
    if (drag.current) setOffset(Math.max(0, Math.min(maxOffset, drag.current.offset + Math.round((event.clientX - drag.current.x) / 7))));
  };
  const hovered = visible[hoverIndex ?? visible.length - 1];
  const alertIndex = alert ? visible.findIndex(point => new Date(point.timestamp) >= new Date(alert.timestamp)) : -1;

  return <div className="stream-chart">
    <div className="stream-chart-toolbar">
      <div><span className="chart-kicker">PRICE CONFIRMATION</span><h2>{symbol} streamed price</h2></div>
      <div className="chart-actions"><div className="timeframe-buttons">{CHART_INTERVALS.map(([label, seconds]) => <button key={label} className={intervalSeconds === seconds ? "active" : ""} onClick={() => setIntervalSeconds(seconds)}>{label}</button>)}</div><button className={`return-live ${isLive ? "is-live" : "is-back"}`} onClick={() => setOffset(0)}>{isLive ? "● LIVE" : "↪ RETURN LIVE"}</button></div>
    </div>
    <div className="stream-chart-stage" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; setHoverIndex(null); }}>
      <svg viewBox={`0 0 ${dims.width} ${dims.height}`} role="img" aria-label={`${symbol} price confirmation chart with time and price axes`}>
        {[0,1,2,3,4].map(tick => { const value = max - tick * (max - min) / 4, yy = y(value); return <g key={`y-${tick}`}><line className="chart-grid" x1={dims.left} y1={yy} x2={dims.width-dims.right} y2={yy}/><text className="chart-axis" x={dims.left-10} y={yy+4} textAnchor="end">{formatPrice(value)}</text></g>; })}
        {[0,1,2,3,4,5].map(tick => { const index = Math.round(tick * Math.max(0,visible.length-1) / 5), xx = x(index); return <g key={`x-${tick}`}><line className="chart-grid" x1={xx} y1={dims.top} x2={xx} y2={dims.height-dims.bottom}/><text className="chart-axis" x={xx} y={dims.height-14} textAnchor="middle">{visible[index] ? formatTime(visible[index].timestamp) : "—"}</text></g>; })}
        <path className="price-line-svg" d={line}/>
        {visible.length > 0 && <circle className="current-price-dot" cx={x(visible.length-1)} cy={y(visible.at(-1).close)} r="5"/>}
        {alertIndex >= 0 && <path className="alert-marker" transform={`translate(${x(alertIndex)} ${y(visible[alertIndex].close)-10})`} d="M0,-8 L7,5 L-7,5 Z"/>}
        {hovered && <g><line className="crosshair" x1={x(hoverIndex ?? visible.length-1)} x2={x(hoverIndex ?? visible.length-1)} y1={dims.top} y2={dims.height-dims.bottom}/><circle className="hover-dot" cx={x(hoverIndex ?? visible.length-1)} cy={y(hovered.close)} r="4"/></g>}
      </svg>
      {!points.length && <div className="chart-empty">Waiting for persisted streamed prices…</div>}
    </div>
    <div className="chart-readout"><span>{isLive ? "Following current stream" : `${safeOffset} bars behind live — click RETURN LIVE to catch up`}</span><span>{hovered ? `${formatTime(hovered.timestamp)} · O ${formatPrice(hovered.open)} H ${formatPrice(hovered.high)} L ${formatPrice(hovered.low)} C ${formatPrice(hovered.close)}` : "No price data"}</span></div>
  </div>;
}

function PriorityAlert({ alert, state, symbol }) {
  const decision=deriveOptionsDecision(state),failed=decision.failed;
  if (!decision.qualified) return <article className="priority-alert waiting-alert">
    <div><span className="alert-label">OPTIONS-PRESSURE BIAS</span><h2>{symbol} · WAIT</h2><p>{failed.length ? `Waiting for ${failed.join(", ")} to pass.` : "The engine is warming up its options-chain history."} No price confirmation is claimed.</p></div>
    <div className="watch-levels bias-levels"><div><span>EXPLOSION</span><b>{number(state?.explosion?.value).toFixed(2)}</b></div><div><span>DIRECTION</span><b>{number(state?.direction?.value)>0?"+":""}{number(state?.direction?.value).toFixed(0)}</b></div><div><span>PRESSURE</span><b>{number(state?.pressure?.value)>0?"+":""}{number(state?.pressure?.value).toFixed(2)}</b></div></div>
  </article>;
  const direction = decision.direction;
  const side = biasLabel(direction);
  return <article className={`priority-alert ${direction === "UP" ? "long-alert" : "short-alert"}`}>
    <div><div className="alert-heading"><span className="alert-label">OPTIONS-PRESSURE BIAS · MANUAL PRICE CONFIRMATION REQUIRED</span><span className="alert-confidence">{pct(decision.optionsConfidence)}</span></div><h2>{symbol} · {side} BIAS</h2><p>{state?.explosion?.explanation} {state?.direction?.explanation} {state?.pressure?.explanation}</p><small>{time(state?.timestamp)} · {pretty(state?.profile)} · Options Pro inputs only · not an entry signal</small></div>
    <div className="alert-levels bias-levels"><div><span>BIAS</span><b>{side}</b></div><div><span>EXPLOSION</span><b>{number(state?.explosion?.value).toFixed(2)}</b></div><div><span>PRESSURE</span><b>{number(state?.pressure?.value)>0?"+":""}{number(state?.pressure?.value).toFixed(2)}</b></div><div><span>DIRECTION</span><b>{number(state?.direction?.value)>0?"+":""}{number(state?.direction?.value).toFixed(0)} / 3</b></div></div>
  </article>;
}

function FocusView({state,symbol,engine,decision,lastQualifiedAlert}) {
  const tone=decision.qualified?(decision.direction==="UP"?"long":"short"):"neutral";
  const label=decision.qualified?biasLabel(decision.direction):"NEUTRAL";
  const directionThreshold=number(state?.active_thresholds?.direction_min,2);
  const metrics=[
    ["Explosion",number(state?.explosion?.value).toFixed(2),`Ideal ≥ ${number(decision.thresholds?.explosion,.58).toFixed(2)}`],
    ["Direction",`${number(state?.direction?.value)>0?"+":""}${number(state?.direction?.value).toFixed(0)} / 3`,`Ideal |score| ≥ ${directionThreshold.toFixed(0)}`],
    ["Pressure",`${number(state?.pressure?.value)>0?"+":""}${number(state?.pressure?.value).toFixed(2)}`,`Ideal aligned ≥ ${number(decision.thresholds?.pressure,.15).toFixed(2)}`],
    ["Options confidence",pct(decision.optionsConfidence),`Ideal ≥ ${pct(decision.thresholds?.confidence,.68)}`],
    ["Risk",pct(state?.risk?.value),`Ideal < ${pct(decision.thresholds?.risk,.88)}`],
    ["Dealer hedge",`${number(state?.dealer_hedging?.value)>0?"+":""}${number(state?.dealer_hedging?.value).toFixed(2)}`,"Context only"],
    ["Momentum",`${number(state?.momentum?.value)>0?"+":""}${number(state?.momentum?.value).toFixed(2)}`,"Not a bias gate"],
  ];
  return <section id="decision" className={`focus-view focus-view-${tone} overview-section`} aria-live="polite">
    <div className="focus-heading"><div><span>ONE-SCREEN OPTIONS FOCUS</span><h2>{symbol} · {label}</h2><small>{engine.running?"● LIVE OPTIONS PRO":"○ ENGINE IDLE"} · {time(state?.timestamp)} · {pretty(state?.regime??"waiting")}</small></div><div className="focus-alert"><span>{decision.qualified?"ACTIVE PRESSURE ALERT":"NO QUALIFIED ALERT"}</span><b>{decision.qualified?`${label} BIAS`:`WAITING · ${decision.failed.join(", ")||"live history"}`}</b><small>Manual price confirmation remains external</small></div></div>
    <div className={`last-qualified-bias ${lastQualifiedAlert?"has-alert":"no-alert"}`}><div><span>LAST QUALIFIED BIAS</span><b>{lastQualifiedAlert?`${lastQualifiedAlert.symbol} · ${biasLabel(lastQualifiedAlert.direction)}`:"NONE RECORDED"}</b></div>{lastQualifiedAlert?<><div><span>QUALIFIED AT</span><b>{new Date(lastQualifiedAlert.timestamp).toLocaleString()}</b></div><div><span>GATES AT EVENT</span><b>EXP {lastQualifiedAlert.explosion} · DIR {lastQualifiedAlert.score} · PRESSURE {lastQualifiedAlert.pressure>=0?"+":""}{number(lastQualifiedAlert.pressure).toFixed(2)}</b></div><div><span>OPTIONS CONFIDENCE</span><b>{pct(lastQualifiedAlert.confidence)}</b></div></>:<small>A historical LONG or SHORT appears here after all five gates pass together.</small>}</div>
    <div className="focus-score-grid">{metrics.map(([name,value,ideal])=><div className="focus-score" key={name}><span>{name}</span><b>{value}</b><small>{ideal}</small></div>)}</div>
  </section>;
}

function FiveMinuteForecast({history,state,symbol}){
  const forecast=useMemo(()=>deriveFiveMinuteForecast(history,state),[history,state]),tone=!forecast.ready||forecast.label==="WAIT"?"wait":forecast.label.toLowerCase(),probabilities=forecast.probabilities??{UP:0,DOWN:0,WAIT:1};
  return <article className={`move-forecast forecast-${tone}`}><div><span>EXPERIMENTAL 5-MINUTE / 30-POINT FORECAST</span><h2>{symbol} · {forecast.ready?forecast.label:"WAIT"}</h2><small>{forecast.reason}</small></div><div className="forecast-probabilities"><span>UP ≥ +30<b>{pct(probabilities.UP)}</b></span><span>WAIT<b>{pct(probabilities.WAIT)}</b></span><span>DOWN ≤ −30<b>{pct(probabilities.DOWN)}</b></span></div><div className="forecast-levels"><span>Current<b>{Number.isFinite(forecast.price)?forecast.price.toFixed(2):"—"}</b></span><span>Up level<b>{Number.isFinite(forecast.price)?(forecast.price+30).toFixed(2):"—"}</b></span><span>Down level<b>{Number.isFinite(forecast.price)?(forecast.price-30).toFixed(2):"—"}</b></span><small>{forecast.samples} labeled states · {forecast.eventCount} observed 30-point events{forecast.neighbors?` · ${forecast.neighbors} nearest analogs`:""}</small></div></article>;
}

function ExplosionCard({ state, history }) {
  const score = state?.explosion;
  const weights = score?.configuration?.weights ?? {};
  const drivers = Object.entries(score?.components ?? {}).map(([name,value]) => ({ name, intensity:number(value), contribution:number(value)*number(weights[name]) })).sort((a,b)=>b.contribution-a.contribution).slice(0,4);
  const threshold = number(state?.active_thresholds?.explosion_min,.58);
  return <article className="metric score-explainer"><header><span>EXPLOSION SCORE</span><span className={`badge ${number(score?.value) >= threshold && threshold ? "hot" : "subtle"}`}>{number(score?.value) >= threshold && threshold ? "ABOVE THRESHOLD" : "BUILDING"}</span></header><div className="score-summary"><b>{number(score?.value).toFixed(2)}</b><div><strong>{number(score?.value) >= .75 ? "High energy" : number(score?.value) >= .5 ? "Elevated energy" : "Low energy"}</strong><span>Threshold {threshold.toFixed(2)} · confidence {pct(score?.confidence)}</span><em className="ideal-score">IDEAL ALERT SCORE ≥ {threshold.toFixed(2)}</em></div></div><div className="score-drivers">{drivers.map(driver=><div className="score-driver" key={driver.name}><span>{pretty(driver.name)}</span><i><em style={{width:`${Math.min(100,driver.intensity*100)}%`}}/></i><b>+{driver.contribution.toFixed(2)}</b></div>)}</div><p className="score-why"><b>Why:</b> {score?.explanation ?? "Waiting for enough live bars to establish a robust rolling baseline."}</p><Sparkline values={history.map(item=>number(item.explosion?.value))}/></article>;
}

function DirectionCard({ state }) {
  const score = state?.direction;
  const votes = ["gamma","vanna","charm"].map(name=>{const value=number(score?.inputs?.[name]);return {name,value,vote:value>0?1:value<0?-1:0};});
  const value = number(score?.value);
  const threshold=number(state?.active_thresholds?.direction_min,2);
  return <article className="metric score-explainer direction-explainer"><header><span>DIRECTION SCORE</span><span className={`badge ${value>0?"up":value<0?"down":"subtle"}`}>{value>0?"BULLISH":value<0?"BEARISH":"NEUTRAL"}</span></header><div className="score-summary"><b className={value>0?"teal":value<0?"red":""}>{value>0?"+":""}{value.toFixed(0)} / 3</b><div><strong>{Math.abs(value)===3?"Fully aligned":Math.abs(value)===2?"Strong lean":Math.abs(value)===1?"Mixed lean":"No direction"}</strong><span>{pct(score?.confidence)} clarity</span><em className="ideal-score">IDEAL ALERT SCORE ≥ +{threshold.toFixed(0)} OR ≤ −{threshold.toFixed(0)}</em></div></div><div className="direction-votes">{votes.map(item=><div className={`direction-vote ${item.vote>0?"up":item.vote<0?"down":"neutral"}`} key={item.name}><span>{pretty(item.name)} vote</span><b>{item.vote>0?"+1 · Bullish":item.vote<0?"−1 · Bearish":"0 · Neutral"}</b><small>Raw exposure {item.value>=0?"+":""}{item.value.toFixed(4)}</small></div>)}</div><p className="score-why"><b>Why:</b> {score?.explanation ?? "Waiting for Gamma, Vanna, and Charm observations."} Direction must align with signed options pressure before a bias alert is active.</p></article>;
}

function PageHead({ eyebrow, title, subtitle, action }) {
  return <div className="page-head module-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function ModulePage({ view, state, history, alerts, performance, system, config, replay, onReplay, notify }) {
  const [query, setQuery] = useState("");
  const indicators = state?.supporting_indicators ?? {};
  const engine = system?.engine ?? {};
  if (view === "Live Monitor") return <>
    <PageHead eyebrow="STREAMING DESK" title="Live pressure monitor" subtitle="Every panel below is driven by the latest persisted market state." action={<span className={`health-banner ${engine.last_error ? "error" : ""}`}>● {engine.running ? "LIVE" : "IDLE"}</span>} />
    <div className="monitor-grid">
      <article className="panel monitor-chart"><header className="panel-head"><div><span>PRESSURE WATERFALL</span><h2>{state?.symbol ?? "—"} · {time(state?.timestamp)}</h2></div><span className="live-chip">● {engine.average_latency_ms?.toFixed?.(1) ?? "—"} ms</span></header><PriceChart history={history}/><div className="timeframe-row">{Object.entries(state?.timeframe_alignment ?? {}).map(([key, value]) => <div key={key}><span>{key}s</span><i style={{height:`${24 + Math.abs(number(value))*38}px`}}/><b>{number(value) >= 0 ? "↑" : "↓"}</b></div>)}</div></article>
      <article className="panel gauge-panel"><header className="panel-head"><div><span>DEALER HEDGE DEMAND</span><h2>Signed pressure</h2></div></header><div className="big-gauge"><div><b>{number(state?.dealer_hedging?.value).toFixed(2)}</b><span>{number(state?.dealer_hedging?.value) >= 0 ? "BUY PRESSURE" : "SELL PRESSURE"}</span></div></div><div className="signal-stack">{["gamma","charm","vanna"].map(name => <span key={name}><b>{pretty(name)}</b><i style={{width:`${Math.min(100,Math.abs(number(indicators[`greek_${name}`]))*900)}%`}}/></span>)}</div></article>
      <article className="panel feed-panel"><header className="panel-head"><div><span>SYSTEM TIMELINE</span><h2>Live engine events</h2></div></header>{(system?.events ?? []).slice(0,6).map((event,i) => <div className="timeline-event" key={`${event.timestamp}-${i}`}><i className={event.level === "ERROR" ? "hot-event" : ""}/><span>{time(event.timestamp)}</span><b>{event.message}</b></div>)}{!(system?.events?.length) && <div className="empty-state">No engine errors recorded.</div>}</article>
    </div></>;

  if (view === "Historical Replay") return <>
    <PageHead eyebrow="RESEARCH REPLAY" title="Historical replay" subtitle="Run real Options Pro history through the same production pipeline." action={<button className="primary-action" onClick={onReplay} disabled={replay?.status === "running"}>Run replay</button>} />
    <article className="panel replay-stage"><div className="replay-toolbar"><span>QQQ · previous market session · 09:30—16:00 ET</span><b>{replay?.status?.toUpperCase?.() ?? "READY"}</b></div><PriceChart history={history}/></article>
    <div className="metric-grid replay-metrics"><article className="metric"><header><span>BARS PROCESSED</span></header><div className="metric-main"><b>{replay?.bars ?? 0}</b></div></article><article className="metric"><header><span>ALERTS GENERATED</span></header><div className="metric-main"><b>{replay?.alerts ?? 0}</b></div></article><article className="metric"><header><span>PIPELINE LATENCY</span></header><div className="metric-main"><b>{number(replay?.average_pipeline_latency_ms).toFixed(2)} ms</b></div></article><article className="metric"><header><span>STATUS</span></header><div className="metric-main"><b className={replay?.status === "failed" ? "red" : "teal"}>{replay?.status ?? "ready"}</b></div><footer><span>{replay?.error ?? "Chronological; same decision path"}</span></footer></article></div></>;

  if (view === "Performance") {
    const regimes = Object.entries(performance?.by_regime ?? {});
    return <><PageHead eyebrow="META ENGINE" title="Performance analytics" subtitle="Counts and evaluated precision read directly from Supabase." />
      <div className="performance-grid"><article className="panel precision-card"><header className="panel-head"><div><span>EVALUATED PRECISION</span><h2>Outcome quality</h2></div></header><div className="uplift"><b>{pct(performance?.precision)}</b><span>{performance?.evaluated_alerts ?? 0} evaluated alerts</span></div><Sparkline values={history.map(x => number(x.confidence?.value))} color="#86a7ff"/></article><article className="panel confusion"><header className="panel-head"><div><span>ALERT FLOW</span><h2>Production channels</h2></div></header><div className="matrix"><div className="strong"><b>{performance?.live_alerts ?? 0}</b><span>Live</span></div><div><b>{performance?.historical_alerts ?? 0}</b><span>Replay</span></div><div><b>{performance?.pending_alerts ?? 0}</b><span>Pending</span></div><div className="strong"><b>{performance?.total_alerts ?? 0}</b><span>Total</span></div></div></article><article className="panel segment-card"><header className="panel-head"><div><span>ALERTS BY REGIME</span><h2>Market context</h2></div></header>{regimes.map(([name,count]) => <div className="segment" key={name}><span>{pretty(name)}</span><i><b style={{width:`${Math.min(100,100*count/Math.max(1,performance.total_alerts))}%`}}/></i><strong>{count}</strong></div>)}{!regimes.length && <div className="empty-state">No alerts generated yet.</div>}</article></div></>;
  }

  if (view === "Logbook") return <><PageHead eyebrow="AUDIT TRAIL" title="Options bias logbook" subtitle="Search live and replay pressure-bias events stored in Supabase." /><div className="searchbar"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search symbol, regime, reasoning, or risk…"/></div><article className="panel logbook-list">{alerts.filter(a => JSON.stringify(a).toLowerCase().includes(query.toLowerCase())).map(a => <details key={a.id}><summary><span>{a.time}</span><b>{a.symbol}</b><span className={`direction-pill ${a.direction.toLowerCase()}`}>{biasLabel(a.direction)}</span><span>{a.regime}</span><span>Explosion {a.explosion}</span><span className="result pending">{a.result}</span><strong>{a.precision}</strong></summary><div className="reasoning-grid"><div><small>PRESSURE THESIS</small>{a.reasoning.map(reason=><p key={reason}>{reason}</p>)}</div><div><small>MANUAL CONFIRMATION</small><p>{a.recommendation}</p></div><div><small>RISK</small><p>{a.risk}</p></div></div></details>)}{!alerts.length && <div className="empty-state">No options-pressure bias has crossed every threshold.</div>}</article></>;

  if (view === "Configuration") return <><PageHead eyebrow="ACTIVE CONTROL" title={`Configuration ${config?.version ?? "—"}`} subtitle="Validated strategy currently loaded by the backend." action={<span className="health-banner">READ ONLY · DEPLOYED YAML</span>} /><div className="config-grid"><article className="panel version-list"><header className="panel-head"><div><span>PROFILES</span><h2>Session policies</h2></div></header>{Object.keys(config?.profiles ?? {}).map((name,i)=><button className={i===0?"selected":""} key={name}><b>{pretty(name)}</b><span>Active policy</span></button>)}</article><article className="panel config-editor"><header className="panel-head"><div><span>NORMAL SESSION</span><h2>Alert thresholds</h2></div></header>{Object.entries(config?.profiles?.NORMAL_SESSION ?? {}).filter(([,v])=>typeof v==="number").map(([name,value])=><label className="config-control" key={name}><span>{pretty(name)}<small>Loaded from strategy.yaml</small></span><input type="range" value={Math.min(100,number(value)*100)} readOnly/><b>{number(value).toFixed(2)}</b></label>)}</article></div></>;

  if (view === "Research Lab") return <><PageHead eyebrow="MODEL INSPECTION" title="Research lab" subtitle="Current formula weights and the latest real replay result." action={<button className="primary-action" onClick={onReplay}>Run experiment replay</button>} /><div className="research-grid"><article className="panel formula-panel"><header className="panel-head"><div><span>EXPLOSION FORMULA</span><h2>Production weights</h2></div></header><pre><code>{`energy = Σ robust_z(|greek|) × weight\nacceleration = tanh(curvature_ratio - 1)\nscore = clamp(energy + 0.08 × acceleration)`}</code></pre><div className="weight-grid">{Object.entries(config?.score_weights?.explosion ?? {}).map(([name,value])=><span key={name}>{pretty(name)} {pct(value)}</span>)}</div></article><article className="panel experiment-result"><header className="panel-head"><div><span>LATEST REPLAY</span><h2>Observed result</h2></div></header><div className="uplift"><b>{replay?.alerts ?? 0}</b><span>alerts from {replay?.bars ?? 0} bars</span></div><Sparkline values={history.map(x=>number(x.explosion?.value))}/><div className="experiment-stats"><span>Status <b>{replay?.status ?? "not run"}</b></span><span>Latency <b>{number(replay?.average_pipeline_latency_ms).toFixed(2)} ms</b></span></div></article></div></>;

  return <><PageHead eyebrow="PLATFORM OPERATIONS" title="System monitoring" subtitle="Live health from Render, Supabase, ThetaData, and the decision engine." action={<span className={`health-banner ${system?.database_connected ? "" : "error"}`}>● {system?.database_connected ? "DATABASE CONNECTED" : "DEGRADED"}</span>} /><div className="health-grid">{[["PostgreSQL",system?.database_connected?"Connected":"Down"],["Theta transport",system?.theta_transport??"—"],["Live engine",engine.running?"Running":"Idle"],["Bars processed",engine.bars_processed??0],["Alerts",engine.alerts_generated??0],["Retries",engine.retries??0]].map(([name,value])=><article className="panel health-card" key={name}><span>{name}</span><b>{value}</b><i><em style={{width:system?.database_connected?"100%":"20%"}}/></i><small>{engine.last_error && name==="Live engine"?engine.last_error:"Real backend telemetry"}</small></article>)}</div></>;
}

export default function Home() {
  const [view,setView]=useState("Overview"), [symbol,setSymbol]=useState("QQQ"), [resolution,setResolution]=useState(5);
  const [dashboard,setDashboard]=useState({history:[],alerts:[],engine:{},performance:{}}), [system,setSystem]=useState(null), [config,setConfig]=useState(null);
  const [chartHistory,setChartHistory]=useState([]);
  const [connected,setConnected]=useState(false), [toast,setToast]=useState(""), [replay,setReplay]=useState(null);
  const [instruments,setInstruments]=useState(FALLBACK_INSTRUMENTS);
  const state=dashboard.state, history=dashboard.history??[], alerts=dashboard.alerts??[], engine=dashboard.engine??{}, performance=dashboard.performance??{};
  const notify=text=>{setToast(text);window.setTimeout(()=>setToast(""),2600)};
  const refresh=async(signal)=>{try{const [dash,sys,cfg]=await Promise.all([fetchDashboard(symbol,signal),fetchSystem(signal),fetchConfiguration(signal)]);setDashboard(dash);setSystem(sys);setConfig(cfg);setConnected(true)}catch(error){if(error.name!=="AbortError"){setConnected(false);notify(error.message)}}};
  useEffect(()=>{const controller=new AbortController();refresh(controller.signal);const id=window.setInterval(()=>refresh(controller.signal),10000);return()=>{controller.abort();clearInterval(id)}},[symbol]);
  useEffect(()=>{const controller=new AbortController();fetchStateHistory(symbol,5000,controller.signal).then(rows=>setChartHistory([...rows].reverse())).catch(error=>{if(error.name!=="AbortError")setChartHistory([])});return()=>controller.abort()},[symbol]);
  useEffect(()=>{const controller=new AbortController();fetchInstruments(controller.signal).then(setInstruments).catch(()=>{});return()=>controller.abort()},[]);
  useEffect(()=>subscribeToEvents(message=>{if(message.topic==="market_state"){setDashboard(current=>({...current,state:message.payload,history:[...(current.history??[]),message.payload].slice(-120)}));setChartHistory(current=>[...current.filter(row=>row.timestamp!==message.payload.timestamp),message.payload].slice(-5000))}if(message.topic==="alert")setDashboard(current=>({...current,alerts:[toDashboardAlert(message.payload),...(current.alerts??[])].slice(0,100)}));if(message.topic==="outcome")setDashboard(current=>({...current,alerts:(current.alerts??[]).map(alert=>alert.id===message.payload.alert_id?{...alert,result:number(message.payload.precision)>=.7?"SUCCESS":"FAILURE",precision:number(message.payload.precision).toFixed(2)}:alert)}));if(message.topic==="engine_status"){setDashboard(current=>({...current,engine:message.payload}));setSystem(current=>current?{...current,engine:message.payload}:current)}if(message.topic==="system_event")setSystem(current=>current?{...current,events:[message.payload,...(current.events??[])].slice(0,25)}:current);if(message.topic==="replay_status")setReplay(message.payload)},setConnected),[]);
  useEffect(()=>{if(!replay?.id||replay.status!=="running")return;const id=setInterval(()=>fetchReplay(replay.id).then(setReplay).catch(()=>{}),2000);return()=>clearInterval(id)},[replay?.id,replay?.status]);
  const toggle=async()=>{try{if(engine.running){await stopLiveEngine();notify("Live engine stopping")}else{await startLiveEngine(symbol,resolution);notify(`Live engine started for ${symbol}`)}await refresh()}catch(error){notify(error.message)}};
  const runReplay=async()=>{try{const day=new Date();day.setDate(day.getDate()-1);while(day.getDay()===0||day.getDay()===6)day.setDate(day.getDate()-1);const date=day.toISOString().slice(0,10);setReplay(await startReplay({symbol,start:new Date(`${date}T09:30:00`).toISOString(),end:new Date(`${date}T16:00:00`).toISOString(),bar_resolution_seconds:60,replay_speed:0}));notify("Historical replay started")}catch(error){notify(error.message)}};
  const indicators=state?.supporting_indicators??{}, visualHistory=chartHistory.length?chartHistory:history;
  const liveBiasAlerts=alerts.filter(alert=>alert.channel==="LIVE");
  const lastQualifiedAlert=liveBiasAlerts.filter(alert=>alert.symbol===symbol).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0]??null;
  const selectedInstrument=instruments.find(item=>item.symbol===symbol)??FALLBACK_INSTRUMENTS.find(item=>item.symbol===symbol);
  const optionsDecision=deriveOptionsDecision(state);
  const focusTone=optionsDecision.qualified?(optionsDecision.direction==="UP"?"long":"short"):"neutral";
  const jumpTo=section=>{setView("Overview");window.requestAnimationFrame(()=>window.requestAnimationFrame(()=>document.getElementById(section)?.scrollIntoView({behavior:"smooth",block:"start"})))};
  return <main className={`workspace focus-${focusTone}`}><header className="topbar"><div className="brand"><div className="brandmark"><span/><span/><span/></div><div><b>AXIOM</b><small>PRESSURE INTELLIGENCE</small></div></div><nav className="mode-switch"><button className={view!=="Historical Replay"?"active":""} onClick={()=>setView("Overview")}>Live engine</button><button className={view==="Historical Replay"?"active":""} onClick={()=>setView("Historical Replay")}>Training replay</button></nav><div className="header-actions"><div className="feed"><i className={connected?"pulse":""}/><span>API</span><b>{connected?"CONNECTED":"OFFLINE"}</b><small>{engine.running?"STREAMING":"IDLE"}</small></div></div></header>
    <aside className="sidebar"><div className="side-top"><button className="navitem active" onClick={()=>jumpTo("decision")}><span className="icon">◫</span><span>Overview</span></button><nav className="overview-subnav" aria-label="Overview sections">{OVERVIEW_SECTIONS.map(([label,section])=><button key={section} onClick={()=>jumpTo(section)}><i/><span>{label}</span></button>)}</nav></div><div className="side-bottom"><div className="system-health"><span><i/>{system?.database_connected?"System healthy":"System degraded"}</span><small>v{config?.version??"—"} · Render</small></div></div></aside>
    <section className="content">{view!=="Overview"?<ModulePage {...{view,state,history,alerts,performance,system,config,replay,onReplay:runReplay,notify}}/>:<><div id="overview-top" className="page-head overview-section"><div><div className="eyebrow">TRADING COMMAND</div><h1>Pressure intelligence</h1><p>Options Pro pressure bias. You confirm price independently.</p></div><div className="controls"><label>Instrument<select value={symbol} disabled={engine.running} onChange={e=>setSymbol(e.target.value)}>{instruments.map(item=><option value={item.symbol} key={item.symbol}>{item.symbol}</option>)}</select><small className={selectedInstrument?.available?"provider-ready":"provider-missing"}>{selectedInstrument?.provider}{selectedInstrument?.requirement?` · ${selectedInstrument.requirement}`:""}</small></label><label>Feed resolution<select value={resolution} onChange={e=>setResolution(Number(e.target.value))}><option value="5">5s</option><option value="15">15s</option><option value="60">1m</option></select></label><button className={engine.running?"stop":"start"} disabled={!engine.running&&!selectedInstrument?.available} onClick={toggle}><i/>{engine.running?"Stop engine":selectedInstrument?.available?"Start engine":"Feed required"}</button></div></div>
    <OverviewSectionHeading number="01" title="One-screen focus" description="The complete options-pressure decision and every active gate in one view."/>
    <FocusView state={state} symbol={symbol} engine={engine} decision={optionsDecision} lastQualifiedAlert={lastQualifiedAlert}/>
    <FiveMinuteForecast history={visualHistory} state={state} symbol={symbol}/>
    <section id="score-modules" className="overview-section"><OverviewSectionHeading number="02" title="Signal scores" description="Explosion, Direction, and Pressure aligned in one viewport row."/><div className="metric-grid live-metric-grid score-three"><ExplosionCard state={state} history={history}/><DirectionCard state={state}/><article className={`metric pressure-card ${number(state?.pressure?.value)>0.15?"pressure-buy":number(state?.pressure?.value)<-0.15?"pressure-sell":"pressure-watch"}`}><header><span>PRESSURE STATE</span><span className="pressure-live-badge">● {engine.running?"LIVE":"IDLE"}</span></header><div className="pressure-state"><i/><div><b>{number(state?.pressure?.value)>0.15?"BUY PRESSURE":number(state?.pressure?.value)<-0.15?"SELL PRESSURE":"BUILDING"}</b><span>{state?.pressure?.explanation??"Waiting for ThetaData"}</span></div></div><div className="pressure-confirmations"><span className={optionsDecision.checks.pressure_alignment?"confirmed":"waiting"}>Bias {optionsDecision.checks.pressure_alignment?"aligned":"waiting"}</span><span className={optionsDecision.checks.risk?"confirmed":"blocked"}>Risk {optionsDecision.checks.risk?"clear":"blocked"}</span></div><footer><span>Signed pressure</span><b>{number(state?.pressure?.value).toFixed(2)}</b></footer></article></div></section>
    <section id="greek-orders" className="overview-section"><OverviewSectionHeading number="03" title="Greek orders" description="Pink first-order, sky-blue second-order, and lime-green third-order live exposures."/><article className="panel chart-panel"><GreekOrderChart history={visualHistory} state={state} symbol={symbol}/></article></section>
    <CustomGreekWorkspace history={visualHistory} state={state} symbol={symbol}/>
    <section id="live-alerts" className="overview-section"><OverviewSectionHeading number="05" title="Live Options Pro bias alerts" description="Qualified Explosion, Direction, Pressure, Confidence, and Risk events."/><article className="panel alerts-panel"><header className="panel-head table-head"><div><span>LIVE OPTIONS PRO BIAS ALERTS</span><h2>Options-pressure decisions only</h2></div></header><div className="table-wrap"><table><thead><tr><th>TIME</th><th>INSTRUMENT</th><th>BIAS</th><th>EXPLOSION</th><th>DIR. SCORE</th><th>PRESSURE</th><th>OPTIONS CONF.</th><th>REGIME</th><th>RISK</th></tr></thead><tbody>{liveBiasAlerts.map(a=><tr key={a.id}><td>{a.time}</td><td><b>{a.symbol}</b></td><td><span className={`direction-pill ${a.direction.toLowerCase()}`}>{biasLabel(a.direction)}</span></td><td>{a.explosion}</td><td>{a.score}</td><td>{a.pressure>0?"+":""}{number(a.pressure).toFixed(2)}</td><td>{pct(a.confidence)}</td><td>{a.regime}</td><td>{pretty(a.risk)}</td></tr>)}</tbody></table>{!liveBiasAlerts.length&&<div className="empty-state">WAIT · no live Options Pro bias has crossed every pressure threshold yet.</div>}</div></article></section></>}
    <footer className="disclaimer">Signal intelligence only · No broker execution enabled <span>Last persisted state {time(state?.timestamp)}</span></footer></section>{toast&&<div className="toast">✓ {toast}</div>}</main>;
}
