from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any


def load_nas100_monthly_levels(path: Path) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8") as source:
        return [
            {
                "month": row["month"],
                "nas100_high": float(row["nas100_high"]),
                "nas100_low": float(row["nas100_low"]),
                "nas100_range": float(row["nas100_range"]),
            }
            for row in csv.DictReader(source)
        ]


def _row_month(row: dict[str, Any]) -> str | None:
    value = row.get("last_trade") or row.get("created") or row.get("timestamp") or row.get("date")
    if isinstance(value, datetime):
        return value.strftime("%Y-%m")
    if isinstance(value, date):
        return value.strftime("%Y-%m")
    if value:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).strftime("%Y-%m")
        except ValueError:
            text = str(value)
            return text[:7] if len(text) >= 7 else None
    return None


def build_range_atlas(levels: list[dict[str, Any]], qqq_eod_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Translate supplied monthly NAS100 ranges onto observed monthly QQQ ranges.

    This is a range-preserving affine transform, not a fixed NAS100/QQQ divisor.
    It uses only the supplied NAS100 endpoints and ThetaData-observed QQQ EOD
    highs/lows from the matching month. Months without QQQ observations remain
    uncalibrated rather than receiving an estimated value.
    """
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in qqq_eod_rows:
        if month := _row_month(row):
            grouped[month].append(row)

    latest_month = max((item["month"] for item in levels), default=None)
    latest_index = next((i for i, item in enumerate(levels) if item["month"] == latest_month), -1)
    output: list[dict[str, Any]] = []
    for index, item in enumerate(levels):
        month_rows = grouped.get(item["month"], [])
        highs = [float(row["high"]) for row in month_rows if row.get("high") is not None and float(row["high"]) > 0]
        lows = [float(row["low"]) for row in month_rows if row.get("low") is not None and float(row["low"]) > 0]
        nas_range = item["nas100_high"] - item["nas100_low"]
        age = "latest" if index == latest_index else "recent" if latest_index - 12 <= index < latest_index else "archive"
        result = {**item, "cohort": age, "calibrated": False, "sample_count": len(month_rows)}
        if highs and lows and nas_range > 0:
            qqq_high, qqq_low = max(highs), min(lows)
            slope = (qqq_high - qqq_low) / nas_range
            intercept = qqq_low - slope * item["nas100_low"]
            result.update({
                "calibrated": True,
                "qqq_high": qqq_high,
                "qqq_low": qqq_low,
                "qqq_range": qqq_high - qqq_low,
                "slope": slope,
                "intercept": intercept,
            })
        output.append(result)

    calibrated = sum(bool(item["calibrated"]) for item in output)
    return {
        "symbol": "QQQ",
        "index": "NAS100",
        "latest_supplied_month": latest_month,
        "source_count": len(levels),
        "calibrated_count": calibrated,
        "uncalibrated_count": len(levels) - calibrated,
        "formula": "QQQ = QQQ_month_low + (NAS100 - NAS100_month_low) * (QQQ_month_range / NAS100_month_range)",
        "method": "matching-month range-preserving affine transform",
        "levels": output,
    }
