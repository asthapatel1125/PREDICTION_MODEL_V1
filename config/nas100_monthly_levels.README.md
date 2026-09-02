# NASDAQ-100 / QQQ Range Atlas source

`nas100_monthly_levels.csv` stores the user-supplied NASDAQ-100 monthly high
and low endpoints together with QQQ-scaled endpoints computed before deploy.
The deployed backend reads this file directly; it does not request historical
stock data from ThetaData or Nasdaq.

For every matching month, the preprocessing script takes the maximum daily QQQ
high and minimum daily QQQ low from Nasdaq's QQQ historical table and computes:

```text
slope = (QQQ_high - QQQ_low) / (NAS100_high - NAS100_low)
intercept = QQQ_low - slope * NAS100_low
QQQ_level = slope * NAS100_level + intercept
```

This month-specific affine mapping preserves the position and span of each
supplied NASDAQ-100 range. It is not a fixed NASDAQ-100/QQQ divisor.

- QQQ daily OHLC source: https://www.nasdaq.com/market-activity/etf/qqq/historical
- Conversion coverage: January 2020 through August 2026
- The January-August 2026 NASDAQ-100 and QQQ endpoints were independently
  rebuilt from Nasdaq's official daily historical tables on 2026-09-02. The
  originally pasted 2026 index values were not used because they did not
  reconcile with Nasdaq's daily NDX observations.
- Rebuild command: `python scripts/build_nasdaq_range_atlas_levels.py`
- Runtime live line: ThetaData QQQ stream already used by Wall Intelligence
