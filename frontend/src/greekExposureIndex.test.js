import test from "node:test";
import assert from "node:assert/strict";
import { EXPOSURE_LINES, indexGreekExposures } from "./greekExposureIndex.js";

const row = (value, confirmed = true) => Object.fromEntries([
  ...EXPOSURE_LINES.map(line => [line.field, value]), ["is_confirmed", confirmed],
]);

test("each Greek is causally indexed with a distinct color and preserved sign", () => {
  assert.equal(new Set(EXPOSURE_LINES.map(line => line.color)).size, 4);
  const bars = [...Array.from({ length: 10 }, () => row(2)), row(-2), row(20)];
  const result = indexGreekExposures(bars);
  for (const line of EXPOSURE_LINES) {
    assert.equal(result[line.key][9], null);
    assert.equal(result[line.key][10], -100);
    assert.equal(result[line.key][11], 100);
  }
});

test("unconfirmed extremes cannot change the next reference scale", () => {
  const bars = [...Array.from({ length: 10 }, () => row(2)), row(1000, false), row(2)];
  const result = indexGreekExposures(bars);
  assert.equal(result.delta[10], 100);
  assert.equal(result.delta[11], 100);
});

test("missing exposure stays missing rather than becoming a zero signal", () => {
  const bars = [...Array.from({ length: 10 }, () => row(2)), { ...row(2), charm_exposure_raw: null }];
  const result = indexGreekExposures(bars);
  assert.equal(result.charm[10], null);
  assert.equal(result.gamma[10], 100);
});
