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
  const data = await request(`/api/v1/dashboard/${encodeURIComponent(symbol)}?limit=100`, { signal });
  return { ...data, alerts: data.alerts.map(toDashboardAlert) };
}

export const fetchStateHistory = (symbol, limit = 5000, signal) =>
  request(`/api/v1/history/${encodeURIComponent(symbol)}?limit=${limit}`, { signal });

export const fetchDynamicsSessionHistory = (symbol, sessionDate, signal) =>
  request(`/api/v1/dynamics-session/${encodeURIComponent(symbol)}?session_date=${encodeURIComponent(sessionDate)}`, { signal });

export const fetchDynamicsHistory = (symbol, signal) =>
  request(`/api/v1/dynamics-history/${encodeURIComponent(symbol)}`, { signal });
export const fetchWallSpectrum = (symbol, signal) =>
  request(`/api/v1/walls/spectrum?symbol=${encodeURIComponent(symbol)}`, { signal });
export const fetchWallBreaks = (symbol, signal) =>
  request(`/api/v1/walls/breaks?symbol=${encodeURIComponent(symbol)}`, { signal });
export const fetchWallDealerFlow = (symbol, signal) =>
  request(`/api/v1/walls/dealerflow?symbol=${encodeURIComponent(symbol)}`, { signal });
export const fetchWallSummaryHistory = (symbol, signal) =>
  request(`/api/v1/walls/summary-history?symbol=${encodeURIComponent(symbol)}`, { signal });
export const fetchWallDayLevels = (symbol, sessionDate, signal, displayBucketSeconds = 60, since = null) =>
  request(`/api/v1/walls/day-levels?symbol=${encodeURIComponent(symbol)}${sessionDate ? `&session_date=${encodeURIComponent(sessionDate)}` : ""}&display_bucket_seconds=${encodeURIComponent(displayBucketSeconds)}${since ? `&since=${encodeURIComponent(since)}` : ""}`, { signal });

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
