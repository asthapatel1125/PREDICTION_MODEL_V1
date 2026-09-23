import { EXPOSURE_LINES, indexGreekExposures } from "./greekExposureIndex.js";

export function buildSelectedGreekIndex(bars, selectedKeys) {
  const indexed = indexGreekExposures(bars);
  const active = selectedKeys.filter(key => EXPOSURE_LINES.some(line => line.key === key));
  const selected = active.map(key => ({
    key,
    line: EXPOSURE_LINES.find(item => item.key === key),
    values: indexed[key],
  }));
  const composite = bars.map((_, index) => {
    if (!selected.length || selected.some(item => item.values[index] == null)) return null;
    return selected.reduce((sum, item) => sum + item.values[index], 0) / selected.length;
  });
  return { selected, version: selected.length ? `V${selected.length}` : null, composite };
}
