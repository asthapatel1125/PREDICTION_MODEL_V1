export const CHARMER_PERIODS = Array.from({ length: 29 }, (_, index) => index + 2);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

// Price-only Axiom Charmander. Price returns are normalized with an
// exponentially weighted mean/variance, compressed into a bounded angle, and
// passed through 29 zero-lag moving averages. It deliberately does not use a
// negative plot offset, so every value appears when it was actually known.
export function computePriceCharmander(rows = []) {
  const clean = [...new Map(rows
    .filter(row => Number.isFinite(Date.parse(row?.timestamp || "")) && Number(row?.spot) > 0)
    .map(row => [row.timestamp, { timestamp: row.timestamp, price: Number(row.spot) }]))
    .values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const length = clean.length;
  const normalized = new Float64Array(length);
  let mean = 0;
  let variance = 1e-8;
  const normalizationAlpha = 2 / 61;

  for (let index = 1; index < length; index += 1) {
    const change = Math.log(clean[index].price / clean[index - 1].price);
    const priorMean = mean;
    mean += normalizationAlpha * (change - mean);
    variance = (1 - normalizationAlpha) * (variance + normalizationAlpha * (change - priorMean) ** 2);
    normalized[index] = clamp((change - mean) / Math.max(Math.sqrt(variance), 1e-7), -8, 8);
  }

  const series = CHARMER_PERIODS.map(period => {
    const values = new Float32Array(length);
    const alpha = 2 / (period + 1);
    const lag = Math.max(1, Math.floor((period - 1) / 2));
    let average = 0;
    for (let index = 0; index < length; index += 1) {
      const lagged = normalized[Math.max(0, index - lag)];
      const zeroLagInput = normalized[index] + (normalized[index] - lagged);
      average += alpha * (zeroLagInput - average);
      values[index] = clamp((2 / Math.PI) * Math.atan(average), -1, 1);
    }
    return values;
  });

  return {
    timestamps: clean.map(point => point.timestamp),
    prices: Float64Array.from(clean, point => point.price),
    periods: CHARMER_PERIODS,
    series,
  };
}

export function charmPhase(value, previous) {
  if (!Number.isFinite(value) || !Number.isFinite(previous)) return "neutral";
  if (value >= 0) return value >= previous ? "positive_rising" : "positive_falling";
  return value <= previous ? "negative_falling" : "negative_rising";
}

