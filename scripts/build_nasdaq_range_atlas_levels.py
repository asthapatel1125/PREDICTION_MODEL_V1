"""Precompute QQQ-scaled monthly levels for the NASDAQ-100 Range Atlas.

This is an offline maintenance script.  The deployed API reads the generated
CSV and never requests historical stock data while serving the dashboard.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
LEVELS_PATH = ROOT / "config" / "nas100_monthly_levels.csv"
NASDAQ_HISTORY_URL = "https://api.nasdaq.com/api/quote/QQQ/historical"
SOURCE_PAGE = "https://www.nasdaq.com/market-activity/etf/qqq/historical"


def _number(value: str) -> float:
    return float(str(value).replace("$", "").replace(",", "").strip())


def fetch_qqq_daily(start: str, end: str) -> list[dict[str, str]]:
    query = urlencode(
        {
            "assetclass": "etf",
            "fromdate": start,
            "todate": end,
            "limit": 9999,
        }
    )
    request = Request(
        f"{NASDAQ_HISTORY_URL}?{query}",
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nasdaq.com",
            "Referer": f"{SOURCE_PAGE}/",
        },
    )
    with urlopen(request, timeout=30) as response:  # noqa: S310 - fixed HTTPS host
        payload = json.load(response)
    rows = (((payload.get("data") or {}).get("tradesTable") or {}).get("rows") or [])
    if not rows:
        raise RuntimeError(f"Nasdaq returned no QQQ daily rows for {start} through {end}")
    return rows


def main() -> None:
    with LEVELS_PATH.open(newline="", encoding="utf-8") as source:
        levels = list(csv.DictReader(source))
    if not levels:
        raise RuntimeError("The NAS100 monthly level source is empty")

    first_month, last_month = levels[0]["month"], levels[-1]["month"]
    end_year, end_month = (int(part) for part in last_month.split("-"))
    end_day = 31 if end_month in {1, 3, 5, 7, 8, 10, 12} else 30
    if end_month == 2:
        end_day = 29 if end_year % 4 == 0 else 28
    daily = fetch_qqq_daily(f"{first_month}-01", f"{last_month}-{end_day:02d}")

    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in daily:
        month = datetime.strptime(row["date"], "%m/%d/%Y").strftime("%Y-%m")
        grouped[month].append(row)

    fields = [
        "month",
        "nas100_high",
        "nas100_low",
        "nas100_range",
        "qqq_high",
        "qqq_low",
        "qqq_range",
        "slope",
        "intercept",
        "qqq_observations",
    ]
    output: list[dict[str, str | int]] = []
    for row in levels:
        observations = grouped.get(row["month"], [])
        if not observations:
            raise RuntimeError(f"No matching QQQ observations for {row['month']}")
        nas_high, nas_low = _number(row["nas100_high"]), _number(row["nas100_low"])
        qqq_high = max(_number(item["high"]) for item in observations)
        qqq_low = min(_number(item["low"]) for item in observations)
        nas_range, qqq_range = nas_high - nas_low, qqq_high - qqq_low
        if nas_range <= 0 or qqq_range <= 0:
            raise RuntimeError(f"Invalid monthly range for {row['month']}")
        slope = qqq_range / nas_range
        intercept = qqq_low - slope * nas_low
        output.append(
            {
                "month": row["month"],
                "nas100_high": f"{nas_high:.2f}",
                "nas100_low": f"{nas_low:.2f}",
                "nas100_range": f"{nas_range:.2f}",
                "qqq_high": f"{qqq_high:.4f}",
                "qqq_low": f"{qqq_low:.4f}",
                "qqq_range": f"{qqq_range:.4f}",
                "slope": f"{slope:.12f}",
                "intercept": f"{intercept:.8f}",
                "qqq_observations": len(observations),
            }
        )

    with LEVELS_PATH.open("w", newline="", encoding="utf-8") as destination:
        writer = csv.DictWriter(destination, fieldnames=fields)
        writer.writeheader()
        writer.writerows(output)
    print(f"Wrote {len(output)} precomputed months to {LEVELS_PATH}")


if __name__ == "__main__":
    main()
