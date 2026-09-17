import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWallPriceSeries } from "./api";
import { averagePriceBars, charmPhase, computePriceCharmander } from "./priceCharmander";

const RANGE_CONFIG = {
  "5M": { seconds: 300, bucket: 10 },
  "15M": { seconds: 900, bucket: 15 },
  "30M": { seconds: 1800, bucket: 30 },
  "1H": { seconds: 3600, bucket: 60 },
  "4H": { seconds: 14400, bucket: 240 },
  "6H": { seconds: 21600, bucket: 360 },
  "8H": { seconds: 28800, bucket: 480 },
};
const COLORS = {
  positive_rising: "#43d35d",
  positive_falling: "#ff9f0a",
  negative_falling: "#ff4f5f",
  negative_rising: "#269dff",
  neutral: "#657887",
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const timeLabel = timestamp => new Date(timestamp).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

export default function PriceCharmanderChart({ rows = [], symbol = "QQQ" }) {
  const [range, setRange] = useState("5M");
  const [visualShift, setVisualShift] = useState(false);
  const [view, setView] = useState({ start: 0, end: 1 });
  const [historyRows, setHistoryRows] = useState([]);
  const [historyState, setHistoryState] = useState("loading");
  const [size, setSize] = useState({ width: 1200, height: 610 });
  const [hover, setHover] = useState(null);
  const canvasRef = useRef(null), frameRef = useRef(null);
  const config = RANGE_CONFIG[range];
  useEffect(() => {
    const controller = new AbortController();
    setHistoryState("loading");
    fetchWallPriceSeries(symbol, config.seconds, config.bucket, controller.signal)
      .then(result => { setHistoryRows(result.rows || []); setHistoryState("ready"); })
      .catch(error => { if (error.name !== "AbortError") { setHistoryRows([]); setHistoryState("live-only"); } });
    return () => controller.abort();
  }, [config.bucket, config.seconds, symbol]);
  const analysisBars = useMemo(() => {
    const normalized = symbol.toUpperCase();
    const merged = [...historyRows, ...rows].filter(row => !row?.symbol || String(row.symbol).toUpperCase() === normalized);
    return averagePriceBars(merged, config.bucket);
  }, [config.bucket, historyRows, rows, symbol]);
  const calculated = useMemo(() => computePriceCharmander(analysisBars), [analysisBars]);
  const latestAt = Date.parse(calculated.timestamps.at(-1) || "");
  const cutoff = Number.isFinite(latestAt) ? latestAt - config.seconds * 1000 : 0;
  const visibleIndexes = useMemo(() => {
    const indexes = calculated.timestamps.map((timestamp, index) => Date.parse(timestamp) >= cutoff ? index : -1).filter(index => index >= 0);
    const lastPosition = Math.max(indexes.length - 1, 0);
    const startPosition = Math.floor(view.start * lastPosition), endPosition = Math.ceil(view.end * lastPosition);
    const windowed = indexes.slice(startPosition, endPosition + 1), stride = Math.max(1, Math.ceil(windowed.length / 520));
    const sampled = windowed.filter((_, index) => index % stride === 0);
    if (windowed.length && sampled.at(-1) !== windowed.at(-1)) sampled.push(windowed.at(-1));
    return sampled;
  }, [calculated.timestamps, cutoff, view]);
  const visibleStartAt = Date.parse(calculated.timestamps[visibleIndexes[0]] || ""), visibleEndAt = Date.parse(calculated.timestamps[visibleIndexes.at(-1)] || "");
  const candles = useMemo(() => analysisBars.filter(bar => bar.at >= visibleStartAt && bar.at <= visibleEndAt), [analysisBars, visibleEndAt, visibleStartAt]);
  const warmupBars = useMemo(() => analysisBars.filter(bar => bar.at < cutoff).length, [analysisBars, cutoff]);
  const warmupReady = warmupBars >= 90;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const measure = () => setSize({ width: Math.max(620, frame.clientWidth), height: Math.max(460, frame.clientHeight || 520) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const frame=frameRef.current;
    if(!frame)return undefined;
    const zoom=event=>{
      event.preventDefault();
      const bounds=frame.getBoundingClientRect(),focus=clamp((event.clientX-bounds.left-68)/Math.max(bounds.width-88,1),0,1);
      setView(current=>{
        const span=current.end-current.start,nextSpan=clamp(span*(event.deltaY>0?1.22:.8),.08,1),anchor=current.start+focus*span;
        const start=clamp(anchor-focus*nextSpan,0,1-nextSpan);
        return {start,end:start+nextSpan};
      });
      setHover(null);
    };
    frame.addEventListener("wheel",zoom,{passive:false});
    return()=>frame.removeEventListener("wheel",zoom);
  },[]);

  const latestIndex = visibleIndexes.at(-1);
  const breadth = latestIndex == null ? 0 : calculated.series.reduce((sum, line) => sum + (line[latestIndex] > 0 ? 1 : 0), 0) / calculated.series.length;
  const previousIndex = visibleIndexes.at(-2) ?? latestIndex;
  const consensus = latestIndex == null ? 0 : calculated.series.reduce((sum, line) => sum + line[latestIndex], 0) / calculated.series.length;
  const previousConsensus = previousIndex == null ? consensus : calculated.series.reduce((sum, line) => sum + line[previousIndex], 0) / calculated.series.length;
  const state = Math.abs(consensus) < .08 ? "NEUTRAL" : consensus > 0 ? "BULLISH" : "BEARISH";
  const phase = charmPhase(consensus, previousConsensus);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visibleIndexes.length) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2), width = size.width, height = size.height;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const left=68,right=20,top0=24,axisSpace=32,gap=44,panelHeight=Math.max(170,(height-top0-axisSpace-gap)/2),top1=top0+panelHeight,bottom0=top1+gap,bottom1=Math.min(height-axisSpace,bottom0+panelHeight),plotWidth=width-left-right;
    const firstAt = Date.parse(calculated.timestamps[visibleIndexes[0]]), lastAt = Date.parse(calculated.timestamps[visibleIndexes.at(-1)]), timeSpan = Math.max(1, lastAt - firstAt);
    const xAt = at => left + (at - firstAt) / timeSpan * plotWidth;
    context.fillStyle = "#061019"; context.fillRect(left, top0, plotWidth, top1 - top0); context.fillRect(left, bottom0, plotWidth, bottom1 - bottom0);
    context.fillStyle="rgba(54,185,82,.055)";context.fillRect(left,bottom0,plotWidth,(bottom1-bottom0)/2);context.fillStyle="rgba(255,69,89,.05)";context.fillRect(left,(bottom0+bottom1)/2,plotWidth,(bottom1-bottom0)/2);
    context.strokeStyle = "#183746"; context.lineWidth = 1;
    for (const y of [top0, (top0 + top1) / 2, top1, bottom0, (bottom0 + bottom1) / 2, bottom1]) { context.beginPath(); context.moveTo(left, y); context.lineTo(width - right, y); context.stroke(); }
    for (let tick = 0; tick < 6; tick += 1) {
      const at = firstAt + timeSpan * tick / 5, x = xAt(at);
      context.beginPath(); context.moveTo(x, top0); context.lineTo(x, bottom1); context.stroke();
      context.fillStyle = "#829aaa"; context.font = "10px monospace"; context.textAlign = tick === 0 ? "left" : tick === 5 ? "right" : "center";
      context.fillText(timeLabel(at), x, height - 10);
    }
    const prices = candles.flatMap(candle => [candle.low, candle.high]);
    const low = Math.min(...prices), high = Math.max(...prices), padding = Math.max((high - low) * .12, .08), priceLow = low - padding, priceHigh = high + padding;
    const priceY = price => top1 - (price - priceLow) / Math.max(priceHigh - priceLow, .01) * (top1 - top0);
    const candleWidth = Math.max(2, Math.min(9, plotWidth / Math.max(candles.length, 1) * .58));
    candles.forEach(candle => {
      const x = xAt(candle.at), rising = candle.close >= candle.open;
      context.strokeStyle = rising ? "#00d084" : "#ff4f69"; context.fillStyle = context.strokeStyle;
      context.beginPath(); context.moveTo(x, priceY(candle.high)); context.lineTo(x, priceY(candle.low)); context.stroke();
      const openY = priceY(candle.open), closeY = priceY(candle.close);
      context.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(1.5, Math.abs(closeY - openY)));
    });
    const charmLimit=1;
    context.fillStyle = "#dceaf2"; context.font = "700 11px monospace"; context.textAlign = "left"; context.fillText(`${symbol} PRICE · USD`, 9, 48); context.fillText("PRICE-ONLY CHARMANDER · SMOOTHED ANGLE", 9, bottom0 + 18);
    context.fillStyle = "#8ea8b8"; context.font = "10px monospace"; context.fillText(priceHigh.toFixed(2), 9, top0 + 4); context.fillText(priceLow.toFixed(2), 9, top1); context.fillText(`+${charmLimit.toFixed(2)}`, 22, bottom0 + 4); context.fillText("0", 45, (bottom0 + bottom1) / 2 + 3); context.fillText(`−${charmLimit.toFixed(2)}`, 22, bottom1);
    const charmY = value => bottom1 - (clamp(value,-charmLimit,charmLimit) + charmLimit) / (charmLimit*2) * (bottom1 - bottom0);
    calculated.series.forEach((line, lineIndex) => {
      for (let point = 1; point < visibleIndexes.length; point += 1) {
        const prior = visibleIndexes[point - 1], current = visibleIndexes[point],offset=visualShift?Math.round((lineIndex+1)/2):0,priorValueIndex=prior+offset,currentValueIndex=current+offset;
        if(currentValueIndex>=line.length)continue;
        context.strokeStyle = COLORS[charmPhase(line[currentValueIndex], line[priorValueIndex])];
        context.globalAlpha = .26 + lineIndex / calculated.series.length * .32;
        context.lineWidth = lineIndex % 5 === 0 ? 1.1 : .75;
        context.beginPath(); context.moveTo(xAt(Date.parse(calculated.timestamps[prior])), charmY(line[priorValueIndex])); context.lineTo(xAt(Date.parse(calculated.timestamps[current])), charmY(line[currentValueIndex])); context.stroke();
      }
    });
    const consensusGroups=[[0,6],[6,15],[15,29]];
    consensusGroups.forEach(([start,end],groupIndex)=>{
      for(let point=1;point<visibleIndexes.length;point+=1){
        const prior=visibleIndexes[point-1],current=visibleIndexes[point],lines=calculated.series.slice(start,end),priorValue=lines.reduce((sum,line)=>sum+line[prior],0)/lines.length,currentValue=lines.reduce((sum,line)=>sum+line[current],0)/lines.length;
        context.strokeStyle=COLORS[charmPhase(currentValue,priorValue)];context.globalAlpha=1;context.lineWidth=3.6-groupIndex*.55;context.beginPath();context.moveTo(xAt(Date.parse(calculated.timestamps[prior])),charmY(priorValue));context.lineTo(xAt(Date.parse(calculated.timestamps[current])),charmY(currentValue));context.stroke();
      }
    });
    context.globalAlpha = 1;
    if (hover != null && visibleIndexes[hover] != null) {
      const index = visibleIndexes[hover], x = xAt(Date.parse(calculated.timestamps[index]));
      context.strokeStyle = "#d9f5ff"; context.lineWidth = 1; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(x, top0); context.lineTo(x, bottom1); context.stroke(); context.setLineDash([]);
    }
  }, [calculated, candles, hover, size, symbol, visibleIndexes,visualShift]);

  const pointerMove = event => {
    if (!visibleIndexes.length) return;
    const bounds = event.currentTarget.getBoundingClientRect(), ratio = clamp((event.clientX - bounds.left - 68) / Math.max(bounds.width - 88, 1), 0, 1);
    setHover(Math.round(ratio * (visibleIndexes.length - 1)));
  };
  const hoveredIndex = hover == null ? latestIndex : visibleIndexes[hover];
  const hoveredPrice = hoveredIndex == null ? null : calculated.prices[hoveredIndex];
  const hoveredConsensus = hoveredIndex == null ? null : calculated.series.reduce((sum, line) => sum + line[hoveredIndex], 0) / calculated.series.length;

  return <section className="price-charmander">
    <header><div><span>AXIOM PRICE CHARMANDER · OBSERVATIONAL</span><h3>{symbol} price above · {config.bucket}s buckets · 29 independent MA slopes</h3></div><div className="price-charmander-state"><b className={phase}>{state}</b><small>{historyState === "loading" ? "LOADING WARM-UP" : warmupReady ? `${Math.round(breadth * 100)}% bullish · READY` : `WARMING ${warmupBars}/90`}</small></div></header>
    <div className="price-charmander-body">
      <nav className="price-charmander-controls" aria-label="Charmander time window"><b>TIME</b>{Object.keys(RANGE_CONFIG).map(item => <button type="button" className={range === item ? "active" : ""} onClick={() => { setRange(item); setView({start:0,end:1}); setHover(null); }} key={item}>{item}</button>)}<button type="button" onClick={()=>setView({start:0,end:1})}>FIT</button><button type="button" title="Toggle historical replica shift" className={visualShift?"replica active":"replica"} onClick={()=>setVisualShift(value=>!value)}>{visualShift?"SHIFT":"LIVE"}</button></nav>
      <div className="price-charmander-frame" ref={frameRef} onPointerMove={pointerMove} onPointerLeave={() => setHover(null)} onDoubleClick={()=>setView({start:0,end:1})}>
        <canvas ref={canvasRef}/>
        {hoveredIndex != null && <aside><b>{timeLabel(calculated.timestamps[hoveredIndex])} ET</b><span>{symbol} <strong>{hoveredPrice?.toFixed(2)}</strong></span><span>CONSENSUS <strong>{hoveredConsensus >= 0 ? "+" : ""}{hoveredConsensus?.toFixed(3)}</strong></span><span>ZOOM <strong>{Math.round(100/(view.end-view.start))}%</strong></span></aside>}
      </div>
    </div>
    <footer><span><i className="green"/>POSITIVE · RISING</span><span><i className="orange"/>POSITIVE · FALLING</span><span><i className="red"/>NEGATIVE · FALLING</span><span><i className="blue"/>NEGATIVE · RISING</span><small>{config.bucket}s range-aware averages · hidden warm-up · bold consensus is causal and live</small></footer>
  </section>;
}
