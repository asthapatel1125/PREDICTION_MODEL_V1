import { useEffect, useRef, useState } from "react";
import { fetchAlerts, startLiveEngine, stopLiveEngine, subscribeToAlerts } from "./api";
const greeks = [
    ["Gamma", "+0.084", 76, "positive"], ["Vanna", "+0.119", 84, "positive"],
    ["Charm", "+0.096", 71, "positive"], ["Vomma", "+0.213", 88, "energy"],
    ["Veta", "−0.071", 44, "negative"], ["Speed", "+0.142", 68, "energy"],
    ["Zomma", "+0.127", 62, "energy"], ["Color", "+0.168", 81, "energy"],
    ["Ultima", "+0.224", 93, "energy"],
];
const demoAlerts = [
    { time: "10:42:18", symbol: "QQQ", direction: "UP", price: "482.16", explosion: "0.84", score: "+3", regime: "EXPANSION", result: "SUCCESS", precision: "0.91" },
    { time: "10:17:04", symbol: "QQQ", direction: "UP", price: "481.62", explosion: "0.78", score: "+3", regime: "HEDGING ACTIVE", result: "SUCCESS", precision: "0.86" },
    { time: "09:58:31", symbol: "NQ", direction: "DOWN", price: "20,184.25", explosion: "0.73", score: "−2", regime: "GAMMA UNSTABLE", result: "FAILURE", precision: "0.42" },
    { time: "09:41:12", symbol: "QQQ", direction: "UP", price: "480.94", explosion: "0.69", score: "+2", regime: "EXPANSION", result: "SUCCESS", precision: "0.79" },
];
function Icon({ children }) { return <span className="icon" aria-hidden="true">{children}</span>; }
function Sparkline({ values, color = "#4de0bd", fill = true }) {
    const ref = useRef(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas)
            return;
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return;
        ctx.scale(dpr, dpr);
        const min = Math.min(...values), max = Math.max(...values), pad = 4;
        const pts = values.map((v, i) => [pad + i * (width - pad * 2) / (values.length - 1), height - pad - (v - min) / (max - min || 1) * (height - pad * 2)]);
        if (fill) {
            const grad = ctx.createLinearGradient(0, 0, 0, height);
            grad.addColorStop(0, color + "44");
            grad.addColorStop(1, color + "00");
            ctx.beginPath();
            ctx.moveTo(pts[0][0], height);
            pts.forEach(p => ctx.lineTo(p[0], p[1]));
            ctx.lineTo(pts.at(-1)[0], height);
            ctx.fillStyle = grad;
            ctx.fill();
        }
        ctx.beginPath();
        pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.stroke();
    }, [values, color, fill]);
    return <canvas className="sparkline" ref={ref} aria-label="Recent trend chart"/>;
}
function PriceChart() {
    const ref = useRef(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas)
            return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const c = canvas.getContext("2d");
        if (!c)
            return;
        c.scale(dpr, dpr);
        const values = [480.82, 480.91, 480.87, 481.02, 481.14, 481.09, 481.23, 481.18, 481.31, 481.44, 481.39, 481.55, 481.48, 481.68, 481.62, 481.81, 481.76, 481.92, 482.05, 482.01, 482.18, 482.12, 482.31, 482.44, 482.37, 482.54, 482.61, 482.73];
        const min = 480.7, max = 482.9, left = 10, right = 58, top = 12, bottom = 22;
        c.font = "11px ui-monospace";
        c.fillStyle = "#657286";
        c.strokeStyle = "#182231";
        c.lineWidth = 1;
        for (let i = 0; i < 5; i++) {
            const y = top + i * (h - top - bottom) / 4;
            c.beginPath();
            c.moveTo(left, y);
            c.lineTo(w - right, y);
            c.stroke();
            c.fillText((max - i * (max - min) / 4).toFixed(2), w - right + 8, y + 4);
        }
        const xy = values.map((v, i) => [left + i * (w - left - right) / (values.length - 1), top + (max - v) / (max - min) * (h - top - bottom)]);
        const grad = c.createLinearGradient(0, top, 0, h - bottom);
        grad.addColorStop(0, "rgba(77,224,189,.26)");
        grad.addColorStop(1, "rgba(77,224,189,0)");
        c.beginPath();
        c.moveTo(xy[0][0], h - bottom);
        xy.forEach(p => c.lineTo(p[0], p[1]));
        c.lineTo(xy.at(-1)[0], h - bottom);
        c.fillStyle = grad;
        c.fill();
        c.beginPath();
        xy.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
        c.strokeStyle = "#4de0bd";
        c.lineWidth = 2;
        c.stroke();
        const highY = top + (max - 482.46) / (max - min) * (h - top - bottom);
        c.setLineDash([5, 5]);
        c.strokeStyle = "#d8b45c88";
        c.beginPath();
        c.moveTo(left, highY);
        c.lineTo(w - right, highY);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = "#d8b45c";
        c.fillText("RANGE HIGH 482.46", left + 8, highY - 7);
        c.fillStyle = "#4de0bd";
        c.beginPath();
        c.arc(xy.at(-1)[0], xy.at(-1)[1], 4, 0, Math.PI * 2);
        c.fill();
    }, []);
    return <canvas ref={ref} className="price-chart" aria-label="QQQ intraday price and micro-range breakout chart"/>;
}
function ModulePage({ view, notify, alerts }) {
    const [speed, setSpeed] = useState(10);
    const [query, setQuery] = useState("");
    const [formula, setFormula] = useState("Balanced pressure v4");
    const title = { "Live Monitor": "Live pressure monitor", "Historical Replay": "Historical replay", "Performance": "Performance analytics", "Logbook": "Logbook explorer", "Configuration": "Configuration manager", "Research Lab": "Research lab", "System": "System monitoring" }[view] || view;
    const subtitle = { "Live Monitor": "Streaming Greeks, dealer pressure, and synchronized signal state.", "Historical Replay": "Reconstruct any session through the production decision pipeline.", "Performance": "Calibrate confidence and understand every success and failure mode.", "Logbook": "Search, compare, tag, and audit every pressure event.", "Configuration": "Versioned thresholds, profiles, risk limits, and instant rollback.", "Research Lab": "Replace formulas, sweep parameters, and replay experiments safely.", "System": "Latency, queues, persistence, and streaming infrastructure health." }[view] || "";
    if (view === "Live Monitor")
        return <><div className="page-head module-title"><div><div className="eyebrow">STREAMING DESK</div><h1>{title}</h1><p>{subtitle}</p></div><button className="primary-action" onClick={() => notify("Live workspace layout saved")}>Save workspace</button></div><div className="monitor-grid"><article className="panel monitor-chart"><header className="panel-head"><div><span>PRESSURE WATERFALL</span><h2>Multi-timeframe signal synchronization</h2></div><span className="live-chip">● LIVE · 12 ms</span></header><PriceChart /><div className="timeframe-row">{["5s", "10s", "30s", "1m", "3m", "5m", "15m"].map((x, i) => <div key={x}><span>{x}</span><i style={{ height: `${28 + i * 5}px` }}/><b>{i < 5 ? "↑" : "↗"}</b></div>)}</div></article><article className="panel gauge-panel"><header className="panel-head"><div><span>DEALER HEDGE DEMAND</span><h2>Signed pressure</h2></div></header><div className="big-gauge"><div><b>+0.78</b><span>BUY PRESSURE</span></div></div><div className="signal-stack"><span><b>Gamma</b><i style={{ width: "84%" }}/></span><span><b>Charm</b><i style={{ width: "71%" }}/></span><span><b>Vanna</b><i style={{ width: "88%" }}/></span></div></article><article className="panel feed-panel"><header className="panel-head"><div><span>SIGNAL TIMELINE</span><h2>Decision events</h2></div></header>{["Pressure acceleration detected", "Gamma · Vanna · Charm aligned", "Micro-range high tested", "Breakout confirmed · alert fired", "Outcome evaluation pending"].map((x, i) => <div className="timeline-event" key={x}><i className={i === 3 ? "hot-event" : ""}/><span>{`10:4${i}:1${i}`}</span><b>{x}</b></div>)}</article></div></>;
    if (view === "Historical Replay")
        return <><div className="page-head module-title"><div><div className="eyebrow">RESEARCH REPLAY</div><h1>{title}</h1><p>{subtitle}</p></div><button className="primary-action" onClick={() => notify("Replay configuration queued")}>Run replay</button></div><article className="panel replay-stage"><div className="replay-toolbar"><button>◀</button><button className="play">▶</button><button>▶|</button><label>Speed <input type="range" min="1" max="100" value={speed} onChange={e => setSpeed(+e.target.value)}/><b>{speed}×</b></label><span>QQQ · Jul 15, 2026 · 09:30—16:00 ET</span></div><PriceChart /><div className="scrubber"><i style={{ width: "43%" }}/><button style={{ left: "43%" }} aria-label="Replay position"/></div><div className="replay-events"><span style={{ left: "18%" }}>▲ ALERT</span><span style={{ left: "43%" }}>▲ ALERT</span><span className="failure-mark" style={{ left: "67%" }}>▼ FAILED</span></div></article><div className="metric-grid replay-metrics"><article className="metric"><header><span>BARS PROCESSED</span></header><div className="metric-main"><b>18,420</b></div><footer><span>Pipeline latency</span><b>2.8 ms</b></footer></article><article className="metric"><header><span>ALERTS GENERATED</span></header><div className="metric-main"><b>34</b></div><footer><span>Frequency</span><b>1 / 541 bars</b></footer></article><article className="metric"><header><span>REPLAY PRECISION</span></header><div className="metric-main"><b>81.2%</b></div><footer><span>Calibration error</span><b>0.043</b></footer></article><article className="metric"><header><span>LOOK-AHEAD AUDIT</span></header><div className="metric-main"><b className="teal">PASS</b></div><footer><span>Future reads</span><b>0</b></footer></article></div></>;
    if (view === "Performance")
        return <><div className="page-head module-title"><div><div className="eyebrow">META ENGINE</div><h1>{title}</h1><p>{subtitle}</p></div><div className="date-filter">Last 30 days⌄</div></div><div className="performance-grid"><article className="panel precision-card"><header className="panel-head"><div><span>PRECISION OVER TIME</span><h2>Outcome quality · 30 day rolling</h2></div></header><div className="large-spark"><Sparkline values={[58, 63, 61, 65, 68, 67, 72, 74, 71, 76, 78, 75, 79, 81, 79, 82, 84, 81, 85, 86]} color="#86a7ff"/></div></article><article className="panel confusion"><header className="panel-head"><div><span>CONFUSION MATRIX</span><h2>Direction classification</h2></div></header><div className="matrix"><div className="strong"><b>184</b><span>True up</span></div><div><b>31</b><span>False up</span></div><div><b>24</b><span>False down</span></div><div className="strong"><b>167</b><span>True down</span></div></div></article><article className="panel segment-card"><header className="panel-head"><div><span>PRECISION BY REGIME</span><h2>Market context</h2></div></header>{[["EXPANSION", 86], ["HEDGING ACTIVE", 81], ["TRENDING", 78], ["CALM", 69], ["GAMMA UNSTABLE", 57]].map(x => <div className="segment" key={x[0]}><span>{x[0]}</span><i><b style={{ width: `${x[1]}%` }}/></i><strong>{x[1]}%</strong></div>)}</article><article className="panel failure-card"><header className="panel-head"><div><span>FAILURE MODES</span><h2>Root-cause distribution</h2></div></header>{[["Snapback breakout", 31], ["Pressure collapse", 24], ["Direction conflict", 19], ["Liquidity hole", 14], ["Regime flip", 12]].map(x => <div className="failure-row" key={x[0]}><span>{x[0]}</span><b>{x[1]}%</b></div>)}</article></div></>;
    if (view === "Logbook")
        return <><div className="page-head module-title"><div><div className="eyebrow">AUDIT TRAIL</div><h1>{title}</h1><p>{subtitle}</p></div><button className="primary-action" onClick={() => notify("CSV export prepared")}>Export CSV</button></div><div className="searchbar"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search symbol, regime, reasoning, or tag…"/><button>Regime⌄</button><button>Profile⌄</button><button>Outcome⌄</button></div><article className="panel logbook-list">{alerts.filter(a => JSON.stringify(a).toLowerCase().includes(query.toLowerCase())).map((a, i) => <details key={i}><summary><span>{a.time}</span><b>{a.symbol}</b><span className={`direction-pill ${a.direction.toLowerCase()}`}>{a.direction}</span><span>{a.regime}</span><span>Explosion {a.explosion}</span><span className={`result ${a.result.toLowerCase()}`}>{a.result}</span><strong>{a.precision}</strong></summary><div className="reasoning-grid"><div><small>PRESSURE THESIS</small><p>Ultima and Color accelerated while Gamma, Vanna, and Charm maintained directional sign agreement.</p></div><div><small>PRICE CONFIRMATION</small><p>Micro-range boundary cleared with no re-entry during the confirmation window.</p></div><div><small>RECOMMENDATION</small><p>Retain threshold; this setup remains well calibrated in expansion regimes.</p></div></div></details>)}</article></>;
    if (view === "Configuration")
        return <><div className="page-head module-title"><div><div className="eyebrow">VERSIONED CONTROL</div><h1>{title}</h1><p>{subtitle}</p></div><button className="primary-action" onClick={() => notify("Configuration v1.4.3 saved as draft")}>Save new version</button></div><div className="config-grid"><article className="panel version-list"><header className="panel-head"><div><span>CONFIGURATION HISTORY</span><h2>Versions</h2></div></header>{["v1.4.2 · Active", "v1.4.1 · Jul 14", "v1.4.0 · Jul 09", "v1.3.8 · Jun 28"].map((x, i) => <button className={i === 0 ? "selected" : ""} key={x}><b>{x}</b><span>{i === 0 ? "Precision 78.6%" : "Archived"}</span></button>)}</article><article className="panel config-editor"><header className="panel-head"><div><span>NORMAL SESSION</span><h2>Adaptive alert thresholds</h2></div><span className="unsaved">● 2 changes</span></header>{[["Explosion minimum", 58], ["Confidence minimum", 68], ["Risk ceiling", 72], ["Volatility multiplier", 40]].map(x => <label className="config-control" key={x[0]}><span>{x[0]}<small>Bounded by institutional risk policy</small></span><input type="range" defaultValue={x[1]}/><b>{(+x[1] / 100).toFixed(2)}</b></label>)}<div className="config-actions"><button onClick={() => notify("Diff view opened")}>Compare with v1.4.1</button><button onClick={() => notify("Rolled back safely")}>Rollback</button></div></article></div></>;
    if (view === "Research Lab")
        return <><div className="page-head module-title"><div><div className="eyebrow">SANDBOXED EXPERIMENTS</div><h1>{title}</h1><p>{subtitle}</p></div><button className="primary-action" onClick={() => notify("Experiment queued on historical workers")}>Run experiment</button></div><div className="research-grid"><article className="panel formula-panel"><header className="panel-head"><div><span>FORMULA</span><h2>ExplosionScore candidate</h2></div><select value={formula} onChange={e => setFormula(e.target.value)}><option>Balanced pressure v4</option><option>Ultima-weighted v2</option><option>Low-noise open v1</option></select></header><pre><code>{`energy = Σ robust_z(|greek|) × weight\nacceleration = tanh(curvature_ratio - 1)\nscore = clamp(energy + 0.08 × acceleration)`}</code></pre><div className="weight-grid">{["Vomma 16%", "Ultima 18%", "Veta 10%", "Gamma 13%", "Speed 13%", "Zomma 11%", "Color 11%", "Charm 8%"].map(x => <span key={x}>{x}</span>)}</div></article><article className="panel experiment-result"><header className="panel-head"><div><span>CANDIDATE VS CONTROL</span><h2>Out-of-sample result</h2></div></header><div className="uplift"><b>+4.8%</b><span>precision uplift</span></div><Sparkline values={[48, 53, 51, 58, 62, 60, 66, 71, 69, 74, 77, 81]} color="#4de0bd"/><div className="experiment-stats"><span>False positives <b>−12.4%</b></span><span>Recall <b>+1.7%</b></span><span>Calibration <b>0.038</b></span></div></article></div></>;
    return <><div className="page-head module-title"><div><div className="eyebrow">PLATFORM OPERATIONS</div><h1>{title}</h1><p>{subtitle}</p></div><span className="health-banner">● ALL SYSTEMS OPERATIONAL</span></div><div className="health-grid">{[["API gateway", "8 ms", 99], ["ThetaData stream", "12 ms", 98], ["Decision pipeline", "2.8 ms", 94], ["PostgreSQL", "4 ms", 97], ["WebSocket fanout", "1.2 ms", 99], ["Replay workers", "3 / 4", 75]].map(x => <article className="panel health-card" key={x[0]}><span>{x[0]}</span><b>{x[1]}</b><i><em style={{ width: `${x[2]}%` }}/></i><small>Healthy · p99 within SLO</small></article>)}</div><article className="panel system-chart"><header className="panel-head"><div><span>PROCESSING LATENCY</span><h2>End-to-end · last 60 minutes</h2></div></header><Sparkline values={[9, 11, 8, 12, 10, 9, 14, 11, 10, 9, 8, 12, 10, 9, 11, 13, 10, 8, 9, 12]} color="#86a7ff"/></article></>;
}
export default function Home() {
    const [mode, setMode] = useState("Live engine");
    const [symbol, setSymbol] = useState("QQQ");
    const [running, setRunning] = useState(false);
    const [seconds, setSeconds] = useState(14);
    const [tableFilter, setTableFilter] = useState("All alerts");
    const [toast, setToast] = useState("");
    const [view, setView] = useState("Overview");
    const [alerts, setAlerts] = useState(demoAlerts);
    const [backendOnline, setBackendOnline] = useState(false);
    useEffect(() => { if (!running)
        return; const id = setInterval(() => setSeconds(v => (v + 1) % 60), 1000); return () => clearInterval(id); }, [running]);
    useEffect(() => {
        const controller = new AbortController();
        fetchAlerts(controller.signal)
            .then(rows => { setAlerts(rows); setBackendOnline(true); })
            .catch(() => setBackendOnline(false));
        const unsubscribe = subscribeToAlerts(alert => setAlerts(current => [alert, ...current.filter(item => item.time !== alert.time || item.symbol !== alert.symbol)].slice(0, 100)), setBackendOnline);
        return () => { controller.abort(); unsubscribe(); };
    }, []);
    const notify = (text) => { setToast(text); window.setTimeout(() => setToast(""), 2200); };
    const toggleLiveEngine = async () => {
        if (!backendOnline) {
            notify("Connect the Render API before starting the live engine");
            return;
        }
        try {
            if (running) {
                await stopLiveEngine();
                setRunning(false);
                notify("Live engine stopping");
            }
            else {
                await startLiveEngine(symbol, 5);
                setRunning(true);
                notify(`Live engine started for ${symbol}`);
            }
        }
        catch (error) {
            notify(error instanceof Error ? error.message : "Engine request failed");
        }
    };
    return <main className="workspace">
    <header className="topbar">
      <div className="brand"><div className="brandmark"><span /><span /><span /></div><div><b>AXIOM</b><small>PRESSURE INTELLIGENCE</small></div></div>
      <nav className="mode-switch" aria-label="Engine mode">
        {["Live engine", "Training replay"].map(item => <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item === mode && <i />}{item}</button>)}
      </nav>
      <div className="header-actions">
        <div className="feed"><i className={backendOnline ? "pulse" : ""}/><span>API</span><b>{backendOnline ? "CONNECTED" : "DEMO"}</b><small>{backendOnline ? "SYNC" : "LOCAL"}</small></div>
        <button className="square" aria-label="Notifications" onClick={() => notify("No unread system notices")}>⌁</button>
        <button className="avatar" aria-label="User menu">AK</button>
      </div>
    </header>

    <aside className="sidebar">
      <div className="side-top">
        {[['Overview', '◫'], ['Live Monitor', '⌁'], ['Historical Replay', '◷'], ['Performance', '↗'], ['Logbook', '⌬'], ['Configuration', '◌'], ['Research Lab', '⌁'], ['System', '⌘']].map(([name, icon]) => <button key={name} className={`navitem ${view === name ? 'active' : ''}`} onClick={() => setView(name)}><Icon>{icon}</Icon><span>{name}</span>{name === 'Live Monitor' && <em>3</em>}</button>)}
      </div>
      <div className="side-bottom"><button className="navitem"><Icon>⚙</Icon><span>Settings</span></button><div className="system-health"><span><i />System healthy</span><small>v1.4.2 · NYC-1</small></div></div>
    </aside>

    <section className="content">
      {view !== "Overview" ? <ModulePage view={view} notify={notify} alerts={alerts}/> : <>
      <div className="page-head">
        <div><div className="eyebrow">TRADING COMMAND</div><h1>Pressure intelligence</h1><p>Options Greeks lead. Price confirms.</p></div>
        <div className="controls">
          <label>Instrument<select value={symbol} onChange={e => setSymbol(e.target.value)}><option>QQQ</option><option>NQ</option></select></label>
          <label>Timeframe<select defaultValue="1m"><option>15s</option><option>1m</option><option>5m</option></select></label>
          <button className={running ? "stop" : "start"} onClick={toggleLiveEngine}><i />{running ? "Stop engine" : "Start engine"}</button>
        </div>
      </div>

      <div className="status-strip">
        <div><span>MARKET</span><b>OPEN</b><small>Closes in 5h 17m</small></div>
        <div><span>PROFILE</span><strong>◉ NORMAL</strong><small>Auto-selected</small></div>
        <div><span>REGIME</span><strong className="teal">EXPANSION</strong><small>Confidence 87%</small></div>
        <div><span>MICRO-RANGE</span><strong>481.88 — 482.46</strong><small>8 min · 0.12%</small></div>
        <div><span>LAST UPDATE</span><strong>10:46:{seconds.toString().padStart(2, "0")}</strong><small>America/New_York</small></div>
      </div>

      <div className="metric-grid">
        <article className="metric hero-metric"><header><span>EXPLOSION SCORE</span><span className="badge hot">HIGH ENERGY</span></header><div className="metric-main"><b>0.84</b><span><strong>+0.09</strong> past 5m</span></div><Sparkline values={[28, 31, 29, 37, 40, 44, 42, 51, 58, 55, 67, 72, 68, 78, 84]}/><footer><span>Dynamic threshold</span><b>0.57</b></footer></article>
        <article className="metric"><header><span>DIRECTION SCORE</span><span className="badge up">STRONG UP</span></header><div className="direction"><b>+3</b><div><span>Gamma <i className="dot green"/></span><span>Vanna <i className="dot green"/></span><span>Charm <i className="dot green"/></span></div></div><div className="clarity"><span>Direction clarity</span><b>ALIGNED</b></div><footer><span>Stable for</span><b>4m 12s</b></footer></article>
        <article className="metric"><header><span>LIVE PRECISION</span><span className="subtle">30D</span></header><div className="metric-main"><b>78.6%</b><span><strong>+4.2%</strong> vs prior</span></div><Sparkline values={[59, 62, 61, 64, 66, 65, 69, 68, 71, 74, 73, 76, 77, 76, 79]} color="#86a7ff"/><footer><span>Evaluated alerts</span><b>214</b></footer></article>
        <article className="metric"><header><span>PRESSURE STATE</span><span className="subtle">LIVE</span></header><div className="pressure-state"><i /><div><b>BUILDING</b><span>Volatility curvature accelerating</span></div></div><div className="pressure-bars"><span style={{ width: "82%" }}/><span style={{ width: "64%" }}/><span style={{ width: "91%" }}/></div><footer><span>Confirmation</span><b className="gold">BREAKOUT</b></footer></article>
      </div>

      <div className="main-grid">
        <article className="panel chart-panel">
          <header className="panel-head"><div><span>PRICE CONFIRMATION</span><h2>{symbol} · Intraday pressure map</h2></div><div className="legend"><span><i className="line teal-line"/>Price</span><span><i className="dash"/>Micro-range</span><button aria-label="Expand chart" onClick={() => notify("Chart focus mode ready")}>⛶</button></div></header>
          <PriceChart />
          <div className="chart-foot"><div><span>CURRENT</span><b>{symbol === "QQQ" ? "482.73" : "20,228.75"}</b><strong>+0.47%</strong></div><div><span>BREAKOUT</span><b className="teal">+0.27</b><small>above range</small></div><div><span>REALIZED VOL</span><b>18.4%</b><small>1.12× baseline</small></div><div><span>EXPECTED MOVE</span><b>0.41</b><small>1.0× vol</small></div></div>
        </article>

        <article className="panel greeks-panel">
          <header className="panel-head"><div><span>GREEKS PRESSURE</span><h2>Live exposure matrix</h2></div><button className="mini-select">1m⌄</button></header>
          <div className="greeks-list">{greeks.map(([name, value, width, tone]) => <div className="greek" key={name}><span>{name}</span><div className="track"><i className={tone} style={{ width: `${width}%` }}/></div><b className={value.startsWith("−") ? "neg" : ""}>{value}</b></div>)}</div>
          <div className="alignment"><i>✓</i><div><b>Directional alignment confirmed</b><span>Gamma, Vanna & Charm share positive sign</span></div></div>
        </article>
      </div>

      <article className="panel alerts-panel">
        <header className="panel-head table-head"><div><span>ALERT LOGBOOK</span><h2>Recent pressure events</h2></div><div className="table-tabs">{["All alerts", "Success", "Failure"].map(x => <button className={tableFilter === x ? "active" : ""} onClick={() => setTableFilter(x)} key={x}>{x}</button>)}</div><button className="export" onClick={() => notify("Logbook export prepared")}>⇩ Export</button></header>
        <div className="table-wrap"><table><thead><tr><th>TIME</th><th>INSTRUMENT</th><th>DIRECTION</th><th>PRICE</th><th>EXPLOSION</th><th>DIR. SCORE</th><th>REGIME</th><th>RESULT</th><th>PRECISION</th></tr></thead><tbody>{alerts.filter(a => tableFilter === "All alerts" || a.result.toLowerCase() === tableFilter.toLowerCase()).map((a, i) => <tr key={i}><td>{a.time}</td><td><b>{a.symbol}</b></td><td><span className={`direction-pill ${a.direction.toLowerCase()}`}>{a.direction === "UP" ? "↑" : "↓"} {a.direction}</span></td><td>{a.price}</td><td><span className="score-dot"/>{a.explosion}</td><td className={a.score.includes("+") ? "teal" : "red"}>{a.score}</td><td><span className="regime-pill">{a.regime}</span></td><td><span className={`result ${a.result.toLowerCase()}`}>{a.result}</span></td><td><b>{a.precision}</b></td></tr>)}</tbody></table></div>
      </article>
      </>}
      <footer className="disclaimer">Signal intelligence only · No broker execution enabled <span>Data latency 12 ms · Last config tune Jul 15, 18:42</span></footer>
    </section>
    {toast && <div className="toast" role="status">✓ {toast}</div>}
  </main>;
}
