from __future__ import annotations

import json
from pathlib import Path

from .real_trading_adapter import load_real_trading_report, RealReportProvenanceError

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "frontend" / "data" / "real_trading.json"


def main():
    try:
        real = load_real_trading_report()
    except FileNotFoundError as e:
        real = {
            "provenance": "bitget_paper_real_trading",
            "source_note": "No real trading report available yet.",
            "report": None,
            "unavailable_reason": str(e),
        }
    except RealReportProvenanceError as e:
        raise SystemExit(f"Refusing to export real_trading.json: {e}")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(real, f, indent=2)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
