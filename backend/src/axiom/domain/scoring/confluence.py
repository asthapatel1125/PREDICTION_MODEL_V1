from __future__ import annotations


class ConfluenceEngine:
    """Four-layer Options-Pro-only signal agreement filter."""

    def __init__(self) -> None:
        self._previous: dict[str, dict[str, float]] = {}

    def calculate(self, symbol: str, metrics: dict) -> dict[str, object]:
        get = lambda name, default=0.0: float(metrics.get(name, default) or default)
        spot = get("spot")
        zero_delta = get("zero_delta", get("zero_delta_est", spot))
        dex_pct, dex_imb = get("dex_pct"), get("dex_imbalance_pct")
        pt, zg_pct, effective_gex = get("pressure_trend", 50), get("zero_gamma_pct"), get("effective_gex_pct")
        mpi, roc_vector = get("mpi_trend", 50), int(get("roc_vector"))
        div_pct, div_vector = get("pressure_div_pct"), int(get("div_vector"))
        cvd_pct, cvd_vector = get("cvd_proxy_pct"), int(get("cvd_proxy_vector"))
        vol_imb, gex_imb = get("vol_imbalance_pct"), get("gex_imbalance_pct")
        previous = self._previous.get(symbol, {})

        pt_rising = pt > previous.get("pt", pt)
        zg_rising = zg_pct > previous.get("zg", zg_pct)
        egex_rising = effective_gex > previous.get("egex", effective_gex)
        cvd_rising = cvd_pct > previous.get("cvd", cvd_pct)
        cvd_falling = cvd_pct < previous.get("cvd", cvd_pct)
        prior_cvd_vector = int(previous.get("cvd_vector", cvd_vector))

        bull = [
            spot > zero_delta and dex_pct > 60 and dex_imb > 20,
            pt > 70 and pt_rising and zg_rising and egex_rising,
            mpi > 70 and roc_vector == 1 and div_vector == 1 and div_pct > 50,
            cvd_vector == 1 and cvd_rising and vol_imb > 15 and gex_imb > 0,
        ]
        bear = [
            spot < zero_delta and dex_pct < 40 and dex_imb < -20,
            pt < 30 and not pt_rising,
            mpi < 30 and roc_vector == -1 and div_vector == -1,
            cvd_vector == -1 and cvd_falling and vol_imb < -15,
        ]
        fake_long = all(bull[:3]) and cvd_vector == -1 and vol_imb < 0
        early_reversal = prior_cvd_vector == 1 and cvd_vector == -1 and pt > 70
        no_trade = 30 <= pt <= 70 and 30 <= mpi <= 70 and cvd_vector == 0
        confidence = 25.0 * max(sum(bull), sum(bear))

        self._previous[symbol] = {
            "pt": pt, "zg": zg_pct, "egex": effective_gex,
            "cvd": cvd_pct, "cvd_vector": float(cvd_vector),
        }
        result = {
            "isStrongLong": all(bull), "isStrongShort": all(bear),
            "isFakeLong": fake_long, "isEarlyReversal": early_reversal,
            "isNoTrade": no_trade, "confidence": confidence,
            "bullishLayers": sum(bull), "bearishLayers": sum(bear),
        }
        return {**result, "confluence": result,
            "is_strong_long": result["isStrongLong"], "is_strong_short": result["isStrongShort"],
            "is_fake_long": result["isFakeLong"], "is_early_reversal": result["isEarlyReversal"],
            "is_no_trade": result["isNoTrade"], "confluence_confidence": confidence}
