export const EXPOSURE_LINES = [
  { key: "delta", field: "dex_signed_raw", color: "#ff5c8a", unit: "delta-dollar exposure" },
  { key: "gamma", field: "gamma_exposure_raw", color: "#4cc9f0", unit: "delta-dollar change per +1% spot" },
  { key: "charm", field: "charm_exposure_raw", color: "#8de05d", unit: "delta-dollar change per provider time unit" },
  { key: "speed", field: "speed_exposure_raw", color: "#ffae35", unit: "delta-dollar curvature per spot-point squared" },
];

const finite = value => value === null || value === undefined || value === "" ? NaN : Number(value);
const clamp = value => Math.max(-100, Math.min(100, value));
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted.length ? sorted[low] + (sorted[high] - sorted[low]) * (position - low) : NaN;
};

/** Point-in-time, per-Greek scaling. Zero and sign retain their raw meaning. */
export function indexGreekExposures(bars, { lookback = 150, minimumHistory = 10 } = {}) {
  const indexed = Object.fromEntries(EXPOSURE_LINES.map(line => [line.key, []]));
  for (const line of EXPOSURE_LINES) {
    const history = [];
    for (let index = 0; index < bars.length; index += 1) {
      const raw = finite(bars[index]?.[line.field]);
      const previous = history.slice(-lookback);
      const scale = previous.length >= minimumHistory ? percentile(previous, .9) : NaN;
      indexed[line.key].push(Number.isFinite(raw) && Number.isFinite(scale)
        ? scale > 0 ? clamp(raw / scale * 100) : raw === 0 ? 0 : null
        : null);
      // A forming candle is visible but must never train its own or a later
      // historical reference scale until the market confirms it.
      if (bars[index]?.is_confirmed && Number.isFinite(raw)) history.push(Math.abs(raw));
    }
  }
  return indexed;
}
