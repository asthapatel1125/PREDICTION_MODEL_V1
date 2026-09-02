from __future__ import annotations

import csv
from pathlib import Path
from typing import Any


def load_nas100_monthly_levels(path: Path) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8") as source:
        rows = []
        for row in csv.DictReader(source):
            parsed: dict[str, Any] = {"month": row["month"]}
            for field in (
                "nas100_high", "nas100_low", "nas100_range", "qqq_high",
                "qqq_low", "qqq_range", "slope", "intercept",
            ):
                parsed[field] = float(row[field])
            parsed["qqq_observations"] = int(row["qqq_observations"])
            rows.append(parsed)
        return rows


def build_range_atlas(levels: list[dict[str, Any]]) -> dict[str, Any]:
    """Serve precomputed month-matched QQQ levels without runtime calibration."""

    latest_month = max((item["month"] for item in levels), default=None)
    latest_index = next((i for i, item in enumerate(levels) if item["month"] == latest_month), -1)
    output: list[dict[str, Any]] = []
    for index, item in enumerate(levels):
        nas_range = item["nas100_high"] - item["nas100_low"]
        if abs(nas_range - item["nas100_range"]) > 0.011:
            raise ValueError(f"NAS100 range does not reconcile for {item['month']}")
        age = "latest" if index == latest_index else "recent" if latest_index - 12 <= index < latest_index else "archive"
        qqq_range = item["qqq_high"] - item["qqq_low"]
        if abs(qqq_range - item["qqq_range"]) > 0.00011:
            raise ValueError(f"QQQ range does not reconcile for {item['month']}")
        mapped_low = item["slope"] * item["nas100_low"] + item["intercept"]
        mapped_high = item["slope"] * item["nas100_high"] + item["intercept"]
        if abs(mapped_low - item["qqq_low"]) > 0.0002 or abs(mapped_high - item["qqq_high"]) > 0.0002:
            raise ValueError(f"QQQ affine endpoints do not reconcile for {item['month']}")
        calibrated = nas_range > 0 and qqq_range > 0 and item["qqq_observations"] > 0
        result = {
            **item,
            "cohort": age,
            "calibrated": calibrated,
            "sample_count": item["qqq_observations"],
        }
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
        "method": "precomputed matching-month range-preserving affine transform",
        "levels": output,
    }
