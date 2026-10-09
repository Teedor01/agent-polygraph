from __future__ import annotations

import json
from pathlib import Path

DEFAULT_FUTURES_REAL_REPORT_PATH = (
    Path(__file__).resolve().parent.parent / "real_metrics" / "futures_real_report.json"
)

PROVENANCE = "bitget_paper_real_futures_trading"

DISALLOWED_PROVENANCE = {"bitget_mock_futures", "bitget_paper", "bitget_mock"}


class FuturesRealReportProvenanceError(ValueError):
    """Raised when a futures_real_report.json's own declared provenance
    is missing or includes a source this adapter refuses to treat as
    real futures trading."""


def load_real_futures_trading_report(path: str | Path = DEFAULT_FUTURES_REAL_REPORT_PATH) -> dict:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"Real futures trading report not found at {path}. "
            f"Run `python3 compute_futures_metrics.py <log> --out futures_real_report.json` in "
            f"real_metrics/ first - this loader does not generate it itself."
        )
    with open(path, "r") as f:
        data = json.load(f)

    allowed = set(data.get("data_source", {}).get("allowed_provenance", []))
    disallowed_found = allowed & DISALLOWED_PROVENANCE
    if disallowed_found:
        raise FuturesRealReportProvenanceError(
            f"Refusing to ingest {path}: its declared provenance includes {disallowed_found}, "
            f"which must never be presented as real futures trading performance."
        )
    if not allowed:
        raise FuturesRealReportProvenanceError(
            f"Refusing to ingest {path}: no declared provenance in data_source.allowed_provenance. "
            f"Cannot confirm this is real futures trading data - refusing rather than assuming."
        )

    return {
        "provenance": PROVENANCE,
        "source_note": (
            "Computed exclusively from real Bitget Demo futures paper-trading fills "
            "(real_metrics/compute_futures_metrics.py). Not synthetic, not a backtest, not spot."
        ),
        "report": data,
    }
