const baseUrl = () => (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

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
    timestamp: alert.timestamp,
    time: new Date(alert.timestamp).toLocaleTimeString("en-US", { hour12: false }),
    symbol: alert.symbol,
    direction: alert.direction,
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
  };
}

export async function fetchDashboard(symbol, signal) {
  const data = await request(`/api/v1/dashboard/${encodeURIComponent(symbol)}?limit=100`, { signal });
  return { ...data, alerts: data.alerts.map(toDashboardAlert) };
}

export const fetchConfiguration = (signal) => request("/api/v1/configuration", { signal });
export const fetchSystem = (signal) => request("/api/v1/system", { signal });

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
