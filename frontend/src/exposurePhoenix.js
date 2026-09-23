import { PHOENIX_PERIODS } from "./priceCharmander.js";

export const EXPOSURE_PHOENIX_FIELDS = {
  dex: "dex_signed_raw",
  gex: "gamma_exposure_raw",
};
export const LEVEL_PHOENIX_FIELDS = {
  zg: "zero_gamma_level",
  zd: "zero_delta_level",
};

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** The price Phoenix's 29 independent EMA-slope strands, applied to signed
 * candle-average exposure. A fixed linear divisor controls numerical scale
 * without changing the arithmetic averages or compressing large exposures.
 * Missing observations break the fan rather than becoming 0.
 */
export function computeValuePhoenix(bars = [], field) {
  if (!field) throw new Error("Phoenix value field is required");
  const timestamps = bars.map(bar => bar.timestamp);
  const prices = Float64Array.from(bars, bar => Number(bar.spot ?? bar.close));
  const raw = bars.map(bar => bar[field] == null ? NaN : Number(bar[field]));
  const normalized = new Float64Array(bars.length);
  const valid = new Array(bars.length).fill(false);
  const history = [];
  const recent = [];
  let referenceScale = null;
  for (let index = 0; index < bars.length; index += 1) {
    if (referenceScale == null && history.length >= 10) {
      const initial = history.slice(0, 10).sort((a, b) => a - b);
      referenceScale = Math.max(initial[8], 1e-9);
    }
    if (Number.isFinite(raw[index])) {
      recent.push(raw[index]);
      if (recent.length > 3) recent.shift();
    } else recent.length = 0;
    if (Number.isFinite(raw[index]) && referenceScale != null) {
      const ordered = [...recent].sort((a, b) => a - b);
      normalized[index] = ordered[Math.floor(ordered.length / 2)] / referenceScale;
      valid[index] = true;
    }
    if (history.length < 10 && bars[index].is_confirmed && Number.isFinite(raw[index])) history.push(Math.abs(raw[index]));
  }
  const volatility = new Float64Array(bars.length);
  let mean = 0, variance = 1e-8, previous = 0;
  const volatilityAlpha = 2 / 121;
  for (let index = 0; index < bars.length; index += 1) {
    if (!valid[index]) { previous = 0; mean = 0; variance = 1e-8; continue; }
    const change = normalized[index] - previous;
    const priorMean = mean;
    mean += volatilityAlpha * (change - mean);
    variance = (1 - volatilityAlpha) * (variance + volatilityAlpha * (change - priorMean) ** 2);
    volatility[index] = Math.max(Math.sqrt(variance), .01);
    previous = normalized[index];
  }
  const series = PHOENIX_PERIODS.map(period => {
    const values = new Float32Array(bars.length);
    const movingAverage = new Float64Array(bars.length);
    const alpha = 2 / (period + 1);
    const lookback = Math.max(1, Math.round(Math.sqrt(period)));
    let average = 0, streak = 0;
    for (let index = 0; index < bars.length; index += 1) {
      if (!valid[index]) { average = 0; streak = 0; continue; }
      streak += 1;
      average += alpha * (normalized[index] - average);
      movingAverage[index] = average;
      if (streak <= lookback) continue;
      const slope = (average - movingAverage[index - lookback]) / (volatility[index] * Math.sqrt(lookback));
      values[index] = clamp((2 / Math.PI) * Math.atan(2.2 * clamp(slope, -4, 4)), -1, 1);
    }
    return values;
  });
  return { timestamps, prices, periods: PHOENIX_PERIODS, series, valid, raw };
}

export function computeExposurePhoenix(bars = [], kind = "dex") {
  const field = EXPOSURE_PHOENIX_FIELDS[kind];
  if (!field) throw new Error(`Unknown exposure Phoenix: ${kind}`);
  return computeValuePhoenix(bars, field);
}

export function computeLevelPhoenix(bars = [], kind = "zg") {
  const field = LEVEL_PHOENIX_FIELDS[kind];
  if (!field) throw new Error(`Unknown level Phoenix: ${kind}`);
  return computeValuePhoenix(bars, field);
}
