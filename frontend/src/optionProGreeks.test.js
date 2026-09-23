import test from "node:test";
import assert from "node:assert/strict";
import { OPTION_PRO_GREEKS } from "./optionProGreeks.js";
import { greekIndexBars } from "./priceCharmander.js";

test("Options Pro picker offers every documented snapshot Greek once", () => {
  assert.equal(OPTION_PRO_GREEKS.length, 18);
  assert.equal(new Set(OPTION_PRO_GREEKS.map(line => line.key)).size, 18);
  assert.ok(OPTION_PRO_GREEKS.some(line => line.key === "dual_gamma"));
});

test("live Greek map is retained in its calendar candle without fabricating absent Greeks", () => {
  const bars = greekIndexBars([{
    timestamp: "2026-09-22T13:31:12Z", spot: 500,
    greek_exposures: { theta: -30, dual_gamma: 42 },
  }], 900, 150);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].timestamp, "2026-09-22T13:30:00.000Z");
  assert.equal(bars[0].greek_theta_raw, -30);
  assert.equal(bars[0].greek_dual_gamma_raw, 42);
  assert.equal(bars[0].greek_epsilon_raw, undefined);
});
