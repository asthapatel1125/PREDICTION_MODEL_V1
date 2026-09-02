import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomAtlasPrice } from './rangeAtlasZoom.js';

const automatic = { x0: 0, x1: 100, y0: 680, y1: 740 };
test('zoom in uses linear scale and keeps cursor anchor', () => {
  const result = zoomAtlasPrice(automatic, automatic, .8, .25);
  assert.equal(result.manualY, true);
  assert.equal(result.view.y1 - .25 * (result.view.y1 - result.view.y0), 725);
});
test('wheel and button zoom out restore compression at the live-fit span', () => {
  for (const factor of [1.18, 1.25]) {
    const current = { x0: 20, x1: 40, y0: 685, y1: 737 };
    const result = zoomAtlasPrice(current, automatic, factor);
    assert.equal(result.manualY, false);
    assert.deepEqual(result.view, { ...current, y0: 680, y1: 740 });
  }
});
test('zoom out below the threshold stays linear', () => {
  assert.equal(zoomAtlasPrice({ ...automatic, y0: 705, y1: 710 }, automatic, 1.18).manualY, true);
});
test('zooming out an all-level view returns to the compressed fit', () => {
  assert.equal(zoomAtlasPrice({ ...automatic, y0: 200, y1: 800 }, automatic, 1.18).manualY, false);
});
