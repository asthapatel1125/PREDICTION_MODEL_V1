import { getCandles } from "./calendarCandles.js";
import { EXTRA_GREEK_FIELDS } from "./optionProGreeks.js";

export const PHOENIX_PERIODS = Array.from({ length: 29 }, (_, index) => index + 2);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function averagePriceBars(rows = [], bucketSeconds = 300, numCandles = 150) {
  return getCandles(rows,bucketSeconds,numCandles,{exchangeTimeZone:"America/New_York",lastFields:["options_at","dex_signed_raw","gamma_exposure_raw","charm_exposure_raw","speed_exposure_raw","dex_imbalance_pct","gex_imbalance_pct"]});
}

export function greekIndexBars(rows = [], bucketSeconds = 300, numCandles = 150) {
  const expanded = rows.map(row => ({ ...row, ...Object.fromEntries(
    EXTRA_GREEK_FIELDS.map(field => [field, row[field] ?? row.greek_exposures?.[field.slice(6, -4)]])
  ) }));
  return getCandles(expanded, bucketSeconds, numCandles, { exchangeTimeZone: "America/New_York",
    lastFields: ["options_at", "dex_signed_raw", "gamma_exposure_raw", "charm_exposure_raw", "speed_exposure_raw", ...EXTRA_GREEK_FIELDS] });
}

export function averageExposureBars(rows = [], bucketSeconds = 300, numCandles = 150) {
  return getCandles(rows,bucketSeconds,numCandles,{exchangeTimeZone:"America/New_York",
    lastFields:["options_at"],averageFields:["dex_signed_raw","gamma_exposure_raw"]});
}

export function levelPriceBars(rows = [], bucketSeconds = 300, numCandles = 150) {
  return getCandles(rows,bucketSeconds,numCandles,{exchangeTimeZone:"America/New_York",
    lastFields:["zero_gamma_level","zero_delta_level"]});
}

// Price-only Axiom Phoenix. A three-point median rejects isolated bad
// ticks. Each of the 29 strands is its own volatility-normalized moving-
// average slope. This lets the horizons expand, cross and knit naturally;
// they are not scaled copies of a single oscillator.
export function computePricePhoenix(rows = []) {
  const sourcePrice = row => Number(row?.spot);
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
