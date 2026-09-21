import test from "node:test";
import assert from "node:assert/strict";
import { getCandles } from "./calendarCandles.js";

const row=(timestamp,price,volume=1,trade_id)=>({timestamp,price,volume,trade_id});
const local=candle=>new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(candle.timestamp));

test("15m calendar bucket floors 09:31:12 to 09:30",()=>{
  const [candle]=getCandles([row("2026-09-17T13:31:12Z",100)],"15M",150,{now:Date.parse("2026-09-18T00:00:00Z")});
  assert.equal(local(candle),"09:30");
});

test("six-hour buckets use 00 06 12 18 exchange-clock boundaries",()=>{
  const candles=getCandles(["04:05","10:05","16:05","22:05"].map((time,index)=>row(`2026-09-17T${time}:00Z`,100+index)),"6H",150,{now:Date.parse("2026-09-18T12:00:00Z")});
  assert.deepEqual(candles.map(local),["00:00","06:00","12:00","18:00"]);
});

test("DST spring-forward buckets remain on exchange clock",()=>{
  const rows=[row("2024-03-10T06:15:00Z",100),row("2024-03-10T07:15:00Z",101)];
  assert.deepEqual(getCandles(rows,"1H",150,{now:Date.parse("2024-03-11T00:00:00Z")}).map(local),["01:00","03:00"]);
  assert.deepEqual(getCandles(rows,"2H",150,{now:Date.parse("2024-03-11T00:00:00Z")}).map(local),["00:00","03:00"]);
});

test("forming candle is returned as unconfirmed",()=>{
  const candles=getCandles([row("2026-09-17T14:17:00Z",100)],"15M",150,{now:Date.parse("2026-09-17T14:18:00Z")});
  assert.equal(candles.length,1);assert.equal(candles[0].is_confirmed,false);
});

test("duplicate timestamp and trade id does not double count volume",()=>{
  const duplicate=row("2026-09-17T14:01:00Z",100,5,"a"),[candle]=getCandles([duplicate,{...duplicate}],"5M",150,{now:Date.parse("2026-09-18T00:00:00Z")});
  assert.equal(candle.volume,5);
});
