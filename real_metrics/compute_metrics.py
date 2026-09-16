from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import List, Optional


REQUIRED_SOURCE = "bitget_paper"  


@dataclass
class CompletedTrade:
    entry_time: str
    exit_time: str
    entry_price: float
    exit_price: float
    qty_base: float
    entry_notional_usdt: float
    exit_notional_usdt: float
    entry_order_id: str
    exit_order_id: Optional[str]
    net_pnl_usdt: float
    return_pct: float
    holding_period_seconds: float


def _parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def load_log(path: str, allow_sources: List[str]) -> List[dict]:
    entries = []
    skipped_other_source = 0
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            if entry.get("source") not in allow_sources:
                skipped_other_source += 1
                continue
            entries.append(entry)
    if skipped_other_source:
        print(
            f"NOTE: skipped {skipped_other_source} log line(s) with a source not in {allow_sources} "
            f"(e.g. mock runs) - official metrics never include them.",
            file=sys.stderr,
        )
    return entries


def reconstruct_trades(entries: List[dict]) -> tuple[List[CompletedTrade], Optional[dict]]:
    """Walk the log in order, pairing each flat->in-position transition
    with the next in-position->flat transition. Returns (completed
    trades, open_position_or_None)... an unmatched entry at the end of
    the log is a currently-open position, not a completed trade."""

    completed: List[CompletedTrade] = []
    pending_entry: Optional[dict] = None

    for entry in entries:
        pos_before = entry.get("position_before", {})
        pos_after = entry.get("position_after", {})
        execution = entry.get("execution")

        opened = (not pos_before.get("inPosition")) and pos_after.get("inPosition")
        closed = pos_before.get("inPosition") and (not pos_after.get("inPosition"))

        if opened and execution and execution.get("status") == "placed":
            pending_entry = entry
        elif closed and pending_entry is not None and execution and execution.get("status") == "placed":
            entry_exec = pending_entry["execution"]
            exit_exec = execution

            entry_price = entry_exec.get("executedPrice")
            exit_price = exit_exec.get("executedPrice")
            qty_base = entry_exec.get("executedQty")

            entry_raw_detail = entry_exec.get("raw", {}).get("detail", {}) or {}
            exit_raw_detail = exit_exec.get("raw", {}).get("detail", {}) or {}
            entry_notional = float(entry_raw_detail.get("cumExecValue") or entry_raw_detail.get("amount") or 0)
            exit_notional = float(exit_raw_detail.get("cumExecValue") or 0)

            net_pnl = exit_notional - entry_notional
            return_pct = (net_pnl / entry_notional * 100) if entry_notional else 0.0

            t_entry = _parse_ts(pending_entry["timestamp"])
            t_exit = _parse_ts(entry["timestamp"])

            completed.append(CompletedTrade(
                entry_time=pending_entry["timestamp"],
                exit_time=entry["timestamp"],
                entry_price=entry_price,
                exit_price=exit_price,
                qty_base=qty_base,
                entry_notional_usdt=round(entry_notional, 6),
                exit_notional_usdt=round(exit_notional, 6),
                entry_order_id=entry_exec.get("orderId"),
                exit_order_id=exit_exec.get("orderId"),
                net_pnl_usdt=round(net_pnl, 6),
                return_pct=round(return_pct, 4),
                holding_period_seconds=(t_exit - t_entry).total_seconds(),
            ))
            pending_entry = None

    return completed, pending_entry


def compute_metrics(trades: List[CompletedTrade]) -> dict:
    n = len(trades)
    if n == 0:
        return {
            "trade_count": 0,
            "warning": "No completed round-trip trades yet... all metrics below are undefined, not zero.",
            "win_rate_pct": None,
            "cumulative_pnl_usdt": None,
            "cumulative_return_pct": None,
            "max_drawdown_usdt": None,
            "sharpe_ratio": None,
            "equity_curve": [],
        }

    wins = sum(1 for t in trades if t.net_pnl_usdt > 0)
    win_rate_pct = round(wins / n * 100, 2)

    cumulative_pnl = round(sum(t.net_pnl_usdt for t in trades), 6)
    total_deployed = sum(t.entry_notional_usdt for t in trades)
    cumulative_return_pct = round(cumulative_pnl / total_deployed * 100, 4) if total_deployed else None


    equity_curve = []
    running = 0.0
    peak = 0.0
    max_dd_usdt = 0.0
    for t in trades:
        running += t.net_pnl_usdt
        peak = max(peak, running)
        drawdown = peak - running
        max_dd_usdt = max(max_dd_usdt, drawdown)
        equity_curve.append({"exit_time": t.exit_time, "cumulative_pnl_usdt": round(running, 6)})

    returns = [t.return_pct for t in trades]
    if n >= 2 and statistics.pstdev(returns) > 0:
        sharpe = round(statistics.mean(returns) / statistics.pstdev(returns), 4)
        sharpe_note = None
    else:
        sharpe = None
        sharpe_note = (
            f"Not computed: Sharpe needs return variance across multiple trades "
            f"(n={n}). Treat any Sharpe figure below ~30 trades as provisional even once it appears."
        )

    return {
        "trade_count": n,
        "win_rate_pct": win_rate_pct,
        "cumulative_pnl_usdt": cumulative_pnl,
        "cumulative_return_pct": cumulative_return_pct,
        "max_drawdown_usdt": round(max_dd_usdt, 6),
        "sharpe_ratio": sharpe,
        "sharpe_note": sharpe_note,
        "equity_curve": equity_curve,
        "sample_size_warning": (
            f"n={n} completed trades. Statistical metrics (Sharpe, drawdown-as-%-of-risk) "
            "are not reliable at this sample size - treat as provisional until n is much larger."
            if n < 30 else None
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log_path", help="Path to trades.paper.jsonl")
    parser.add_argument("--out", default=None, help="Write full JSON report to this path")
    parser.add_argument(
        "--allow-source", action="append", default=None,
        help=f"Provenance value(s) to include (default: {REQUIRED_SOURCE} only)",
    )
    args = parser.parse_args()

    allow_sources = args.allow_source or [REQUIRED_SOURCE]

    entries = load_log(args.log_path, allow_sources)
    trades, open_position_entry = reconstruct_trades(entries)
    metrics = compute_metrics(trades)

    report = {
        "data_source": {
            "log_path": args.log_path,
            "allowed_provenance": allow_sources,
            "note": "Computed exclusively from real Bitget paper-trading fills. Not synthetic, not a backtest.",
        },
        "metrics": metrics,
        "completed_trades": [asdict(t) for t in trades],
        "open_position": {
            "entry_time": open_position_entry["timestamp"],
            "entry_price": open_position_entry["execution"]["executedPrice"],
            "qty_base": open_position_entry["execution"]["executedQty"],
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
