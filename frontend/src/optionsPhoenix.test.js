import test from "node:test";
import assert from "node:assert/strict";
import { averagePriceBars, computePricePhoenix } from "./priceCharmander.js";
import { computeOptionsPhoenix, nextCandleOutlook } from "./optionsPhoenix.js";

const start=Date.parse("2026-09-22T13:30:00Z");
const makeBars=(count,{gex=0,dexStep=0,withOptions=true}={})=>Array.from({length:count},(_,i)=>({
  timestamp:new Date(start+i*60_000).toISOString(),spot:700+i*.05,close:700+i*.05,is_confirmed:true,
  ...(withOptions?{options_at:new Date(start+i*60_000+45_000).toISOString(),dex_signed_raw:1e9+i*dexStep,dex_imbalance_pct:50+i*.05,gex_imbalance_pct:gex}:{}),
}));

test("calendar candles carry the last options snapshot, never sum OI exposure",()=>{
  const bars=averagePriceBars([
    {timestamp:new Date(start).toISOString(),spot:700,options_at:new Date(start+10_000).toISOString(),dex_signed_raw:1e9,gex_imbalance_pct:10},
    {timestamp:new Date(start+30_000).toISOString(),spot:701,options_at:new Date(start+30_000).toISOString(),dex_signed_raw:1.1e9,gex_imbalance_pct:25},
  ],60);
  assert.equal(bars.length,1);
  assert.equal(bars[0].dex_signed_raw,1.1e9);
  assert.equal(bars[0].gex_imbalance_pct,25);
});

test("options fan falls back to price and GEX changes amplitude without supplying direction",()=>{
  const bare=makeBars(70,{withOptions:false}),price=computePricePhoenix(bare),fallback=computeOptionsPhoenix(price,bare,60);
  assert.equal(fallback.valid.some(Boolean),false);
  assert.equal(fallback.series.every((line,index)=>line.every((value,i)=>value===price.series[index][i])),true);
  const positive=computeOptionsPhoenix(price,makeBars(70,{gex:100}),60);
  const negative=computeOptionsPhoenix(price,makeBars(70,{gex:-100}),60);
  assert.ok(Math.abs(positive.consensus[69])<Math.abs(negative.consensus[69]));
});

test("DEX residual responds to exposure change beyond the direct spot multiplier",()=>{
  const bars=makeBars(70,{dexStep:2e6}),price=computePricePhoenix(bars),overlay=computeOptionsPhoenix(price,bars,60);
  assert.equal(overlay.dexReady[69],true);
  assert.ok(overlay.dexImpulse[69]>0);
  assert.equal(overlay.dexSource[69],"SIGNED");
});

test("older Supabase rows use the directional DEX-balance fallback",()=>{
  const bars=makeBars(70).map(({dex_signed_raw,...rest})=>rest),price=computePricePhoenix(bars),overlay=computeOptionsPhoenix(price,bars,60);
  assert.equal(overlay.dexReady[69],true);
  assert.equal(overlay.dexSource[69],"BALANCE");
});

test("next-candle outlook uses only completed historical outcomes and refuses stale options",()=>{
  const bars=makeBars(100,{dexStep:2e6}),price=computePricePhoenix(bars),overlay=computeOptionsPhoenix(price,bars,60),now=Date.parse(bars.at(-1).options_at)+10_000;
  const forecast=nextCandleOutlook(bars,overlay,60,{now});
  assert.equal(forecast.status,"READY");
  assert.equal(forecast.direction,"UP");
  assert.ok(forecast.low<=forecast.median&&forecast.median<=forecast.high);
  const future={...bars.at(-1),timestamp:new Date(start+100*60_000).toISOString(),options_at:new Date(start+100*60_000+45_000).toISOString(),spot:900,close:900,is_confirmed:false};
  const expanded=[...bars,future],expandedOverlay=computeOptionsPhoenix(computePricePhoenix(expanded),expanded,60);
  const unchanged=nextCandleOutlook(expanded,expandedOverlay,60,{now});
  assert.equal(unchanged.median,forecast.median);
  assert.equal(nextCandleOutlook(bars,overlay,60,{now:now+180_000}).status,"UNAVAILABLE");
});
