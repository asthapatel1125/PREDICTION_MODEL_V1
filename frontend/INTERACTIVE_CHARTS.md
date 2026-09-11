# Reusable interactive charts

`InteractiveTimeSeriesChart` renders supplied observations without changing calculations or inventing intermediate values. It provides synchronized exact-point hover, wheel zoom, drag-to-pan, independent Plotly axes, a compact range slider, image export, reset controls, responsive sizing, and `uirevision` view persistence.

```jsx
import InteractiveTimeSeriesChart from "./components/InteractiveTimeSeriesChart";

<InteractiveTimeSeriesChart
  title="Example"
  traces={[{name: "Price", x: timestamps, y: prices, unit: "USD", line: {color: "#e6edf3"}}]}
  xAxisTitle="Eastern Time"
  yAxisTitle="Price (USD)"
  selectedDatasetId={`${symbol}-${date}`}
  showRangeSlider
  marketHoursOnly
/>
```

Keep `selectedDatasetId` stable during live updates to preserve the user's view. Change it when the symbol, date, or dataset changes and the chart should reset. Zero Gamma and Zero Delta use `exposureRowsToTraces` as the first production integration.
