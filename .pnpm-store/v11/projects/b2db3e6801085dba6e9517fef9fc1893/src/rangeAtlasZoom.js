// Keep horizontal navigation intact when returning to the compressed live fit.
export function zoomAtlasPrice(current, automatic, factor, focus = .5) {
  const span = current.y1 - current.y0;
  const nextSpan = Math.max(.001, span * factor);
  if (factor > 1 && nextSpan >= automatic.y1 - automatic.y0) {
    return { manualY: false, view: { ...current, y0: automatic.y0, y1: automatic.y1 } };
  }
  const anchor = current.y1 - focus * span;
  return { manualY: true, view: { ...current, y1: anchor + focus * nextSpan, y0: anchor - (1 - focus) * nextSpan } };
}
