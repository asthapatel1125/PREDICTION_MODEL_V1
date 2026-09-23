import test from "node:test";
import assert from "node:assert/strict";
import { buildSelectedGreekIndex } from "./selectedGreekIndex.js";
import { OPTION_PRO_GREEKS } from "./optionProGreeks.js";

const point = (delta, gamma, charm = 2, speed = 2) => ({
  dex_signed_raw: delta, gamma_exposure_raw: gamma,
  charm_exposure_raw: charm, speed_exposure_raw: speed, is_confirmed: true,
});

test("two selected Greeks produce one V2 equal-weight composite", () => {
  const bars = [...Array.from({ length: 10 }, () => point(2, 2)), point(2, -2)];
  const result = buildSelectedGreekIndex(bars, ["delta", "gamma"]);
  assert.equal(result.version, "V2");
  assert.deepEqual(result.selected.map(item => item.key), ["delta", "gamma"]);
  assert.equal(result.selected[0].values[10], 100);
  assert.equal(result.selected[1].values[10], -100);
  assert.equal(result.composite[10], 0);
});

test("deselecting a Greek removes its term and missing inputs never count as zero", () => {
  const bars = [...Array.from({ length: 10 }, () => point(2, 2)), point(2, null)];
  assert.equal(buildSelectedGreekIndex(bars, ["delta", "gamma"]).composite[10], null);
  assert.equal(buildSelectedGreekIndex(bars, ["delta"]).composite[10], 100);
  assert.equal(buildSelectedGreekIndex(bars, ["delta"]).version, "V1");
  assert.equal(buildSelectedGreekIndex(bars, []).composite[10], null);
  assert.equal(buildSelectedGreekIndex(bars, []).version, null);
});

test("version follows the number of included Greeks through V3 and V4", () => {
  const bars = [...Array.from({ length: 10 }, () => point(2, 2)), point(2, 2)];
  assert.equal(buildSelectedGreekIndex(bars, ["delta", "gamma", "charm"]).version, "V3");
  assert.equal(buildSelectedGreekIndex(bars, ["delta", "gamma", "charm", "speed"]).version, "V4");
});

test("all Options Pro snapshot Greeks can be selected through V18", () => {
  assert.equal(OPTION_PRO_GREEKS.length, 18);
  const warm = Object.fromEntries(OPTION_PRO_GREEKS.map(line => [line.field, 2]));
  const bars = [...Array.from({ length: 10 }, () => ({ ...warm, is_confirmed: true })), { ...warm, is_confirmed: false }];
  const result = buildSelectedGreekIndex(bars, OPTION_PRO_GREEKS.map(line => line.key));
  assert.equal(result.version, "V18");
  assert.equal(result.composite[10], 100);
  assert.equal(buildSelectedGreekIndex(bars, ["theta", "theta"]).version, "V1");
});

test("a missing new provider Greek leaves a gap, not a zero", () => {
  const bars = [...Array.from({ length: 10 }, () => ({ greek_theta_raw: 2, is_confirmed: true })), { greek_theta_raw: null, is_confirmed: false }];
  assert.equal(buildSelectedGreekIndex(bars, ["theta"]).composite[10], null);
});
