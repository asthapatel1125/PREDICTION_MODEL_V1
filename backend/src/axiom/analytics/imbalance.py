from __future__ import annotations


def signed_imbalance(positive: float, negative: float) -> float:
    positive, negative = max(0.0, float(positive)), abs(float(negative))
    total = positive + negative
    return 100.0 * (positive - negative) / total if total > 0 else 0.0


def chain_imbalances(metrics: dict) -> dict[str, float]:
    return {
        "gex_imbalance_pct": signed_imbalance(metrics.get("positive_gex", 0.0), metrics.get("negative_gex", 0.0)),
        "dex_imbalance_pct": signed_imbalance(metrics.get("positive_dex", 0.0), metrics.get("negative_dex", 0.0)),
        "vol_imbalance_pct": signed_imbalance(metrics.get("call_volume", 0.0), metrics.get("put_volume", 0.0)),
    }
