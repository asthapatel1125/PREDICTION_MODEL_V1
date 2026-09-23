const PRODUCTION_API_URL = "https://prediction-model-v1.onrender.com";
const baseUrl = () => {
  const configured = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
  if (configured && !configured.includes("localhost")) return configured;
  // A Vercel build must not inherit the local development endpoint.  Keep
  // localhost for local development, but use the deployed API in production.
  return import.meta.env.DEV ? configured : PRODUCTION_API_URL;
};

async function request(path, options = {}) {
  if (!baseUrl()) throw new Error("VITE_API_URL is not configured");
  const response = await fetch(`${baseUrl()}${path}`, { cache: "no-store", ...options });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Axiom API returned ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

export function toDashboardAlert(alert) {
  return {
    id: alert.id,
    displayId: alert.display_id ?? null,
    timestamp: alert.timestamp,
    time: `${new Date(alert.timestamp).toLocaleTimeString("en-US", { timeZone:"America/New_York", hour12: true, hour:"2-digit", minute:"2-digit", second:"2-digit", fractionalSecondDigits:3 })} EST`,
    symbol: alert.symbol,
    direction: alert.direction,
    channel: alert.engine_mode,
    confidence: Number(alert.confidence ?? 0),
    rawPrice: Number(alert.price),
    price: Number(alert.price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    explosion: Number(alert.explosion_score).toFixed(2),
    score: alert.direction_score > 0 ? `+${alert.direction_score}` : `${alert.direction_score}`,
    regime: alert.regime.replaceAll("_", " "),
    profile: alert.profile.replaceAll("_", " "),
    result: alert.result ?? "PENDING",
    precision: alert.precision == null ? "—" : Number(alert.precision).toFixed(2),
    reasoning: alert.reasoning ?? [],
    recommendation: alert.recommended_action ?? "Monitor",
    risk: alert.risk_level,
    entry: alert.entry_price == null ? null : Number(alert.entry_price),
    invalidation: alert.invalidation_price == null ? null : Number(alert.invalidation_price),
    target: alert.target_price == null ? null : Number(alert.target_price),
    pressure: Number(alert.supporting_indicators?.pressure_score ?? 0),
    session: alert.supporting_indicators?.detected_session ?? "UNKNOWN",
    sessionState: alert.supporting_indicators?.session_state ?? "UNKNOWN",
    sessionConfidence: Number(alert.supporting_indicators?.transition_confidence ?? 0),
  };
}

export async function fetchDashboard(symbol, signal) {
  const data = await request(`/api/v1/dashboard/${encodeURIComponent(symbol)}?limit=1`, { signal });
  return { ...data, alerts: data.alerts.map(toDashboardAlert) };
}

export const fetchStateHistory = (symbol, limit = 5000, signal) =>
  request(`/api/v1/history/${encodeURIComponent(symbol)}?limit=${limit}`, { signal });

export const fetchDynamicsSessionHistory = (symbol, sessionDate, signal) =>
  request(`/api/v1/dynamics-session/${encodeURIComponent(symbol)}?session_date=${encodeURIComponent(sessionDate)}`, { signal });

export const fetchDynamicsHistory = (symbol, signal) =>
  request(`/api/v1/dynamics-history/${encodeURIComponent(symbol)}?limit=150000&display_bucket_seconds=60`, { signal });
export const fetchWallSpectrum = (symbol, signal, limit = null, end = null) =>
  request(`/api/v1/walls/spectrum?symbol=${encodeURIComponent(symbol)}${limit ? `&limit=${encodeURIComponent(limit)}` : ""}${end ? `&end=${encodeURIComponent(end)}` : ""}`, { signal });
const wallPriceSeriesRequests = new Map();
export const fetchWallPriceSeries = (symbol, windowSeconds, bucketSeconds, signal, before = null, exposureAverages = false) => {
  const path = `/api/v1/walls/price-series?symbol=${encodeURIComponent(symbol)}&window_seconds=${encodeURIComponent(windowSeconds)}&bucket_seconds=${encodeURIComponent(bucketSeconds)}${before ? `&before=${encodeURIComponent(before)}` : ""}${exposureAverages ? "&exposure_averages=true" : ""}`;
  if (!wallPriceSeriesRequests.has(path)) {
    wallPriceSeriesRequests.set(path, request(path).finally(() => wallPriceSeriesRequests.delete(path)));
  }
  return wallPriceSeriesRequests.get(path).then(result => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return result;
  });
};
const wallExposurePageRequests=new Map();
export function fetchWallExposurePoints(symbol,signal,before=null,limit=5000){
  const key=`${String(symbol).toUpperCase()}:${before||"latest"}:${limit}`;
  if(!wallExposurePageRequests.has(key))wallExposurePageRequests.set(key,request(`/api/v1/walls/exposure-points?symbol=${encodeURIComponent(symbol)}&limit=${encodeURIComponent(limit)}${before?`&before=${encodeURIComponent(before)}`:""}`).finally(()=>wallExposurePageRequests.delete(key)));
  return wallExposurePageRequests.get(key).then(result=>{if(signal?.aborted)throw new DOMException("Aborted","AbortError");return result});
}
export const fetchWallExposureCandles=(symbol,intervalSeconds,numCandles=150,signal,before=null)=>{
  const days=Math.min(365,Math.max(2,Math.ceil(intervalSeconds*numCandles/86400)+7));
  return request(`/api/v1/walls/exposure-candles?symbol=${encodeURIComponent(symbol)}&interval_seconds=${encodeURIComponent(intervalSeconds)}&days=${days}&limit=${Math.min(20000,numCandles)}${before?`&before=${encodeURIComponent(before)}`:""}`,{signal});
};
export const fetchWallBreaks = (symbol, signal) =>
  request(`/api/v1/walls/breaks?symbol=${encodeURIComponent(symbol)}`, { signal });
export const fetchWallDealerFlow = (symbol, signal) =>
  request(`/api/v1/walls/dealerflow?symbol=${encodeURIComponent(symbol)}`, { signal });
export const fetchWallSummaryHistory = (symbol, signal) =>
  request(`/api/v1/walls/summary-history?symbol=${encodeURIComponent(symbol)}`, { signal });
const wallHistoryCache=new Map();
function easternDateIso(date){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const value=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
export async function fetchWallDayLevels(symbol,sessionDate,signal,displayBucketSeconds=60,since=null,days=1){
  const path=(day,count=1)=>`/api/v1/walls/day-levels?symbol=${encodeURIComponent(symbol)}${day?`&session_date=${encodeURIComponent(day)}`:""}&display_bucket_seconds=${encodeURIComponent(displayBucketSeconds)}&days=${encodeURIComponent(count)}${since?`&since=${encodeURIComponent(since)}`:""}`;
  if(sessionDate||since||days<=1)return request(path(sessionDate),{signal});
  const key=`${symbol}:${days}:${displayBucketSeconds}`,cached=wallHistoryCache.get(key);
  if(cached&&Date.now()-cached.at<300000)return cached.value;
  // New backends can return the requested retained sessions in one query.
  // Keep the per-session fan-out for an older deployment, but always send an
  // ISO date; locale date strings are browser-dependent and FastAPI rejects
  // values such as 9/10/2026 for a `date` parameter.
  try{
    const combined=await request(path(null,days),{signal});
    const combinedDates=new Set((combined.rows||[]).map(row=>easternDateIso(new Date(row.timestamp))));
    if(combinedDates.size>1){wallHistoryCache.set(key,{at:Date.now(),value:combined});return combined}
  }catch(error){if(error.name==="AbortError")throw error}
  const dates=[];for(let offset=0;dates.length<days&&offset<days*3;offset++){const date=new Date();date.setDate(date.getDate()-offset);const easternDay=easternDateIso(date),weekday=new Date(`${easternDay}T12:00:00-04:00`).getDay();if(weekday!==0&&weekday!==6)dates.push(easternDay)}
  const results=await Promise.all(dates.map(day=>request(path(day),{signal}).catch(()=>({rows:[],phase_anchors:[]}))));
  const rows=[...new Map(results.flatMap(result=>result.rows||[]).map(row=>[row.timestamp,row])).values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  const value={symbol:symbol.toUpperCase(),rows,phase_anchors:results.flatMap(result=>result.phase_anchors||[]),display_bucket_seconds:displayBucketSeconds,days};wallHistoryCache.set(key,{at:Date.now(),value});return value;
}
export const fetchExposureHistoryRange=(symbol,signal)=>
  request(`/api/v1/walls/exposure-history-range?symbol=${encodeURIComponent(symbol)}`,{signal});
export async function fetchExposureHistorySnapshot(symbol,mapName,fromDate,toDate,signal){
  if(!baseUrl())throw new Error("VITE_API_URL is not configured");
  const query=new URLSearchParams({symbol,from_date:fromDate,to_date:toDate});
  const response=await fetch(`${baseUrl()}/api/v1/walls/exposure-history-snapshot/${encodeURIComponent(mapName)}?${query}`,{signal,cache:"no-store"});
  if(!response.ok)throw new Error(await response.text()||`Historical snapshot returned ${response.status}`);
  return response.blob();
}
export const fetchNasdaqRangeAtlas = (symbol, signal) =>
  request(`/api/v1/walls/nasdaq-range-atlas?symbol=${encodeURIComponent(symbol)}`, { signal });
export async function fetchEodSnapshot(symbol,module,mapName,sessionDate,signal){
  if(!baseUrl())throw new Error("VITE_API_URL is not configured");
  const query=new URLSearchParams({symbol,session_date:sessionDate});
  const response=await fetch(`${baseUrl()}/api/v1/eod-snapshots/${encodeURIComponent(module)}/${encodeURIComponent(mapName)}?${query}`,{signal,cache:"no-store"});
  if(!response.ok)throw new Error(await response.text()||`Snapshot request returned ${response.status}`);
  return response.blob();
}

export const fetchConfiguration = (signal) => request("/api/v1/configuration", { signal });
export const fetchSystem = (signal) => request("/api/v1/system", { signal });
export const fetchOutcomeAttribution = (symbol, signal) =>
  request(`/api/v1/outcome-attribution/${encodeURIComponent(symbol)}`, { signal });
export const fetchOutcomeCall = (callId, signal) =>
  request(`/api/v1/system-outcomes/${encodeURIComponent(callId)}`, { signal });
export const fetchInstruments = (signal) => request("/api/v1/instruments", { signal });
export const fetchChart = (symbol, intervalSeconds, before, signal) => {
  const query = new URLSearchParams({ interval_seconds: String(intervalSeconds), limit: "240" });
  if (before) query.set("before", before);
  return request(`/api/v1/chart/${encodeURIComponent(symbol)}?${query}`, { signal });
};

async function post(path, body) {
  return request(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const startLiveEngine = (symbol, resolutionSeconds = 5) =>
  post("/api/v1/live/start", { symbol, resolution_seconds: resolutionSeconds });
export const stopLiveEngine = () => post("/api/v1/live/stop");
export const setDynamicsDirectionGate = (mode) => post("/api/v1/dynamics/direction-gate", { mode });
export const startReplay = (body) => post("/api/v1/replay", body);
export const fetchReplay = (id, signal) => request(`/api/v1/replay/${id}`, { signal });

export function subscribeToEvents(onMessage, onStatus) {
  if (!baseUrl()) return () => undefined;
  let closed = false;
  let socket;
  let retry;
  const connect = () => {
    socket = new WebSocket(`${baseUrl().replace(/^http/, "ws")}/api/v1/stream`);
    socket.onopen = () => onStatus(true);
    socket.onerror = () => onStatus(false);
    socket.onclose = () => {
      onStatus(false);
      if (!closed) retry = window.setTimeout(connect, 2000);
    };
    socket.onmessage = (event) => {
      try { onMessage(JSON.parse(event.data)); } catch { /* ignore malformed events */ }
    };
  };
  connect();
  return () => { closed = true; window.clearTimeout(retry); socket?.close(); };
}
