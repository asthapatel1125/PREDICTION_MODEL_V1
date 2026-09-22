import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWallPriceSeries } from "./api";
import { averagePriceBars, charmPhase, computePricePhoenix } from "./priceCharmander";

const RANGE_CONFIG = {
  "1M": { seconds: 9000, bucket: 60 },
  "5M": { seconds: 45000, bucket: 300 },
  "15M": { seconds: 135000, bucket: 900 },
  "30M": { seconds: 270000, bucket: 1800 },
  "1H": { seconds: 540000, bucket: 3600 },
  "2H": { seconds: 1080000, bucket: 7200 },
  "4H": { seconds: 2160000, bucket: 14400 },
  "6H": { seconds: 3240000, bucket: 21600 },
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
const dateLabel = timestamp => new Date(timestamp).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const dateKey = timestamp => new Date(timestamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export default function PricePhoenixChart({ rows = [], symbol = "QQQ", nas100Calibration = null, spxCashBasis = 28.4 }) {
  const [range, setRange] = useState("5M");
  const [visualShift, setVisualShift] = useState(false);
  const [xZoom, setXZoom] = useState(1);
  const [priceYZoom, setPriceYZoom] = useState(1);
  const [charmYZoom, setCharmYZoom] = useState(1);
  const [historyRows, setHistoryRows] = useState([]);
  const [historyState, setHistoryState] = useState("loading");
  const [hasEarlier,setHasEarlier]=useState(true);
  const [size, setSize] = useState({ width: 1200, height: 610 });
  const [scrollOffset,setScrollOffset]=useState(0),[viewportWidth,setViewportWidth]=useState(1200);
  const [hover, setHover] = useState(null);
  const canvasRef = useRef(null), frameRef = useRef(null),topScrollRef=useRef(null),bottomScrollRef=useRef(null),scrollSyncRef=useRef(false),loadingEarlierRef=useRef(false),backfillAnchorRef=useRef(null),followingLiveRef=useRef(true);
  const config = RANGE_CONFIG[range];
  useEffect(() => {
    const controller = new AbortController();
    setHistoryRows([]);setHasEarlier(true);
    setHistoryState("loading");
    fetchWallPriceSeries(symbol, config.seconds, config.bucket, controller.signal)
      .then(result => { setHistoryRows(result.rows || []);setHasEarlier(result.has_more!==false); setHistoryState("ready"); })
      .catch(error => { if (error.name !== "AbortError") { setHistoryRows([]); setHistoryState("live-only"); } });
    return () => controller.abort();
  }, [config.bucket, config.seconds, symbol]);
  const analysisBars = useMemo(() => {
    const normalized = symbol.toUpperCase();
    const merged = [...historyRows, ...rows].filter(row => !row?.symbol || String(row.symbol).toUpperCase() === normalized);
    return averagePriceBars(merged, config.bucket,Number.MAX_SAFE_INTEGER);
  }, [config.bucket, historyRows, rows, symbol]);
  const calculated = useMemo(() => computePricePhoenix(analysisBars), [analysisBars]);
  const phoenixName="PHOENIX",sourceLabel="TRIMMED BUCKET AVERAGE",watermarkLabel=symbol.toUpperCase();
  const visibleIndexes = useMemo(() => {
    const indexes = calculated.timestamps.map((_, index) => index);
    const windowed = indexes, stride = Math.max(1, Math.ceil(windowed.length / 900));
    const sampled = windowed.filter((_, index) => index % stride === 0);
    if (windowed.length && sampled.at(-1) !== windowed.at(-1)) sampled.push(windowed.at(-1));
    return sampled;
  }, [calculated.timestamps]);
  const visibleStartAt = Date.parse(calculated.timestamps[visibleIndexes[0]] || ""), visibleEndAt = Date.parse(calculated.timestamps[visibleIndexes.at(-1)] || "");
  const candles = useMemo(() => analysisBars.filter(bar => bar.at >= visibleStartAt && bar.at <= visibleEndAt), [analysisBars, visibleEndAt, visibleStartAt]);
  const firstDataAt=Date.parse(calculated.timestamps[0]||""),lastDataAt=Date.parse(calculated.timestamps.at(-1)||""),dataSpan=Math.max(1,lastDataAt-firstDataAt),plotPixelWidth=Math.max(1,size.width-88),visiblePixelStart=clamp(scrollOffset-68,0,plotPixelWidth),visiblePixelEnd=clamp(scrollOffset+Math.max(viewportWidth,1)-68,visiblePixelStart+1,plotPixelWidth),viewStartAt=firstDataAt+visiblePixelStart/plotPixelWidth*dataSpan,viewEndAt=firstDataAt+visiblePixelEnd/plotPixelWidth*dataSpan;
  const scaleCandles=useMemo(()=>{const selected=candles.filter(bar=>bar.at>=viewStartAt&&bar.at<=viewEndAt);return selected.length?selected:candles},[candles,viewEndAt,viewStartAt]);
  const scaleCharmIndexes=useMemo(()=>visibleIndexes.filter(index=>{const at=Date.parse(calculated.timestamps[index]);return at>=viewStartAt&&at<=viewEndAt}),[calculated.timestamps,viewEndAt,viewStartAt,visibleIndexes]);
  const warmupBars = analysisBars.length;
  const warmupReady = warmupBars >= 90;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const measure = () => {const viewport=Math.max(620,frame.clientWidth),expectedBars=Math.max(1,config.seconds/config.bucket),contentWidth=Math.min(30000,Math.max(viewport,analysisBars.length*(viewport/expectedBars)*xZoom));setViewportWidth(viewport);setSize({width:contentWidth,height:Math.max(460,frame.clientHeight||520)})};
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [analysisBars.length,config.bucket,config.seconds,xZoom]);
  useEffect(() => {
    const frame=frameRef.current;
    if(!frame)return undefined;
    const zoom=event=>{
      event.preventDefault();
      const bounds=frame.getBoundingClientRect(),pointer=clamp(event.clientX-bounds.left,0,frame.clientWidth),anchor=(frame.scrollLeft+pointer)/Math.max(frame.scrollWidth,1),factor=event.deltaY<0?1.18:.85;
      followingLiveRef.current=false;
      setXZoom(current=>{const next=clamp(current*factor,.5,12);requestAnimationFrame(()=>{if(frameRef.current)frameRef.current.scrollLeft=anchor*frameRef.current.scrollWidth-pointer});return next});
      setHover(null);
    };
    frame.addEventListener("wheel",zoom,{passive:false});
    return()=>frame.removeEventListener("wheel",zoom);
  },[]);
  const loadEarlier=async()=>{if(loadingEarlierRef.current||!hasEarlier||!historyRows.length)return;const frame=frameRef.current;loadingEarlierRef.current=true;if(frame)backfillAnchorRef.current={width:frame.scrollWidth,left:frame.scrollLeft};try{const before=historyRows[0].timestamp,result=await fetchWallPriceSeries(symbol,config.seconds,config.bucket,undefined,before),incoming=result.rows||[];setHistoryRows(current=>[...new Map([...incoming,...current].map(row=>[row.timestamp,row])).values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)));if(result.has_more===false||!incoming.length)setHasEarlier(false)}finally{loadingEarlierRef.current=false}};
  useEffect(()=>{const frame=frameRef.current,anchor=backfillAnchorRef.current;if(!frame||!anchor)return;requestAnimationFrame(()=>{const node=frameRef.current;if(!node)return;node.scrollLeft=anchor.left+Math.max(0,node.scrollWidth-anchor.width);backfillAnchorRef.current=null})},[size.width]);
  useEffect(()=>{const frame=frameRef.current;if(!frame||!followingLiveRef.current||backfillAnchorRef.current)return;requestAnimationFrame(()=>{if(frameRef.current)frameRef.current.scrollLeft=frameRef.current.scrollWidth-frameRef.current.clientWidth})},[analysisBars.length,range]);

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
    const ratio = size.width>15000?1:Math.min(window.devicePixelRatio || 1, 2), width = size.width, height = size.height;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle="#000";context.fillRect(0,0,width,height);
    const left=68,right=20,top0=58,axisSpace=43,gap=0,panelHeight=Math.max(150,(height-top0-axisSpace-gap)/2),top1=top0+panelHeight,bottom0=top1+gap,bottom1=Math.min(height-axisSpace,bottom0+panelHeight),plotWidth=width-left-right;
    const firstAt = Date.parse(calculated.timestamps[visibleIndexes[0]]), lastAt = Date.parse(calculated.timestamps[visibleIndexes.at(-1)]), timeSpan = Math.max(1, lastAt - firstAt);
    const xAt = at => left + (at - firstAt) / timeSpan * plotWidth;
    context.fillStyle = "#000"; context.fillRect(left, top0, plotWidth, bottom1 - top0);
    const watermarkX=clamp(scrollOffset+Math.max(viewportWidth,1)/2,left,width-right);
    context.fillStyle="rgba(168,176,184,.13)";context.font="300 72px sans-serif";context.textAlign="center";context.textBaseline="middle";context.fillText(watermarkLabel,watermarkX,(top0+bottom1)/2);context.textBaseline="alphabetic";
    context.strokeStyle = "#183746"; context.lineWidth = 1;
    for (const y of [top0, (top0 + top1) / 2, top1, bottom0, (bottom0 + bottom1) / 2, bottom1]) { context.beginPath(); context.moveTo(left, y); context.lineTo(width - right, y); context.stroke(); }
    // Use real candle timestamps and admit labels only when their rendered
    // positions are far enough apart. This stays readable while scrolling or
    // zooming and avoids inventing timestamps between sparse candles.
    const tickCandidates=scaleCharmIndexes.length?scaleCharmIndexes:visibleIndexes,tickIndexes=[],minimumTickGap=124;
    let nextTickX=Number.POSITIVE_INFINITY;
    for(let candidate=tickCandidates.length-1;candidate>=0;candidate-=1){const index=tickCandidates[candidate],position=xAt(Date.parse(calculated.timestamps[index]));if(nextTickX-position>=minimumTickGap||!tickIndexes.length){tickIndexes.push(index);nextTickX=position}}
    tickIndexes.reverse();
    const visibleCanvasLeft=scrollOffset+4,visibleCanvasRight=Math.min(width-right,scrollOffset+Math.max(viewportWidth,1)-4);
    for (let tick = 0; tick < tickIndexes.length; tick += 1) {
      const index=tickIndexes[tick],at=Date.parse(calculated.timestamps[index]),x=xAt(at),showDate=tick===0||dateKey(at)!==dateKey(calculated.timestamps[tickIndexes[tick-1]]);
      context.beginPath(); context.moveTo(x, top0); context.lineTo(x, bottom1); context.stroke();
      context.fillStyle = "#9db5c4"; context.font = "10px monospace"; context.textAlign = tick === 0&&x-visibleCanvasLeft<55 ? "left" : tick === tickIndexes.length-1&&visibleCanvasRight-x<55 ? "right" : "center";
      context.fillText(timeLabel(at), x, height - 21);
      if(showDate){context.fillStyle = "#658292"; context.font = "9px monospace";context.fillText(dateLabel(at), x, height - 8)}
    }
    const prices = scaleCandles.flatMap(candle => [candle.low, candle.high]);
    const low = Math.min(...prices), high = Math.max(...prices),rawSpan=Math.max(high-low,.08),center=(high+low)/2,span=rawSpan/priceYZoom,padding=Math.max(span*.12,.02),priceLow=center-span/2-padding,priceHigh=center+span/2+padding;
    const priceY = price => top1 - (price - priceLow) / Math.max(priceHigh - priceLow, .01) * (top1 - top0);
    const candleWidth = Math.max(2, Math.min(9, plotWidth / Math.max(candles.length, 1) * .58));
    candles.forEach(candle => {
      const x = xAt(candle.at), rising = candle.close >= candle.open;
      context.strokeStyle = rising ? "#00d084" : "#ff4f69"; context.fillStyle = context.strokeStyle;
      context.beginPath(); context.moveTo(x, priceY(candle.high)); context.lineTo(x, priceY(candle.low)); context.stroke();
      const openY = priceY(candle.open), closeY = priceY(candle.close);
      context.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(1.5, Math.abs(closeY - openY)));
    });
    const visibleCharmValues=calculated.series.flatMap(line=>scaleCharmIndexes.map(index=>Math.abs(line[index]||0))),autoCharmLimit=Math.max(.12,...visibleCharmValues),charmLimit=Math.min(1,autoCharmLimit*1.12)/charmYZoom;
    const charmY = value => bottom1 - (clamp(value,-charmLimit,charmLimit) + charmLimit) / (charmLimit*2) * (bottom1 - bottom0);
    calculated.series.forEach((line, lineIndex) => {
      for (let point = 1; point < visibleIndexes.length; point += 1) {
        const prior = visibleIndexes[point - 1], current = visibleIndexes[point],offset=visualShift?Math.round((lineIndex+1)/2):0,priorValueIndex=prior+offset,currentValueIndex=current+offset;
        if(currentValueIndex>=line.length)continue;
        context.strokeStyle = COLORS[charmPhase(line[currentValueIndex], line[priorValueIndex])];
        context.globalAlpha = .68;
        context.lineWidth = 1.35;
        context.beginPath(); context.moveTo(xAt(Date.parse(calculated.timestamps[prior])), charmY(line[priorValueIndex])); context.lineTo(xAt(Date.parse(calculated.timestamps[current])), charmY(line[currentValueIndex])); context.stroke();
      }
    });
    context.globalAlpha = 1;
    if (hover != null && visibleIndexes[hover] != null) {
      const index = visibleIndexes[hover], x = xAt(Date.parse(calculated.timestamps[index]));
      context.strokeStyle = "#d9f5ff"; context.lineWidth = 1; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(x, top0); context.lineTo(x, bottom1); context.stroke(); context.setLineDash([]);
    }
  }, [calculated, candles, charmYZoom, hover, priceYZoom, scaleCandles, scaleCharmIndexes, scrollOffset, size, symbol, viewportWidth, visibleIndexes,visualShift,watermarkLabel]);

  const pointerMove = event => {
    if (!visibleIndexes.length) return;
    const bounds = event.currentTarget.getBoundingClientRect(), ratio = clamp((event.clientX - bounds.left + event.currentTarget.scrollLeft - 68) / Math.max(size.width - 88, 1), 0, 1);
    setHover(Math.round(ratio * (visibleIndexes.length - 1)));
  };
  const hoveredIndex = hover == null ? latestIndex : visibleIndexes[hover];
  const hoveredPrice = hoveredIndex == null ? null : calculated.prices[hoveredIndex];
  const hoveredConsensus = hoveredIndex == null ? null : calculated.series.reduce((sum, line) => sum + line[hoveredIndex], 0) / calculated.series.length;
  const normalizedSymbol=symbol.toUpperCase(),indexEstimate=Number.isFinite(hoveredPrice)
    ?normalizedSymbol==="SPY"
      ?{label:"S&P 500 EST",value:hoveredPrice*10+spxCashBasis,title:`Estimated S&P 500 cash-index level: SPY × 10 + ${Number(spxCashBasis).toFixed(2)} synchronized cash basis. Not a live SPX quote.`}
      :normalizedSymbol==="QQQ"
        ?Number.isFinite(Number(nas100Calibration?.slope))&&Math.abs(Number(nas100Calibration.slope))>.000001
          ?{label:"NAS100 EST",value:(hoveredPrice-Number(nas100Calibration.intercept))/Number(nas100Calibration.slope),title:`Estimated NASDAQ-100 cash level using the ${nas100Calibration.month??"latest"} range-calibrated QQQ affine mapping. Not a live NDX, NAS100 CFD, or NQ quote.`}
          :null
        :null
    :null;
  const priceValues=scaleCandles.flatMap(candle=>[candle.low,candle.high]),axisLow=priceValues.length?Math.min(...priceValues):0,axisHigh=priceValues.length?Math.max(...priceValues):1,axisRawSpan=Math.max(axisHigh-axisLow,.08),axisCenter=(axisHigh+axisLow)/2,axisSpan=axisRawSpan/priceYZoom,axisPadding=Math.max(axisSpan*.12,.02),priceScaleLow=axisCenter-axisSpan/2-axisPadding,priceScaleHigh=axisCenter+axisSpan/2+axisPadding,visibleCharmValues=calculated.series.flatMap(line=>scaleCharmIndexes.map(index=>Math.abs(line[index]||0))),charmLimit=Math.min(1,Math.max(.12,...visibleCharmValues)*1.12)/charmYZoom;
  const zoomY=event=>{event.preventDefault();event.stopPropagation();const bounds=event.currentTarget.getBoundingClientRect(),factor=event.deltaY<0?1.12:.89;if(event.clientY-bounds.top<bounds.height/2)setPriceYZoom(value=>clamp(value*factor,.35,12));else setCharmYZoom(value=>clamp(value*factor,.35,12))};
  const resetView=()=>{setXZoom(1);setPriceYZoom(1);setCharmYZoom(1);setHover(null);followingLiveRef.current=true};
  const syncScroll=(source,targets)=>{if(scrollSyncRef.current)return;scrollSyncRef.current=true;for(const target of targets)if(target&&Math.abs(target.scrollLeft-source.scrollLeft)>.5)target.scrollLeft=source.scrollLeft;requestAnimationFrame(()=>{scrollSyncRef.current=false})};
  const scrollFromRail=event=>{const source=event.currentTarget,frame=frameRef.current,other=source===topScrollRef.current?bottomScrollRef.current:topScrollRef.current;followingLiveRef.current=false;syncScroll(source,[frame,other])};
  const scrollFromFrame=event=>{const node=event.currentTarget;setScrollOffset(node.scrollLeft);setViewportWidth(node.clientWidth);followingLiveRef.current=node.scrollLeft>=node.scrollWidth-node.clientWidth-18;syncScroll(node,[topScrollRef.current,bottomScrollRef.current]);if(node.scrollLeft<80)loadEarlier()};

  return <section className="price-charmander">
    <header><div><span>AXIOM PRICE {phoenixName} · OBSERVATIONAL</span><h3>{symbol} price above · {sourceLabel} · {config.bucket}s buckets · 29 independent MA slopes</h3></div><div className="price-charmander-state"><b className={phase}>{state}</b><small>{historyState === "loading" ? "LOADING WARM-UP" : warmupReady ? `${Math.round(breadth * 100)}% bullish · READY` : `WARMING ${warmupBars}/90`}</small></div></header>
    <div className="price-charmander-body">
      <nav className="price-charmander-controls" aria-label={`${phoenixName} time window`}><b>TIME</b>{Object.keys(RANGE_CONFIG).map(item => <button type="button" className={range === item ? "active" : ""} onClick={() => { setRange(item);resetView() }} key={item}>{item}</button>)}<button type="button" onClick={resetView}>FIT</button><button type="button" title="Toggle historical replica shift" className={visualShift?"replica active":"replica"} onClick={()=>setVisualShift(value=>!value)}>{visualShift?"SHIFT":"LIVE"}</button></nav>
      <aside className="price-charmander-axis" onWheel={zoomY} title="Hover and use the mouse wheel for vertical zoom"><section><b>{symbol}<br/>USD</b><span>{priceScaleHigh.toFixed(2)}</span><span>{((priceScaleHigh+priceScaleLow)/2).toFixed(2)}</span><span>{priceScaleLow.toFixed(2)}</span></section><section><b>PHX<br/>ANGLE</b><span>+{charmLimit.toFixed(2)}</span><span>0</span><span>−{charmLimit.toFixed(2)}</span></section></aside>
      <div className="price-charmander-plot">
        <div className="price-charmander-scrollbar top" ref={topScrollRef} onScroll={scrollFromRail} aria-label="Phoenix chart top scrollbar"><div style={{width:size.width}}/></div>
        <div className="price-charmander-frame" ref={frameRef} onScroll={scrollFromFrame} onPointerMove={pointerMove} onPointerLeave={() => setHover(null)} onDoubleClick={resetView}>
          <canvas ref={canvasRef}/>
          {hoveredIndex != null && <aside style={{width:`${Math.max(320,viewportWidth-24)}px`}}><b>{hover===null?"LIVE · ":""}{timeLabel(calculated.timestamps[hoveredIndex])} ET</b><span>{symbol} <strong>{hoveredPrice?.toFixed(2)}</strong></span><span>CONSENSUS <strong>{hoveredConsensus >= 0 ? "+" : ""}{hoveredConsensus?.toFixed(3)}</strong></span>{indexEstimate!==null&&<span className="phoenix-nq-conversion" title={indexEstimate.title}>{indexEstimate.label} <strong>{indexEstimate.value.toFixed(2)}</strong></span>}</aside>}
        </div>
        <div className="price-charmander-scrollbar bottom" ref={bottomScrollRef} onScroll={scrollFromRail} aria-label="Phoenix chart bottom scrollbar"><div style={{width:size.width}}/></div>
      </div>
    </div>
    <footer><span><i className="green"/>POSITIVE · RISING</span><span><i className="orange"/>POSITIVE · FALLING</span><span><i className="red"/>NEGATIVE · FALLING</span><span><i className="blue"/>NEGATIVE · RISING</span><small>Wheel plot: horizontal zoom · wheel Y-axis: vertical zoom · scroll left: backfill</small></footer>
  </section>;
}
