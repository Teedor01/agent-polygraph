from __future__ import annotations

from pathlib import Path

from .synthetic_adapter import load_synthetic_report
from .real_trading_adapter import load_real_trading_report


def get_polygraph_view(
    synthetic_path: str | Path | None = None,
    real_path: str | Path | None = None,
) -> dict:
    """Returns {"synthetic": {...}, "real": {...}}, two top-level keys,
    never flattened or interleaved. Real trading data is optional at any
    given moment (e.g. before the first paper trade completes); the
    synthetic harness must remain viewable on its own regardless."""

    synth_kwargs = {"path": synthetic_path} if synthetic_path is not None else {}
    real_kwargs = {"path": real_path} if real_path is not None else {}

    synthetic = load_synthetic_report(**synth_kwargs)

    try:
        real = load_real_trading_report(**real_kwargs)
    except FileNotFoundError as e:
        real = {
            "provenance": "bitget_paper_real_trading",
            "source_note": "No real trading report available yet.",
            "report": None,
            "unavailable_reason": str(e),
        }

    return {"synthetic": synthetic, "real": real}
