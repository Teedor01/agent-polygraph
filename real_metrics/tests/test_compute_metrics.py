import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compute_metrics import load_log, reconstruct_trades, compute_metrics, REQUIRED_SOURCE


def _entry(ts, action, position_before, position_after, execution, symbol="BTCUSDT"):
    """Build one raw JSONL log line matching the Node agent's real schema."""
    return {
        "timestamp": ts,
        "source": REQUIRED_SOURCE,
        "environment": "paper",
        "symbol": symbol,
        "category": "SPOT",
        "market_state": {},
        "decision": {"action": action, "qty": 0, "rationale": "test"},
        "risk_verdict": {"approved": True, "approvedQty": 0, "reasons": []},
        "execution": execution,
        "position_before": position_before,
        "position_after": position_after,
    }


def _exec(status, price, qty, order_id, notional, fees):
    return {
        "orderId": order_id,
        "clientOid": f"c-{order_id}",
        "status": status,
        "executedQty": qty,
        "executedPrice": price,
        "fees": fees,
        "raw": {"place": {"orderId": order_id}, "detail": {"cumExecValue": str(notional), "orderStatus": "filled"}},
    }


FLAT = {"inPosition": False, "entryPrice": None, "entryQtyBase": None, "entryOrderId": None, "entryTimestamp": None}


def in_position(price, qty, order_id, ts):
    return {"inPosition": True, "entryPrice": price, "entryQtyBase": qty, "entryOrderId": order_id, "entryTimestamp": ts}


def _write_log(entries):
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False)
    for e in entries:
        f.write(json.dumps(e) + "\n")
    f.close()
    return f.name


def _run(entries, allow_sources=None):
    path = _write_log(entries)
    try:
        loaded = load_log(path, allow_sources or [REQUIRED_SOURCE])
        trades, open_pos = reconstruct_trades(loaded)
        metrics = compute_metrics(trades)
        return trades, open_pos, metrics
    finally:
        os.unlink(path)


def _round_trip(entry_price, entry_qty, entry_notional, entry_fees,
                 exit_price, exit_qty, exit_notional, exit_fees, symbol="BTCUSDT"):
    buy = _entry(
        "2026-01-01T00:00:00.000Z", "buy", FLAT,
        in_position(entry_price, entry_qty, "E1", "2026-01-01T00:00:00.000Z"),
        _exec("placed", entry_price, entry_qty, "E1", entry_notional, entry_fees),
        symbol=symbol,
    )
    sell = _entry(
        "2026-01-02T00:00:00.000Z", "sell", in_position(entry_price, entry_qty, "E1", "2026-01-01T00:00:00.000Z"), FLAT,
        _exec("placed", exit_price, exit_qty, "X1", exit_notional, exit_fees),
        symbol=symbol,
    )
    return [buy, sell]


class TestFeeCalculation(unittest.TestCase):
    """Each expected value is hand-computed in the docstring/comment,
    never taken from the module under test."""

    def test_profitable_trade_with_mixed_currency_fees(self):
        entries = _round_trip(
            100, 1, 100, [{"feeCoin": "BTC", "fee": "0.001"}],
            110, 1, 110, [{"feeCoin": "USDT", "fee": "0.05"}],
        )
        trades, _, metrics = _run(entries)
        self.assertEqual(len(trades), 1)
        t = trades[0]
        self.assertEqual(t.fee_data_status, "complete")
        self.assertAlmostEqual(t.gross_pnl_usdt, 10.0, places=6)
        self.assertAlmostEqual(t.total_fees_usdt, 0.15, places=6)
        self.assertAlmostEqual(t.net_pnl_usdt, 9.85, places=6)
        self.assertAlmostEqual(t.return_pct, 9.85, places=4)
        self.assertAlmostEqual(metrics["cumulative_pnl_usdt"], 9.85, places=6)

    def test_losing_trade_with_fees(self):
        entries = _round_trip(
            100, 1, 100, [{"feeCoin": "USDT", "fee": "0.1"}],
            90, 1, 90, [{"feeCoin": "USDT", "fee": "0.1"}],
        )
        trades, _, metrics = _run(entries)
        t = trades[0]
        self.assertAlmostEqual(t.gross_pnl_usdt, -10.0, places=6)
        self.assertAlmostEqual(t.net_pnl_usdt, -10.2, places=6)
        self.assertAlmostEqual(t.return_pct, -10.2, places=4)
        self.assertEqual(metrics["win_rate_pct"], 0.0)

    def test_zero_fee_trade_is_complete_not_missing(self):
        entries = _round_trip(100, 1, 100, [], 105, 1, 105, [])
        trades, _, metrics = _run(entries)
        t = trades[0]
        self.assertEqual(t.fee_data_status, "complete")
        self.assertAlmostEqual(t.total_fees_usdt, 0.0, places=6)
        self.assertAlmostEqual(t.net_pnl_usdt, 5.0, places=6)

    def test_missing_fee_information_leaves_net_pnl_none_not_zero(self):
        entries = _round_trip(100, 1, 100, None, 105, 1, 105, [{"feeCoin": "USDT", "fee": "0.05"}])
        trades, _, metrics = _run(entries)
        t = trades[0]
        self.assertEqual(t.fee_data_status, "missing_fee_data")
        self.assertIsNone(t.net_pnl_usdt)
        self.assertIsNone(t.total_fees_usdt)
        self.assertIsNone(t.return_pct)
        self.assertAlmostEqual(t.gross_pnl_usdt, 5.0, places=6)
        self.assertEqual(metrics["trades_with_incomplete_fee_data"], 1)
        self.assertIsNone(metrics["win_rate_pct"])

    def test_fee_denominated_in_base_coin(self):
        entries = _round_trip(200, 1, 200, [{"feeCoin": "BTC", "fee": "0.002"}], 210, 1, 210, [])
        trades, _, _ = _run(entries)
        t = trades[0]
        self.assertAlmostEqual(t.entry_fee_usdt, 0.4, places=6)
        self.assertAlmostEqual(t.net_pnl_usdt, 9.6, places=6)
        self.assertAlmostEqual(t.return_pct, 4.8, places=4)

    def test_fee_denominated_in_usdt_on_both_legs(self):
        entries = _round_trip(
            100, 1, 100, [{"feeCoin": "USDT", "fee": "0.2"}],
            100, 1, 100, [{"feeCoin": "USDT", "fee": "0.3"}],
        )
        trades, _, _ = _run(entries)
        t = trades[0]
        self.assertAlmostEqual(t.net_pnl_usdt, -0.5, places=6)

    def test_unrecognized_fee_currency_is_flagged_not_ignored(self):
        entries = _round_trip(
            100, 1, 100, [{"feeCoin": "ETH", "fee": "0.001"}],
            105, 1, 105, [{"feeCoin": "USDT", "fee": "0.01"}],
        )
        trades, _, _ = _run(entries)
        t = trades[0]
        self.assertEqual(t.fee_data_status, "unrecognized_fee_currency")
        self.assertIsNone(t.net_pnl_usdt)
        self.assertAlmostEqual(t.gross_pnl_usdt, 5.0, places=6)


class TestTradeReconstruction(unittest.TestCase):
    def test_hold_cycles_between_entry_and_exit_do_not_create_extra_trades(self):
        buy = _entry("2026-01-01T00:00:00Z", "buy", FLAT, in_position(100, 1, "E1", "t"),
                     _exec("placed", 100, 1, "E1", 100, [{"feeCoin": "USDT", "fee": "0.1"}]))
        hold1 = _entry("2026-01-01T01:00:00Z", "hold", in_position(100, 1, "E1", "t"), in_position(100, 1, "E1", "t"), None)
        hold2 = _entry("2026-01-01T02:00:00Z", "hold", in_position(100, 1, "E1", "t"), in_position(100, 1, "E1", "t"), None)
        sell = _entry("2026-01-01T03:00:00Z", "sell", in_position(100, 1, "E1", "t"), FLAT,
                      _exec("placed", 105, 1, "X1", 105, [{"feeCoin": "USDT", "fee": "0.1"}]))
        trades, open_pos, _ = _run([buy, hold1, hold2, sell])
        self.assertEqual(len(trades), 1)
        self.assertIsNone(open_pos)
        self.assertAlmostEqual(trades[0].holding_period_seconds, 3 * 3600, places=0)

    def test_unmatched_entry_reported_as_open_position_not_a_trade(self):
        buy = _entry("2026-01-01T00:00:00Z", "buy", FLAT, in_position(100, 1, "E1", "t"),
                     _exec("placed", 100, 1, "E1", 100, [{"feeCoin": "USDT", "fee": "0.1"}]))
        trades, open_pos, metrics = _run([buy])
        self.assertEqual(trades, [])
        self.assertIsNotNone(open_pos)
        self.assertEqual(open_pos["execution"]["executedPrice"], 100)
        self.assertEqual(metrics["trade_count"], 0)

    def test_errored_execution_does_not_open_a_phantom_position(self):
        """Malformed/incomplete record: position flags say 'opened' but
        the execution itself failed... reconstruction must not trust the
        position flags over the execution status."""
        malformed = _entry(
            "2026-01-01T00:00:00Z", "buy", FLAT, in_position(100, 1, "E1", "t"),
            {"orderId": None, "status": "error", "executedQty": None, "executedPrice": None, "fees": None, "raw": {}},
        )
        sell_with_nothing_open = _entry(
            "2026-01-01T01:00:00Z", "sell", in_position(100, 1, "E1", "t"), FLAT,
            _exec("placed", 105, 1, "X1", 105, [{"feeCoin": "USDT", "fee": "0.1"}]),
        )
        trades, open_pos, _ = _run([malformed, sell_with_nothing_open])
        self.assertEqual(trades, [])
        self.assertIsNone(open_pos)

    def test_source_filtering_excludes_mock_lines(self):
        real_buy = _entry("2026-01-01T00:00:00Z", "buy", FLAT, in_position(100, 1, "E1", "t"),
                          _exec("placed", 100, 1, "E1", 100, [{"feeCoin": "USDT", "fee": "0.1"}]))
        mock_line = dict(real_buy)
        mock_line["source"] = "bitget_mock"
        mock_line["timestamp"] = "2026-01-01T00:30:00Z"
        real_sell = _entry("2026-01-01T01:00:00Z", "sell", in_position(100, 1, "E1", "t"), FLAT,
                           _exec("placed", 105, 1, "X1", 105, [{"feeCoin": "USDT", "fee": "0.1"}]))
        path = _write_log([real_buy, mock_line, real_sell])
        try:
            loaded = load_log(path, [REQUIRED_SOURCE])
        finally:
            os.unlink(path)
        self.assertEqual(len(loaded), 2)  
        for e in loaded:
            self.assertEqual(e["source"], REQUIRED_SOURCE)


class TestAggregateMetrics(unittest.TestCase):
    def test_win_rate_across_three_trades(self):
        entries = []
        entries += _round_trip(100, 1, 100, [{"feeCoin": "USDT", "fee": "0"}], 110, 1, 110, [{"feeCoin": "USDT", "fee": "0"}])
        entries += _round_trip(100, 1, 100, [{"feeCoin": "USDT", "fee": "0.1"}], 90, 1, 90, [{"feeCoin": "USDT", "fee": "0.1"}])
        entries += _round_trip(200, 1, 200, [{"feeCoin": "BTC", "fee": "0.002"}], 210, 1, 210, [])
        for i, e in enumerate(entries):
            e["timestamp"] = f"2026-01-{i+1:02d}T00:00:00Z"
        trades, _, metrics = _run(entries)
        self.assertEqual(len(trades), 3)
        self.assertAlmostEqual(metrics["win_rate_pct"], 66.67, places=1)

    def test_max_drawdown_from_a_known_sequence(self):
        entries = []
        entries += _round_trip(100, 1, 100, [{"feeCoin": "USDT", "fee": "0"}], 110, 1, 110, [{"feeCoin": "USDT", "fee": "0"}])
        entries += _round_trip(100, 1, 100, [{"feeCoin": "USDT", "fee": "0"}], 85, 1, 85, [{"feeCoin": "USDT", "fee": "0"}])
        entries += _round_trip(100, 1, 100, [{"feeCoin": "USDT", "fee": "0"}], 103, 1, 103, [{"feeCoin": "USDT", "fee": "0"}])
        for i, e in enumerate(entries):
            e["timestamp"] = f"2026-01-{i+1:02d}T00:00:00Z"
        trades, _, metrics = _run(entries)
        self.assertEqual([t.net_pnl_usdt for t in trades], [10.0, -15.0, 3.0])
        self.assertAlmostEqual(metrics["max_drawdown_usdt"], 15.0, places=6)

    def test_sharpe_null_below_two_trades(self):
        entries = _round_trip(100, 1, 100, [{"feeCoin": "USDT", "fee": "0.1"}], 110, 1, 110, [{"feeCoin": "USDT", "fee": "0.1"}])
        _, _, metrics = _run(entries)
        self.assertIsNone(metrics["sharpe_ratio"])
        self.assertIsNotNone(metrics["sharpe_note"])

    def test_sample_size_warning_present_below_thirty_trades(self):
        entries = _round_trip(100, 1, 100, [{"feeCoin": "USDT", "fee": "0.1"}], 110, 1, 110, [{"feeCoin": "USDT", "fee": "0.1"}])
        _, _, metrics = _run(entries)
        self.assertIsNotNone(metrics["sample_size_warning"])

    def test_zero_completed_trades_stays_null_not_zero(self):
        _, _, metrics = _run([])
        self.assertEqual(metrics["trade_count"], 0)
        self.assertIsNone(metrics["win_rate_pct"])
        self.assertIsNone(metrics["cumulative_pnl_usdt"])
        self.assertIsNone(metrics["sharpe_ratio"])

    def test_all_trades_fee_incomplete_yields_null_aggregate_not_partial_fabrication(self):
        entries = _round_trip(100, 1, 100, None, 105, 1, 105, [{"feeCoin": "USDT", "fee": "0.1"}])
        _, _, metrics = _run(entries)
        self.assertEqual(metrics["trade_count"], 1)
        self.assertEqual(metrics["trades_with_incomplete_fee_data"], 1)
        self.assertIsNone(metrics["win_rate_pct"])
        self.assertIsNone(metrics["cumulative_pnl_usdt"])
        self.assertIn("fee data is incomplete", metrics["warning"])


if __name__ == "__main__":
    unittest.main()
