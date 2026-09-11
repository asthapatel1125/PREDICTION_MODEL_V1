import test from "node:test";
import assert from "node:assert/strict";
import {exposureRowsToTraces} from "./interactiveChartData.js";

test("exposure adapter preserves exact stored timestamps and values",()=>{
  const rows=[{timestamp:"2026-09-11T14:30:05-04:00",spot:715.25,walls:{ZERO_GAMMA:{strike:714.5}}}];
  const traces=exposureRowsToTraces(rows,"ZERO_GAMMA");
  assert.deepEqual(traces[0].x,[rows[0].timestamp]);
  assert.deepEqual(traces[0].y,[715.25]);
  assert.deepEqual(traces[1].y,[714.5]);
  assert.deepEqual(traces[2].y,[null]);
});

test("exposure adapter discards incomplete observations rather than inventing values",()=>{
  const traces=exposureRowsToTraces([{timestamp:"2026-09-11T14:30:05-04:00",spot:715,walls:{}}]);
  assert.equal(traces[0].x.length,0);
  assert.equal(traces[1].y.length,0);
});
