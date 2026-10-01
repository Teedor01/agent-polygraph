from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import List, Optional, Tuple

REQUIRED_SOURCE = "bitget_paper_futures"  


@dataclass
class CompletedFuturesTrade:
    side: str 
    entry_time: str
    exit_time: str
    entry_price: float
    approx_exit_price: Optional[float]  
    exit_price_is_approximate: bool
    qty_base: float
    leverage: Optional[float]
    approx_realized_pnl_usdt: Optional[float]  
    pnl_basis: str 
    holding_period_seconds: float
    entry_decision_source: str  
    entry_llm_reason: Optional[str]
    entry_llm_confidence: Optional[float]
    exit_decision_source: str
    exit_llm_reason: Optional[str]
    exit_llm_confidence: Optional[float]


def _parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _decision_provenance(entry: dict) -> Tuple[str, Optional[str], Optional[float]]:
    decision_source = entry.get("decisionSource", "llm")
    llm_meta = entry.get("llmMeta")
    raw = llm_meta.get("raw") if isinstance(llm_meta, dict) else None
    reason = raw.get("reason") if isinstance(raw, dict) else None
    confidence = raw.get("confidence") if isinstance(raw, dict) else None
    return decision_source, reason, confidence


def load_log(path: str, allow_sources: List[str]) -> List[dict]:
    entries = []
    skipped = 0
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            if entry.get("source") not in allow_sources:
                skipped += 1
                continue
            entries.append(entry)
    if skipped:
        print(
            f"NOTE: skipped {skipped} log line(s) with a source not in {allow_sources} "
            f"(e.g. mock runs) - official futures metrics never include them.",
            file=sys.stderr,
        )
    return entries


def reconstruct_trades(entries: List[dict]) -> Tuple[List[CompletedFuturesTrade], Optional[dict]]:
    """Walk the log in order, pairing a FLAT->LONG/SHORT open with the
    next matching close back to FLAT. An unmatched open at the end of
    the log is a currently-open position, not a completed trade."""

    completed: List[CompletedFuturesTrade] = []
    pending_open: Optional[dict] = None

    for entry in entries:
        before_side = (entry.get("positionBefore") or {}).get("side")
        after_side = (entry.get("positionAfter") or {}).get("side")
        execution = entry.get("execution") or {}
        action = (entry.get("decision") or {}).get("action")

        opened = before_side == "FLAT" and after_side in ("LONG", "SHORT") and execution.get("status") == "placed"
        closed = (
            before_side in ("LONG", "SHORT")
            and after_side == "FLAT"
            and execution.get("status") == "closed"
            and action in ("CLOSE_LONG", "CLOSE_SHORT")
        )

        if opened:
            pending_open = entry
        elif closed and pending_open is not None:
            entry_exec = pending_open["execution"]
            entry_price = entry_exec.get("executedPrice")
            qty = entry_exec.get("executedQty") or execution.get("executedQty")
            leverage = ((pending_open.get("riskVerdict") or {}).get("leverage"))
            approx_exit_price = (entry.get("marketState") or {}).get("lastPrice")


            approx_pnl = (entry.get("positionBefore") or {}).get("unrealizedPnl")
            pnl_basis = (
                "Bitget's own last-observed unrealizedPnl (from position.info) immediately before the "
                "close was submitted. NOT a confirmed post-fill realized P&L - closeAllPositions does not "
                "return a fill price in the installed SDK version, so no more precise figure is available."
                if approx_pnl is not None
                else "Unavailable - positionBefore.unrealizedPnl was not recorded on the closing cycle's log line."
            )

            t_entry = _parse_ts(pending_open["timestamp"])
            t_exit = _parse_ts(entry["timestamp"])
            entry_source, entry_reason, entry_conf = _decision_provenance(pending_open)
            exit_source, exit_reason, exit_conf = _decision_provenance(entry)

            completed.append(CompletedFuturesTrade(
                side=before_side,
                entry_time=pending_open["timestamp"],
                exit_time=entry["timestamp"],
                entry_price=entry_price,
                approx_exit_price=approx_exit_price,
                exit_price_is_approximate=True,
                qty_base=qty,
                leverage=leverage,
                approx_realized_pnl_usdt=approx_pnl,
                pnl_basis=pnl_basis,
                holding_period_seconds=(t_exit - t_entry).total_seconds(),
                entry_decision_source=entry_source,
                entry_llm_reason=entry_reason,
                entry_llm_confidence=entry_conf,
                exit_decision_source=exit_source,
                exit_llm_reason=exit_reason,
                exit_llm_confidence=exit_conf,
            ))
            pending_open = None

    return completed, pending_open


def compute_metrics(trades: List[CompletedFuturesTrade]) -> dict:
    n = len(trades)
    if n == 0:
        return {
            "trade_count": 0,
            "warning": "No completed round-trip futures trades yet - all metrics below are undefined, not zero.",
            "win_rate_pct": None,
            "cumulative_approx_pnl_usdt": None,
            "sharpe_ratio": None,
            "equity_curve": [],
            "trades_with_missing_pnl": 0,
        }

    pnl_ok = [t for t in trades if t.approx_realized_pnl_usdt is not None]
    missing = n - len(pnl_ok)

    if not pnl_ok:
        return {
            "trade_count": n,
            "warning": f"{n} completed round trip(s) found, but PnL data is missing for all of them.",
            "win_rate_pct": None,
            "cumulative_approx_pnl_usdt": None,
            "sharpe_ratio": None,
            "equity_curve": [],
            "trades_with_missing_pnl": missing,
        }

    m = len(pnl_ok)
    wins = sum(1 for t in pnl_ok if t.approx_realized_pnl_usdt > 0)
    win_rate_pct = round(wins / m * 100, 2)
    cumulative_pnl = round(sum(t.approx_realized_pnl_usdt for t in pnl_ok), 6)

    equity_curve = []
    running = 0.0
    peak = 0.0
    max_dd = 0.0
    for t in pnl_ok:
        running += t.approx_realized_pnl_usdt
        peak = max(peak, running)
        max_dd = max(max_dd, peak - running)
        equity_curve.append({"exit_time": t.exit_time, "cumulative_approx_pnl_usdt": round(running, 6)})

    returns = [t.approx_realized_pnl_usdt for t in pnl_ok]
    if m >= 2 and statistics.pstdev(returns) > 0:
        sharpe = round(statistics.mean(returns) / statistics.pstdev(returns), 4)
        sharpe_note = None
    else:
        sharpe = None
        sharpe_note = f"Not computed: needs return variance across multiple trades (n={m})."

    return {
        "trade_count": n,
        "win_rate_pct": win_rate_pct,
        "cumulative_approx_pnl_usdt": cumulative_pnl,
        "max_drawdown_approx_usdt": round(max_dd, 6),
        "sharpe_ratio": sharpe,
        "sharpe_note": sharpe_note,
        "equity_curve": equity_curve,
        "trades_with_missing_pnl": missing,
        "sample_size_warning": (
            f"n={m} trades. Statistical metrics are not reliable at this sample size."
            if m < 30 else None
        ),
        "pnl_methodology_note": (
            "All P&L figures here are approximate... see each trade's pnl_basis. Bitget's close-positions "
            "endpoint does not return a confirmed fill price in the installed SDK version."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log_path", help="Path to trades-futures.paper.jsonl")
    parser.add_argument("--out", default=None, help="Write full JSON report to this path")
    parser.add_argument("--allow-source", action="append", default=None)
    args = parser.parse_args()

    allow_sources = args.allow_source or [REQUIRED_SOURCE]
    entries = load_log(args.log_path, allow_sources)
    trades, open_position_entry = reconstruct_trades(entries)
    metrics = compute_metrics(trades)

    report = {
        "data_source": {
            "log_path": args.log_path,
            "allowed_provenance": allow_sources,
            "note": "Computed exclusively from real Bitget paper-trading futures fills. Not synthetic, not a backtest.",
        },
        "metrics": metrics,
        "completed_trades": [asdict(t) for t in trades],
        "open_position": {
            "side": (open_position_entry.get("positionAfter") or {}).get("side"),
            "entry_time": open_position_entry["timestamp"],
            "entry_price": open_position_entry["execution"].get("executedPrice"),
            "qty_base": open_position_entry["execution"].get("executedQty"),
            "leverage": (open_position_entry.get("riskVerdict") or {}).get("leverage"),
            "entry_decision_source": _decision_provenance(open_position_entry)[0],
            "entry_llm_reason": _decision_provenance(open_position_entry)[1],
            "entry_llm_confidence": _decision_provenance(open_position_entry)[2],
            "note": "Currently open - not counted in win rate, P&L, or Sharpe above.",
        } if open_position_entry else None,
    }

    print(json.dumps(report, indent=2))
    if args.out:
        with open(args.out, "w") as f:
            json.dump(report, f, indent=2)
        print(f"\nWrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
