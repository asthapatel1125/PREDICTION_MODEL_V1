import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWallPriceSeries } from "./api";
import { averagePriceBars } from "./priceCharmander";
import { EXPOSURE_LINES, indexGreekExposures } from "./greekExposureIndex";

const TIMEFRAMES = { "1M": 60, "5M": 300, "15M": 900, "30M": 1800, "1H": 3600, "4H": 14400, "6H": 21600 };
const axisTime = value => new Date(value).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const axisDate = value => new Date(value).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const rawLabel = value => Number.isFinite(Number(value)) && value !== null ? Number(value).toExponential(2) : "—";

export default function GreekExposureChart({ symbol = "QQQ", rows = [] }) {
  const [timeframe, setTimeframe] = useState("1M");
  const [history, setHistory] = useState([]);
  const [loadState, setLoadState] = useState("loading");
  const [hover, setHover] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const [hasEarlier, setHasEarlier] = useState(true);
  const plotRef = useRef(null), topRef = useRef(null), bottomRef = useRef(null), loadingRef = useRef(false), anchorRef = useRef(null), followRef = useRef(true), primedRef = useRef(false);
  const seconds = TIMEFRAMES[timeframe];

  useEffect(() => {
    const controller = new AbortController();
    setHistory([]); setHasEarlier(true); setLoadState("loading"); setHover(null); followRef.current = true; primedRef.current = false;
    fetchWallPriceSeries(symbol, seconds * 150, seconds, controller.signal)
      .then(result => { if (controller.signal.aborted) return; setHistory(result.rows || []); setHasEarlier(result.has_more !== false); setLoadState("ready"); })
      .catch(error => { if (error.name !== "AbortError") setLoadState("live-only"); });
    return () => controller.abort();
  }, [symbol, seconds]);

  const bars = useMemo(() => {
    const normalized = symbol.toUpperCase();
    const merged = [...history, ...rows.filter(row => String(row?.symbol || normalized).toUpperCase() === normalized)
      .map(row => ({ ...row, options_at: row.options_at ?? row.timestamp }))];
    return averagePriceBars(merged, seconds, Number.MAX_SAFE_INTEGER);
  }, [history, rows, seconds, symbol]);
  const indexed = useMemo(() => indexGreekExposures(bars), [bars]);
  const width = Math.max(viewportWidth, bars.length * 13 + 100), height = 520, left = 56, right = 18, top = 28, bottom = 48;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const x = index => left + index * plotWidth / Math.max(1, bars.length - 1);
  const y = value => top + (100 - value) * plotHeight / 200;
  const ticks = useMemo(() => {
    const step = Math.max(1, Math.ceil(130 / Math.max(1, plotWidth / Math.max(1, bars.length - 1))));
    const result = bars.map((_, index) => index).filter(index => index % step === 0);
    if (bars.length && result.at(-1) !== bars.length - 1 && x(bars.length - 1) - x(result.at(-1)) >= 110) result.push(bars.length - 1);
    return result;
  }, [bars, plotWidth]);
  const paths = useMemo(() => Object.fromEntries(EXPOSURE_LINES.map(line => {
    let path = "", drawing = false;
    indexed[line.key].forEach((value, index) => {
      if (value == null) { drawing = false; return; }
      path += `${drawing ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
      drawing = true;
    });
    return [line.key, path];
  })), [indexed, plotWidth, bars.length]);
  const selectedIndex = hover ?? bars.length - 1, selected = bars[selectedIndex];
  const complete = bars.filter(bar => bar.is_confirmed && EXPOSURE_LINES.every(line => Number.isFinite(Number(bar[line.field])) && bar[line.field] != null)).length;

  const sync = source => {
    for (const target of [plotRef.current, topRef.current, bottomRef.current]) if (target && target !== source) target.scrollLeft = source.scrollLeft;
  };
  const loadEarlier = async () => {
    if (loadingRef.current || !hasEarlier || !history.length) return;
    loadingRef.current = true;
    const plot = plotRef.current;
    anchorRef.current = plot ? { width: plot.scrollWidth, left: plot.scrollLeft } : null;
    try {
      const result = await fetchWallPriceSeries(symbol, seconds * 150, seconds, undefined, history[0].timestamp);
      const incoming = result.rows || [];
      setHistory(current => [...new Map([...incoming, ...current].map(row => [row.timestamp, row])).values()]
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)));
      if (!incoming.length || result.has_more === false) setHasEarlier(false);
    } catch {
      anchorRef.current = null;
      setLoadState("live-only");
    } finally { loadingRef.current = false; }
  };
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
    if (!plot) return;
    const observer = new ResizeObserver(() => setViewportWidth(plot.clientWidth));
    observer.observe(plot); setViewportWidth(plot.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || anchorRef.current || !followRef.current || !bars.length) return;
    requestAnimationFrame(() => {
      const next = plotRef.current;
      if (next && followRef.current) { next.scrollLeft = next.scrollWidth - next.clientWidth; sync(next); primedRef.current = true; }
    });
  }, [bars.length, timeframe, width]);

  return <section className="greek-exposure-chart" aria-label={`${symbol} four-Greek exposure index`}>
    <nav className="greek-exposure-time-rail" aria-label={`${symbol} exposure candle size`}><b>TIME</b>{Object.keys(TIMEFRAMES).map(label => <button type="button" key={label} className={timeframe === label ? "active" : ""} aria-pressed={timeframe === label} onClick={() => setTimeframe(label)}>{label}</button>)}</nav>
    <div className="greek-exposure-panel">
    <header><div><span>{symbol} · OPTIONS EXPOSURE INDEX</span><h3>Delta · Gamma · Charm · Speed</h3></div><small>OI-BASED PROXY · NOT OBSERVED DEALER INVENTORY</small></header>
    <div className="greek-exposure-toolbar"><span>{complete < 10 ? `WARMING · ${complete}/10 CONFIRMED FOUR-GREEK CANDLES` : `${complete} CONFIRMED FOUR-GREEK CANDLES`}</span></div>
    <div className="greek-exposure-legend">{EXPOSURE_LINES.map(line => <span key={line.key}><i style={{ background: line.color }}/>{line.key.toUpperCase()}</span>)}</div>
    <div className="greek-exposure-top-scroll" ref={topRef} onScroll={event => sync(event.currentTarget)} aria-label="Exposure graph top scrollbar"><div style={{ width }}/></div>
    <div className="greek-exposure-viewport" ref={plotRef} onScroll={event => { const node = event.currentTarget; sync(node); if (primedRef.current) { followRef.current = node.scrollLeft >= node.scrollWidth - node.clientWidth - 20; if (node.scrollLeft < 60) loadEarlier(); } }} onPointerMove={event => {
      const bounds = event.currentTarget.getBoundingClientRect(), position = event.clientX - bounds.left + event.currentTarget.scrollLeft;
      if (bars.length) setHover(Math.max(0, Math.min(bars.length - 1, Math.round((position - left) / plotWidth * Math.max(1, bars.length - 1)))));
    }} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={`${symbol} indexed Delta Gamma Charm and Speed exposures`}>
        <rect width={width} height={height} fill="#000"/>
        {[-100, -50, 0, 50, 100].map(value => <g key={value}><line x1={left} x2={width-right} y1={y(value)} y2={y(value)} stroke={value === 0 ? "#54717e" : "#213b49"}/><text x={left-8} y={y(value)+4} textAnchor="end" className="greek-exposure-axis-label">{value > 0 ? `+${value}` : value}</text></g>)}
        {ticks.map(index => <g key={index}><line x1={x(index)} x2={x(index)} y1={top} y2={height-bottom} stroke="#173341"/><text x={x(index)} y={height-23} textAnchor="middle" className="greek-exposure-axis-label">{axisTime(bars[index].timestamp)}</text><text x={x(index)} y={height-9} textAnchor="middle" className="greek-exposure-date-label">{axisDate(bars[index].timestamp)}</text></g>)}
        {EXPOSURE_LINES.map(line => <path key={line.key} d={paths[line.key]} fill="none" stroke={line.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"/>)}
        {selected && <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={top} y2={height-bottom} stroke="#d4edf5" strokeDasharray="3 5"/>}
      </svg>
    </div>
    <div className="greek-exposure-bottom-scroll" ref={bottomRef} onScroll={event => sync(event.currentTarget)} aria-label="Exposure graph bottom scrollbar"><div style={{ width }}/></div>
    <div className="greek-exposure-readout"><strong>{selected ? `${axisTime(selected.timestamp)} ET · ${symbol} ${Number(selected.close).toFixed(2)}` : loadState === "loading" ? "LOADING EXPOSURES" : "WAITING FOR OPTIONS SNAPSHOTS"}</strong>{EXPOSURE_LINES.map(line => <span key={line.key} style={{ color: line.color }} title={line.unit}>{line.key.toUpperCase()} <b>{indexed[line.key][selectedIndex] == null ? "—" : `${indexed[line.key][selectedIndex] > 0 ? "+" : ""}${indexed[line.key][selectedIndex].toFixed(0)}`}</b><small>RAW {rawLabel(selected?.[line.field])}</small></span>)}</div>
    <footer>Each line is independently scaled to its prior 150 completed candles (90th-percentile absolute exposure; 10-candle minimum). Zero and sign are preserved. Historical gaps remain blank until archived ThetaData Greeks and daily open interest are backfilled. No price prediction or dealer-position claim.</footer>
    </div>
  </section>;
}
