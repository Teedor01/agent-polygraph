from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import List, Optional, Tuple


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
    gross_pnl_usdt: float          
    entry_fee_usdt: Optional[float]
    exit_fee_usdt: Optional[float]
    total_fees_usdt: Optional[float]
    net_pnl_usdt: Optional[float]  
    fee_data_status: str           
    return_pct: Optional[float]    
    holding_period_seconds: float
    entry_decision_source: str         
    entry_llm_reason: Optional[str]
    entry_llm_confidence: Optional[float]
    exit_decision_source: str
    exit_llm_reason: Optional[str]
    exit_llm_confidence: Optional[float]


def _extract_decision_provenance(log_line: dict) -> Tuple[str, Optional[str], Optional[float]]:
    """Pulls decision_source/llm_meta straight from one raw JSONL record.
    Older log lines recorded before decision_source existed default to
    "deterministic" - accurate, since that was the only mode that
    existed at the time, not a guess. Never fabricates a reason or
    confidence that wasn't actually logged."""
    source = log_line.get("decision_source", "deterministic")
    llm_meta = log_line.get("llm_meta")
    raw = llm_meta.get("raw") if isinstance(llm_meta, dict) else None
    reason = raw.get("reason") if isinstance(raw, dict) else None
    confidence = raw.get("confidence") if isinstance(raw, dict) else None
    return source, reason, confidence


def _parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _base_coin_for(symbol: str) -> Optional[str]:
    """BTCUSDT -> BTC. Generic strip of a USDT quote suffix, not
    hardcoded to one symbol, since the instrument is read from the log,
    not assumed."""
    if symbol and symbol.endswith("USDT"):
        return symbol[: -len("USDT")]
    return None


def _extract_fee_usdt(fees_raw, leg_price: Optional[float], base_coin: Optional[str]) -> Tuple[Optional[float], str]:
    """Convert one leg's fee record(s) to a USDT amount.

    fees_raw is the ExecutionResult.fees value as logged by the Node
    agent: None (no fee info recorded), [] (recorded as genuinely zero
    fees), or a list of {"feeCoin": ..., "fee": "..."} dicts.

    Returns (amount_or_None, status). amount is None whenever the fee
    cannot be honestly resolved to a USDT figure... never a guessed 0.
    """
    if fees_raw is None:
        return None, "missing_fee_data"
    if not isinstance(fees_raw, list):
        return None, "missing_fee_data"

    total = 0.0
    for f in fees_raw:
        if not isinstance(f, dict):
            return None, "missing_fee_data"
        coin = f.get("feeCoin")
        raw_amount = f.get("fee")
        if raw_amount is None:
            return None, "missing_fee_data"
        try:
            amount = float(raw_amount)
        except (TypeError, ValueError):
            return None, "missing_fee_data"

        if coin == "USDT":
            total += amount
        elif base_coin is not None and coin == base_coin:
            if leg_price is None:
                return None, "missing_fee_data" 
            total += amount * leg_price
        else:
            return None, "unrecognized_fee_currency"

    return total, "complete"  


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
            f"(e.g. mock runs), official metrics never include them.",
            file=sys.stderr,
        )
    return entries


def reconstruct_trades(entries: List[dict]) -> Tuple[List[CompletedTrade], Optional[dict]]:
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
            symbol = entry.get("symbol") or pending_entry.get("symbol")
            base_coin = _base_coin_for(symbol)

            entry_price = entry_exec.get("executedPrice")
            exit_price = exit_exec.get("executedPrice")
            qty_base = entry_exec.get("executedQty")

            entry_raw_detail = entry_exec.get("raw", {}).get("detail", {}) or {}
            exit_raw_detail = exit_exec.get("raw", {}).get("detail", {}) or {}
            entry_notional = float(entry_raw_detail.get("cumExecValue") or entry_raw_detail.get("amount") or 0)
            exit_notional = float(exit_raw_detail.get("cumExecValue") or 0)

            gross_pnl = exit_notional - entry_notional

            entry_fee_usdt, entry_fee_status = _extract_fee_usdt(entry_exec.get("fees"), entry_price, base_coin)
            exit_fee_usdt, exit_fee_status = _extract_fee_usdt(exit_exec.get("fees"), exit_price, base_coin)

            if entry_fee_status == "complete" and exit_fee_status == "complete":
                total_fees = round(entry_fee_usdt + exit_fee_usdt, 8)
                net_pnl = round(gross_pnl - total_fees, 6)
                return_pct = round(net_pnl / entry_notional * 100, 4) if entry_notional else None
                fee_status = "complete"
            else:
                total_fees = None
                net_pnl = None
                return_pct = None
                fee_status = (
                    "unrecognized_fee_currency"
                    if "unrecognized_fee_currency" in (entry_fee_status, exit_fee_status)
                    else "missing_fee_data"
                )

            t_entry = _parse_ts(pending_entry["timestamp"])
            t_exit = _parse_ts(entry["timestamp"])
            entry_source, entry_llm_reason, entry_llm_confidence = _extract_decision_provenance(pending_entry)
            exit_source, exit_llm_reason, exit_llm_confidence = _extract_decision_provenance(entry)

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
                gross_pnl_usdt=round(gross_pnl, 6),
                entry_fee_usdt=round(entry_fee_usdt, 8) if entry_fee_usdt is not None else None,
                exit_fee_usdt=round(exit_fee_usdt, 8) if exit_fee_usdt is not None else None,
                total_fees_usdt=total_fees,
                net_pnl_usdt=net_pnl,
                fee_data_status=fee_status,
                return_pct=return_pct,
                holding_period_seconds=(t_exit - t_entry).total_seconds(),
                entry_decision_source=entry_source,
                entry_llm_reason=entry_llm_reason,
                entry_llm_confidence=entry_llm_confidence,
                exit_decision_source=exit_source,
                exit_llm_reason=exit_llm_reason,
                exit_llm_confidence=exit_llm_confidence,
            ))
            pending_entry = None

    return completed, pending_entry


def compute_metrics(trades: List[CompletedTrade]) -> dict:
    n = len(trades)
    if n == 0:
        return {
            "trade_count": 0,
            "warning": "No completed round-trip trades yet - all metrics below are undefined, not zero.",
            "win_rate_pct": None,
            "cumulative_pnl_usdt": None,
            "cumulative_return_pct": None,
            "max_drawdown_usdt": None,
            "sharpe_ratio": None,
            "equity_curve": [],
            "trades_with_incomplete_fee_data": 0,
        }

    fee_ok = [t for t in trades if t.net_pnl_usdt is not None]
    incomplete = n - len(fee_ok)
    fee_data_warning = (
        f"{incomplete} of {n} completed trade(s) excluded from P&L/win-rate/Sharpe below because their "
        f"fee data was missing or in an unrecognized currency... see fee_data_status on each trade."
        if incomplete else None
    )

    if not fee_ok:
        return {
            "trade_count": n,
            "warning": f"{n} completed round trip(s) found, but fee data is incomplete for all of them - "
                       f"net P&L cannot be honestly computed. See each trade's gross_pnl_usdt and fee_data_status.",
            "win_rate_pct": None,
            "cumulative_pnl_usdt": None,
            "cumulative_return_pct": None,
            "max_drawdown_usdt": None,
            "sharpe_ratio": None,
            "equity_curve": [],
            "trades_with_incomplete_fee_data": incomplete,
            "fee_data_warning": fee_data_warning,
        }

    m = len(fee_ok)
    wins = sum(1 for t in fee_ok if t.net_pnl_usdt > 0)
    win_rate_pct = round(wins / m * 100, 2)

    cumulative_pnl = round(sum(t.net_pnl_usdt for t in fee_ok), 6)
    total_deployed = sum(t.entry_notional_usdt for t in fee_ok)
    cumulative_return_pct = round(cumulative_pnl / total_deployed * 100, 4) if total_deployed else None

    equity_curve = []
    running = 0.0
    peak = 0.0
    max_dd_usdt = 0.0
    for t in fee_ok:
        running += t.net_pnl_usdt
        peak = max(peak, running)
        drawdown = peak - running
        max_dd_usdt = max(max_dd_usdt, drawdown)
        equity_curve.append({"exit_time": t.exit_time, "cumulative_pnl_usdt": round(running, 6)})

    returns = [t.return_pct for t in fee_ok]
    if m >= 2 and statistics.pstdev(returns) > 0:
        sharpe = round(statistics.mean(returns) / statistics.pstdev(returns), 4)
        sharpe_note = None
    else:
        sharpe = None
        sharpe_note = (
            f"Not computed: Sharpe needs return variance across multiple fee-complete trades "
            f"(n={m}). Treat any Sharpe figure below ~30 trades as provisional even once it appears."
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
        "trades_with_incomplete_fee_data": incomplete,
        "fee_data_warning": fee_data_warning,
        "sample_size_warning": (
            f"n={m} fee-complete completed trades. Statistical metrics (Sharpe, drawdown-as-%-of-risk) "
            "are not reliable at this sample size - treat as provisional until n is much larger."
            if m < 30 else None
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
            "entry_decision_source": _extract_decision_provenance(open_position_entry)[0],
            "entry_llm_reason": _extract_decision_provenance(open_position_entry)[1],
            "entry_llm_confidence": _extract_decision_provenance(open_position_entry)[2],
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
