import test from "node:test";
import assert from "node:assert/strict";
import { computeExposurePhoenix, computeLevelPhoenix } from "./exposurePhoenix.js";

const bars = values => values.map((value, index) => ({
  timestamp: new Date(Date.UTC(2026, 8, 22, 13, 30 + index)).toISOString(),
  spot: 700 + index * .01,
  dex_signed_raw: value,
  gamma_exposure_raw: value == null ? null : value * 2,
  is_confirmed: true,
}));

test("DEX and GEX each produce 29 bounded Phoenix strands", () => {
  for (const kind of ["dex", "gex"]) {
    const result = computeExposurePhoenix(bars(Array.from({ length: 120 }, (_, i) => i < 60 ? -100 + i : -40 + i * 3)), kind);
    assert.equal(result.series.length, 29);
    assert.equal(result.series.every(line => line.length === 120 && [...line].every(value => value >= -1 && value <= 1)), true);
    assert.equal(result.series[0].at(-1) > 0, true);
  }
});

test("signed exposure survives zero and missing exposure is never treated as zero", () => {
  const points = bars(Array.from({ length: 30 }, (_, index) => index - 15));
  points[20].dex_signed_raw = null;
  const result = computeExposurePhoenix(points, "dex");
  assert.equal(result.raw[15], 0);
  assert.equal(result.valid[15], true);
  assert.equal(result.valid[20], false);
  assert.equal(Number.isNaN(result.raw[20]), true);
});

test("future changes and forming candles cannot alter past exposure scales", () => {
  const input = bars(Array.from({ length: 50 }, (_, index) => index + 1));
  const first = computeExposurePhoenix(input, "gex");
  input[49].gamma_exposure_raw = 1e12;
  input[49].is_confirmed = false;
  const second = computeExposurePhoenix(input, "gex");
  for (let index = 0; index < 49; index += 1) {
    assert.equal(first.series[0][index], second.series[0][index]);
  }
});

test("ZG and ZD Phoenix use their own level histories, not the price series", () => {
  const input = bars(Array.from({ length: 100 }, (_, index) => index));
  input.forEach((row, index) => {
    row.zero_gamma_level = 690 + index * .08;
    row.zero_delta_level = 710 - index * .08;
  });
  const zg = computeLevelPhoenix(input, "zg"), zd = computeLevelPhoenix(input, "zd");
  assert.equal(zg.series[0].at(-1) > 0, true);
  assert.equal(zd.series[0].at(-1) < 0, true);
  assert.equal(zg.prices.at(-1), input.at(-1).spot);
  input.forEach(row => { row.spot += 100; });
  const movedPrice = computeLevelPhoenix(input, "zg");
  assert.equal(movedPrice.series[0].at(-1), zg.series[0].at(-1));
});
