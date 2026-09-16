export const CHARMER_PERIODS = Array.from({ length: 29 }, (_, index) => index + 2);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function averagePriceBars(rows = [], bucketSeconds = 30) {
  const milliseconds = Math.max(1, bucketSeconds) * 1000;
  const clean = [...new Map(rows
    .filter(row => Number.isFinite(Date.parse(row?.timestamp || "")) && Number(row?.spot) > 0)
    .map(row => [row.timestamp, row])).values()]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const buckets = new Map();
  clean.forEach(row => {
    const at = Date.parse(row.timestamp), price = Number(row.spot), key = Math.floor(at / milliseconds);
    const bar = buckets.get(key);
    if (!bar) buckets.set(key, { timestamp: row.timestamp, at, spot: price, open: price, high: price, low: price, close: price, sum: price, samples: 1 });
    else {
      bar.timestamp = row.timestamp; bar.at = at; bar.high = Math.max(bar.high, price); bar.low = Math.min(bar.low, price);
      bar.close = price; bar.sum += price; bar.samples += 1; bar.spot = bar.sum / bar.samples;
    }
  });
  return [...buckets.values()].map(({ sum, ...bar }) => bar);
}

// Price-only Axiom Charmander. A three-point median rejects isolated bad
// ticks. One volatility-normalized moving-average slope is compressed by
// arctan, then spread across 29 progressively slower, horizon-scaled strands.
// This produces the nested above/below fan without contaminating it with
// option exposures.
export function computePriceCharmander(rows = []) {
  const clean = [...new Map(rows
    .filter(row => Number.isFinite(Date.parse(row?.timestamp || "")) && Number(row?.spot) > 0)
    .map(row => [row.timestamp, { timestamp: row.timestamp, price: Number(row.spot) }]))
    .values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const length = clean.length;
  const filteredPrices = Float64Array.from(clean, (point, index) => {
    if (index < 2) return point.price;
    return [clean[index - 2].price, clean[index - 1].price, point.price].sort((a, b) => a - b)[1];
  });
  const normalized = new Float64Array(length);
  const angle = new Float64Array(length);
  let mean = 0;
  let variance = 1e-8;
  let priceAverage = Math.log(filteredPrices[0] || 1);
  let slopeAverage = 0;
  const normalizationAlpha = 2 / 121;
  const priceAlpha = 2 / 13;

  for (let index = 1; index < length; index += 1) {
    const change = Math.log(filteredPrices[index] / filteredPrices[index - 1]);
    const priorMean = mean;
    mean += normalizationAlpha * (change - mean);
    variance = (1 - normalizationAlpha) * (variance + normalizationAlpha * (change - priorMean) ** 2);
    const logPrice = Math.log(filteredPrices[index]);
    priceAverage += priceAlpha * (logPrice - priceAverage);
    const priorAverage = index > 3 ? normalized[index - 3] : priceAverage;
    normalized[index] = priceAverage;
    const slope = (priceAverage - priorAverage) / Math.max(Math.sqrt(variance) * Math.sqrt(3), 1e-7);
    slopeAverage += .18 * (clamp(slope, -4, 4) - slopeAverage);
    angle[index] = clamp((2 / Math.PI) * Math.atan(2.8 * slopeAverage), -1, 1);
  }

  const series = CHARMER_PERIODS.map((period, periodIndex) => {
    const values = new Float32Array(length);
    const alpha = 2 / (period + 1);
    const amplitude = (periodIndex + 1) / CHARMER_PERIODS.length;
    let average = 0;
    for (let index = 0; index < length; index += 1) {
      average += alpha * (angle[index] - average);
      values[index] = amplitude * average;
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
