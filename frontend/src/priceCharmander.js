export const PHOENIX_PERIODS = Array.from({ length: 29 }, (_, index) => index + 2);

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
    if (!bar) buckets.set(key, { timestamp: row.timestamp, at, spot: price, open: price, high: price, low: price, close: price, prices: [price], samples: 1 });
    else {
      bar.timestamp = row.timestamp; bar.at = at; bar.high = Math.max(bar.high, price); bar.low = Math.min(bar.low, price);
      bar.close = price; bar.prices.push(price); bar.samples += 1;
    }
  });
  return [...buckets.values()].map(({ prices, ...bar }) => {
    const ordered = prices.sort((a, b) => a - b), trim = ordered.length >= 10 ? Math.floor(ordered.length * .1) : 0;
    const retained = ordered.slice(trim, ordered.length - trim || undefined);
    return { ...bar, spot: retained.reduce((sum, price) => sum + price, 0) / retained.length };
  });
}

// Price-only Axiom Phoenix. A three-point median rejects isolated bad
// ticks. Each of the 29 strands is its own volatility-normalized moving-
// average slope. This lets the horizons expand, cross and knit naturally;
// they are not scaled copies of a single oscillator.
export function computePricePhoenix(rows = [], source = "trimmed") {
  const sourcePrice = row => {
    if (source === "hl2") {
      const high = Number(row?.high), low = Number(row?.low);
      return Number.isFinite(high) && Number.isFinite(low) ? (high + low) / 2 : Number(row?.spot);
    }
    if (source === "close") {
      const close = Number(row?.close);
      return Number.isFinite(close) ? close : Number(row?.spot);
    }
    return Number(row?.spot);
  };
  const clean = [...new Map(rows
    .filter(row => Number.isFinite(Date.parse(row?.timestamp || "")) && sourcePrice(row) > 0)
    .map(row => [row.timestamp, { timestamp: row.timestamp, price: sourcePrice(row) }]))
    .values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const length = clean.length;
  const filteredPrices = Float64Array.from(clean, (point, index) => {
    if (index < 2) return point.price;
    return [clean[index - 2].price, clean[index - 1].price, point.price].sort((a, b) => a - b)[1];
  });
  const logPrices = Float64Array.from(filteredPrices, price => Math.log(price || 1));
  const volatility = new Float64Array(length);
  let mean = 0;
  let variance = 1e-8;
  const normalizationAlpha = 2 / 121;

  for (let index = 1; index < length; index += 1) {
    const change = Math.log(filteredPrices[index] / filteredPrices[index - 1]);
    const priorMean = mean;
    mean += normalizationAlpha * (change - mean);
    variance = (1 - normalizationAlpha) * (variance + normalizationAlpha * (change - priorMean) ** 2);
    volatility[index] = Math.max(Math.sqrt(variance), 8e-5);
  }
  if (length) volatility[0] = 8e-5;

  const series = PHOENIX_PERIODS.map(period => {
    const values = new Float32Array(length);
    const movingAverage = new Float64Array(length);
    const alpha = 2 / (period + 1);
    const slopeLookback = Math.max(1, Math.round(Math.sqrt(period)));
    let average = logPrices[0] || 0;
    for (let index = 0; index < length; index += 1) {
      average += alpha * (logPrices[index] - average);
      movingAverage[index] = average;
      if (index < slopeLookback) continue;
      const slope = (average - movingAverage[index - slopeLookback]) /
        (volatility[index] * Math.sqrt(slopeLookback));
      values[index] = clamp((2 / Math.PI) * Math.atan(2.2 * clamp(slope, -4, 4)), -1, 1);
    }
    return values;
  });

  return {
    timestamps: clean.map(point => point.timestamp),
    prices: Float64Array.from(clean, point => point.price),
    periods: PHOENIX_PERIODS,
    series,
  };
}

// Transitional aliases for any external imports while the product name moves
// from Charmander to Phoenix. New code should use the Phoenix exports above.
export const CHARMER_PERIODS = PHOENIX_PERIODS;
export const computePriceCharmander = computePricePhoenix;

export function charmPhase(value, previous) {
  if (!Number.isFinite(value) || !Number.isFinite(previous)) return "neutral";
  if (value >= 0) return value >= previous ? "positive_rising" : "positive_falling";
  return value <= previous ? "negative_falling" : "negative_rising";
}
