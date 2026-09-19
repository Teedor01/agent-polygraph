from __future__ import annotations

import json
from pathlib import Path

DEFAULT_REAL_REPORT_PATH = (
    Path(__file__).resolve().parent.parent / "real_metrics" / "real_report.json"
)

PROVENANCE = "bitget_paper_real_trading"


DISALLOWED_PROVENANCE = {"bitget_mock"}


class RealReportProvenanceError(ValueError):
    """Raised when a real_report.json's own declared provenance is
    missing or includes a source this adapter refuses to treat as real."""


def load_real_trading_report(path: str | Path = DEFAULT_REAL_REPORT_PATH) -> dict:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(
            f"Real trading report not found at {path}. "
            f"Run `python3 compute_metrics.py <log> --out real_report.json` in real_metrics/ first - "
            f"this loader does not generate it itself."
        )
    with open(path, "r") as f:
        data = json.load(f)

    allowed = set(data.get("data_source", {}).get("allowed_provenance", []))
    disallowed_found = allowed & DISALLOWED_PROVENANCE
    if disallowed_found:
        raise RealReportProvenanceError(
            f"Refusing to ingest {path}: its declared provenance includes {disallowed_found}, "
            f"which must never be presented as real trading performance."
        )
    if not allowed:
        raise RealReportProvenanceError(
            f"Refusing to ingest {path}: no declared provenance in data_source.allowed_provenance. "
            f"Cannot confirm this is real trading data - refusing rather than assuming."
        )

    return {
        "provenance": PROVENANCE,
        "source_note": (
            "Computed exclusively from real Bitget Demo paper-trading fills "
            "(real_metrics/compute_metrics.py). Not synthetic, not a backtest."
        ),
        "report": data,
    }
