import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWallPriceSeries } from "./api";
import { greekIndexBars } from "./priceCharmander";
import { OPTION_PRO_GREEKS } from "./optionProGreeks";
import { buildSelectedGreekIndex } from "./selectedGreekIndex";

const TIMEFRAMES = { "1M": 60, "5M": 300, "15M": 900, "30M": 1800, "1H": 3600, "4H": 14400, "6H": 21600 };
const axisTime = value => new Date(value).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const axisDate = value => new Date(value).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const signed = value => value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(0)}`;

export default function GreekIndexBuilder({ symbol = "SPY", rows = [] }) {
  const [timeframe, setTimeframe] = useState("1M");
  const [selectedKeys, setSelectedKeys] = useState(["delta", "gamma"]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasEarlier, setHasEarlier] = useState(true);
  const [hover, setHover] = useState(null);
  const [greekMenuOpen, setGreekMenuOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(1000);
  const plotRef = useRef(null), topRef = useRef(null), bottomRef = useRef(null);
  const greekMenuRef = useRef(null);
  const loadingRef = useRef(false), anchorRef = useRef(null), followRef = useRef(true), primedRef = useRef(false);
  const seconds = TIMEFRAMES[timeframe];

  useEffect(() => {
    const controller = new AbortController();
    setHistory([]); setLoading(true); setHasEarlier(true); setHover(null);
    followRef.current = true; primedRef.current = false;
    fetchWallPriceSeries(symbol, seconds * 150, seconds, controller.signal, null, false, true)
      .then(result => { if (!controller.signal.aborted) { setHistory(result.rows || []); setHasEarlier(result.has_more !== false); setLoading(false); } })
      .catch(error => { if (error.name !== "AbortError") setLoading(false); });
    return () => controller.abort();
  }, [symbol, seconds]);

  const bars = useMemo(() => greekIndexBars([...history, ...rows], seconds, Number.MAX_SAFE_INTEGER), [history, rows, seconds]);
  const { selected, version, composite } = useMemo(() => buildSelectedGreekIndex(bars, selectedKeys), [bars, selectedKeys]);
  const width = Math.max(viewportWidth, bars.length * 13 + 100), height = 580, left = 62, right = 22;
  const priceTop = 45, priceBottom = 275, indexTop = 315, indexBottom = 520, plotWidth = width - left - right;
  const x = index => left + index * plotWidth / Math.max(1, bars.length - 1);
  const priceValues = bars.flatMap(bar => [Number(bar.low), Number(bar.high)]).filter(Number.isFinite);
  const minPrice = priceValues.length ? Math.min(...priceValues) : 0;
  const maxPrice = priceValues.length ? Math.max(...priceValues) : 1;
  const pricePadding = Math.max((maxPrice - minPrice) * .1, .02);
  const priceY = value => priceBottom - (value - (minPrice - pricePadding)) / Math.max(maxPrice - minPrice + 2 * pricePadding, .01) * (priceBottom - priceTop);
  const indexY = value => indexBottom - (value + 100) / 200 * (indexBottom - indexTop);
  const pathFor = values => {
    let path = "", drawing = false;
    values.forEach((value, index) => {
      if (value == null) { drawing = false; return; }
      path += `${drawing ? "L" : "M"}${x(index).toFixed(1)},${indexY(value).toFixed(1)} `;
      drawing = true;
    });
    return path;
  };
  const tickStep = Math.max(1, Math.ceil(135 / Math.max(1, plotWidth / Math.max(1, bars.length - 1))));
  const ticks = bars.map((_, index) => index).filter(index => index % tickStep === 0);
  const selectedIndex = hover ?? bars.length - 1, selectedBar = bars[selectedIndex];
  const sync = source => { for (const target of [plotRef.current, topRef.current, bottomRef.current]) if (target && target !== source) target.scrollLeft = source.scrollLeft; };
  const loadEarlier = async () => {
    if (loadingRef.current || !hasEarlier || !history.length) return;
    loadingRef.current = true;
    const plot = plotRef.current;
    anchorRef.current = plot ? { width: plot.scrollWidth, left: plot.scrollLeft } : null;
    try {
      const result = await fetchWallPriceSeries(symbol, seconds * 150, seconds, undefined, history[0].timestamp, false, true);
      const incoming = result.rows || [];
      setHistory(current => [...new Map([...incoming, ...current].map(row => [row.timestamp, row])).values()]
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)));
      if (!incoming.length || result.has_more === false) setHasEarlier(false);
    } catch { anchorRef.current = null; } finally { loadingRef.current = false; }
  };
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const observer = new ResizeObserver(() => setViewportWidth(plot.clientWidth));
    observer.observe(plot); setViewportWidth(plot.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const anchor = anchorRef.current, plot = plotRef.current;
    if (!anchor || !plot) return;
    requestAnimationFrame(() => {
      const next = plotRef.current;
      if (next) { next.scrollLeft = anchor.left + next.scrollWidth - anchor.width; sync(next); }
      anchorRef.current = null;
    });
  }, [width]);
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || anchorRef.current || !followRef.current || !bars.length) return;
    requestAnimationFrame(() => {
      const next = plotRef.current;
      if (next && followRef.current) { next.scrollLeft = next.scrollWidth - next.clientWidth; sync(next); primedRef.current = true; }
    });
  }, [bars.length, width]);
  useEffect(() => {
    if (!greekMenuOpen) return;
    const closeOnOutsidePointer = event => {
      if (!greekMenuRef.current?.contains(event.target)) setGreekMenuOpen(false);
    };
    const closeOnEscape = event => {
      if (event.key === "Escape") setGreekMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [greekMenuOpen]);
  const toggle = key => setSelectedKeys(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]);

  return <section className="greek-index-builder" aria-label="Selectable Greek exposure index with price">
    <header><div><span>OPTIONS PRO GREEK INDEX</span><h3>{symbol} price + selected options exposures</h3></div><small>OI-BASED PROXY · NOT A PRICE FORECAST</small></header>
    <div className="greek-index-controls"><strong>{symbol} ONLY · {version || "NO GREEKS SELECTED"}</strong><div role="group" aria-label="Candle size">{Object.keys(TIMEFRAMES).map(item => <button key={item} type="button" aria-pressed={timeframe === item} className={timeframe === item ? "active" : ""} onClick={() => setTimeframe(item)}>{item}</button>)}</div></div>
    <div className="greek-index-choices" role="group" aria-label="Greeks included in the index">
      <div className="greek-index-dropdown" ref={greekMenuRef}>
        <button className="greek-index-dropdown-trigger" type="button" aria-expanded={greekMenuOpen} aria-controls={`${symbol.toLowerCase()}-greek-options`} onClick={() => setGreekMenuOpen(open => !open)}>ADD GREEKS <span>{selected.length} SELECTED</span><b aria-hidden="true">{greekMenuOpen ? "▴" : "▾"}</b></button>
        {greekMenuOpen && <div className="greek-index-dropdown-menu" id={`${symbol.toLowerCase()}-greek-options`} role="group" aria-label="Options Pro Greeks">{OPTION_PRO_GREEKS.map(line => { const included = selected.some(item => item.key === line.key); return <button key={line.key} type="button" aria-pressed={included} className={included ? "active" : ""} style={{ "--greek-color": line.color }} onClick={() => toggle(line.key)}><i/>{line.label} <small>{included ? "INCLUDED" : "+ ADD"}</small></button>; })}</div>}
      </div>
      <span className="greek-index-formula">{version ? `${version} = (${selected.map(item => item.line.label).join(" + ")}) ÷ ${selected.length}` : "SELECT ONE OR MORE GREEKS"}</span>
    </div>
    <div className="greek-index-scroll top" ref={topRef} onScroll={event => sync(event.currentTarget)} aria-label="Greek index top scrollbar"><div style={{ width }}/></div>
    <div className="greek-index-viewport" ref={plotRef} onScroll={event => { const node = event.currentTarget; sync(node); if (primedRef.current) { followRef.current = node.scrollLeft >= node.scrollWidth - node.clientWidth - 20; if (node.scrollLeft < 60) loadEarlier(); } }} onPointerMove={event => { if (!bars.length) return; const bounds = event.currentTarget.getBoundingClientRect(), position = event.clientX - bounds.left + event.currentTarget.scrollLeft; setHover(Math.max(0, Math.min(bars.length - 1, Math.round((position - left) / plotWidth * Math.max(1, bars.length - 1))))); }} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={`${symbol} price candles above one composite index of selected Greek exposures`}>
        <rect width={width} height={height} fill="#000"/>
        {[priceTop,priceBottom,indexTop,indexBottom].map(value => <line key={value} x1={left} x2={width-right} y1={value} y2={value} stroke="#254251"/>)}
        {[minPrice,maxPrice].filter((value,index)=>index===0||value!==minPrice).map(value => <text key={`price-${value}`} x={left-8} y={priceY(value)+4} textAnchor="end" fill="#a8bfcc" fontSize="10">{value.toFixed(2)}</text>)}
        {[-100,-50,0,50,100].map(value => <g key={value}><line x1={left} x2={width-right} y1={indexY(value)} y2={indexY(value)} stroke={value === 0 ? "#657f8e" : "#193340"}/><text x={left-8} y={indexY(value)+4} textAnchor="end" fill="#a8bfcc" fontSize="11">{value > 0 ? `+${value}` : value}</text></g>)}
        {ticks.map(index => <g key={index}><line x1={x(index)} x2={x(index)} y1={priceTop} y2={indexBottom} stroke="#183644"/><text x={x(index)} y={height-25} textAnchor="middle" fill="#acc3cf" fontSize="11">{axisTime(bars[index].timestamp)}</text><text x={x(index)} y={height-10} textAnchor="middle" fill="#7191a1" fontSize="9">{axisDate(bars[index].timestamp)}</text></g>)}
        <text x={left+8} y={priceTop+18} fill="#bde8fa" fontSize="11" fontWeight="bold">{symbol} PRICE · USD</text>
        <text x={left+8} y={indexTop+18} fill="#bde8fa" fontSize="11" fontWeight="bold">{version || "GREEK"} COMPOSITE INDEX · −100 TO +100</text>
        {bars.map((bar,index) => { const candleColor = Number(bar.close) >= Number(bar.open) ? "#00d084" : "#ff4f69"; return <g key={bar.timestamp} stroke={candleColor} fill={candleColor}><line x1={x(index)} x2={x(index)} y1={priceY(Number(bar.high))} y2={priceY(Number(bar.low))}/><rect x={x(index)-3} y={Math.min(priceY(Number(bar.open)),priceY(Number(bar.close)))} width="6" height={Math.max(2,Math.abs(priceY(Number(bar.close))-priceY(Number(bar.open))))}/></g>; })}
        {selected.length > 0 && <path d={pathFor(composite)} fill="none" stroke="#f4f7f9" strokeWidth="3.4" strokeLinejoin="round" strokeLinecap="round"/>}
        {selectedBar && <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={priceTop} y2={indexBottom} stroke="#d8f5ff" strokeDasharray="3 5"/>}
      </svg>
    </div>
    <div className="greek-index-scroll bottom" ref={bottomRef} onScroll={event => sync(event.currentTarget)} aria-label="Greek index bottom scrollbar"><div style={{ width }}/></div>
    <div className="greek-index-readout"><strong>{selectedBar ? `${axisTime(selectedBar.timestamp)} ET · ${symbol} ${Number(selectedBar.close).toFixed(2)}` : loading ? "LOADING PRICE AND EXPOSURES" : "WAITING FOR PRICE AND EXPOSURES"}</strong><span className="composite">{version || "INDEX"} {selected.map(item => item.key.toUpperCase()).join(" + ")} <b>{signed(composite[selectedIndex])}</b></span></div>
    <footer>V1 means one selected Greek, V2 two, and so on. The single white index is the equal-weight mean of selected Greeks after each is independently indexed to its prior 150 confirmed candles (at least 10 required). Deselecting a Greek removes it immediately. Missing or not-yet-stored inputs leave a gap; this is not a predicted price.</footer>
  </section>;
}
