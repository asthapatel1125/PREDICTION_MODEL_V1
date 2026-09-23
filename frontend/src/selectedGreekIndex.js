import { indexGreekExposures } from "./greekExposureIndex.js";
import { OPTION_PRO_GREEKS } from "./optionProGreeks.js";

export function buildSelectedGreekIndex(bars, selectedKeys) {
  const indexed = indexGreekExposures(bars, { lines: OPTION_PRO_GREEKS });
  const active = [...new Set(selectedKeys)].filter(key => OPTION_PRO_GREEKS.some(line => line.key === key));
  const selected = active.map(key => ({
    key,
    line: OPTION_PRO_GREEKS.find(item => item.key === key),
    values: indexed[key],
  }));
  const composite = bars.map((_, index) => {
    if (!selected.length || selected.some(item => item.values[index] == null)) return null;
    return selected.reduce((sum, item) => sum + item.values[index], 0) / selected.length;
  });
  return { selected, version: selected.length ? `V${selected.length}` : null, composite };
}
