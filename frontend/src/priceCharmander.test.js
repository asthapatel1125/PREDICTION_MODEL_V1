import test from "node:test";
import assert from "node:assert/strict";
import { CHARMER_PERIODS, averagePriceBars, charmPhase, computePriceCharmander } from "./priceCharmander.js";

const rows = prices => prices.map((spot, index) => ({
  timestamp: new Date(Date.UTC(2026, 8, 16, 14, 30, index * 5)).toISOString(),
  spot,
}));

test("averages noisy ticks into OHLC analysis bars", () => {
  const bars=averagePriceBars([
    {timestamp:"2026-09-16T14:00:01Z",spot:100},{timestamp:"2026-09-16T14:00:06Z",spot:104},
    {timestamp:"2026-09-16T14:00:11Z",spot:102},{timestamp:"2026-09-16T14:00:31Z",spot:106},
  ],30);
  assert.equal(bars.length,2);
  assert.deepEqual({spot:bars[0].spot,open:bars[0].open,high:bars[0].high,low:bars[0].low,close:bars[0].close,samples:bars[0].samples},
    {spot:102,open:100,high:104,low:100,close:102,samples:3});
});

test("uses a trimmed bucket average so isolated bad ticks do not drive the signal", () => {
  const points=Array.from({length:20},(_,index)=>({timestamp:new Date(Date.UTC(2026,8,16,14,0,index)).toISOString(),spot:index===10?900:100}));
  const [bar]=averagePriceBars(points,30);
  assert.equal(bar.spot,100);
  assert.equal(bar.high,900);
});

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

test("independent horizons preserve a responsive fast line and a steadier slow line", () => {
  const prices=Array.from({length:360},(_,index)=>700+index*.015+Math.sin(index*.45)*.35);
  const result = computePriceCharmander(rows(prices));
  const variation=line=>[...line].slice(1).reduce((sum,value,index)=>sum+Math.abs(value-line[index]),0);
  assert.equal(variation(result.series[0]) > variation(result.series.at(-1)), true);
  assert.equal(result.series.some((line,index)=>index>0&&line.some((value,point)=>Math.abs(value-result.series[0][point])>.02)),true);
});

test("a sustained reversal crosses into the bearish half", () => {
  const prices = [...Array.from({ length: 140 }, (_, index) => 700 + index * .04), ...Array.from({ length: 140 }, (_, index) => 705.6 - index * .08)];
  const result = computePriceCharmander(rows(prices));
  assert.equal(result.series.filter(line => line.at(-1) < 0).length > 20, true);
});

test("assigns all four live color phases", () => {
  assert.equal(charmPhase(.5, .4), "positive_rising");
  assert.equal(charmPhase(.4, .5), "positive_falling");
  assert.equal(charmPhase(-.5, -.4), "negative_falling");
  assert.equal(charmPhase(-.4, -.5), "negative_rising");
});
