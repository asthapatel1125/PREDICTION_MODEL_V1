import test from "node:test";
import assert from "node:assert/strict";
import { CHARMER_PERIODS, charmPhase, computePriceCharmander } from "./priceCharmander.js";

const rows = prices => prices.map((spot, index) => ({
  timestamp: new Date(Date.UTC(2026, 8, 16, 14, 30, index * 5)).toISOString(),
  spot,
}));

test("builds 29 bounded price-only horizons", () => {
  const result = computePriceCharmander(rows(Array.from({ length: 120 }, (_, index) => 700 + index * .04)));
  assert.equal(result.periods.length, 29);
  assert.deepEqual(result.periods, CHARMER_PERIODS);
  assert.equal(result.series.every(line => line.length === 120), true);
  assert.equal(result.series.every(line => [...line].every(value => value >= -1 && value <= 1)), true);
  assert.equal(result.series.filter(line => line.at(-1) > 0).length > 20, true);
});

test("flat prices settle at the zero line", () => {
  const result = computePriceCharmander(rows(Array.from({ length: 90 }, () => 705)));
  assert.equal(result.series.every(line => Math.abs(line.at(-1)) < 1e-6), true);
});

test("assigns all four live color phases", () => {
  assert.equal(charmPhase(.5, .4), "positive_rising");
  assert.equal(charmPhase(.4, .5), "positive_falling");
  assert.equal(charmPhase(-.5, -.4), "negative_falling");
  assert.equal(charmPhase(-.4, -.5), "negative_rising");
});

