const baseUrl = () => (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
export function toDashboardAlert(alert) {
    const score = alert.direction_score > 0 ? `+${alert.direction_score}` : `${alert.direction_score}`;
    return {
        time: new Date(alert.timestamp).toLocaleTimeString("en-US", { hour12: false }),
        symbol: alert.symbol,
        direction: alert.direction,
        price: alert.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        explosion: alert.explosion_score.toFixed(2),
        score,
        regime: alert.regime.replaceAll("_", " "),
        result: "PENDING",
        precision: "—",
    };
}
export async function fetchAlerts(signal) {
    if (!baseUrl())
        throw new Error("VITE_API_URL is not configured");
    const response = await fetch(`${baseUrl()}/api/v1/alerts?limit=100`, { signal, cache: "no-store" });
    if (!response.ok)
        throw new Error(`Axiom API returned ${response.status}`);
    return (await response.json()).map(toDashboardAlert);
}
async function engineRequest(path, body) {
    if (!baseUrl())
        throw new Error("VITE_API_URL is not configured");
    const response = await fetch(`${baseUrl()}${path}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Axiom API returned ${response.status}`);
    }
}
export const startLiveEngine = (symbol, resolutionSeconds = 5) => engineRequest("/api/v1/live/start", { symbol, resolution_seconds: resolutionSeconds });
export const stopLiveEngine = () => engineRequest("/api/v1/live/stop");
export function subscribeToAlerts(onAlert, onStatus) {
    if (!baseUrl())
        return () => undefined;
    const socket = new WebSocket(`${baseUrl().replace(/^http/, "ws")}/api/v1/stream`);
    socket.onopen = () => onStatus(true);
    socket.onclose = () => onStatus(false);
    socket.onerror = () => onStatus(false);
    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.topic === "alert" && message.payload)
            onAlert(toDashboardAlert(message.payload));
    };
    return () => socket.close();
}
