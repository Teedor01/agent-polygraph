import json
import unittest
from pathlib import Path

from polygraph_ingestion.synthetic_adapter import load_synthetic_report, DEFAULT_SYNTHETIC_REPORT_PATH
from polygraph_ingestion.real_trading_adapter import (
    load_real_trading_report,
    RealReportProvenanceError,
)
from polygraph_ingestion.boundary import get_polygraph_view

FIXTURES = Path(__file__).parent / "fixtures"


class TestSyntheticAdapter(unittest.TestCase):
    def test_loads_the_real_existing_synthetic_report_unchanged(self):
        """Uses the actual frontend/data/report.json produced by
        backend/main.py, to prove the synthetic harness
        genuinely still works and is read, not modified."""
        if not DEFAULT_SYNTHETIC_REPORT_PATH.exists():
            self.skipTest("frontend/data/report.json not present - run backend/main.py first")

        before_bytes = DEFAULT_SYNTHETIC_REPORT_PATH.read_bytes()
        result = load_synthetic_report()
        after_bytes = DEFAULT_SYNTHETIC_REPORT_PATH.read_bytes()

        self.assertEqual(before_bytes, after_bytes, "loading must never modify the synthetic report file")
        self.assertEqual(result["provenance"], "synthetic_crash_test")
        self.assertIn("Not historical", result["source_note"])
        self.assertIn("summary", result["report"])  

    def test_missing_synthetic_report_raises_clearly(self):
        with self.assertRaises(FileNotFoundError):
            load_synthetic_report(path=FIXTURES / "does_not_exist.json")


class TestRealTradingAdapter(unittest.TestCase):
    def test_loads_valid_real_report(self):
        result = load_real_trading_report(path=FIXTURES / "real_report_valid.json")
        self.assertEqual(result["provenance"], "bitget_paper_real_trading")
        self.assertEqual(result["report"]["metrics"]["trade_count"], 1)
        self.assertEqual(result["report"]["metrics"]["cumulative_pnl_usdt"], -0.044407)

    def test_zero_trades_stays_null_not_fabricated(self):
        result = load_real_trading_report(path=FIXTURES / "real_report_zero_trades.json")
        metrics = result["report"]["metrics"]
        self.assertEqual(metrics["trade_count"], 0)
        self.assertIsNone(metrics["win_rate_pct"])
        self.assertIsNone(metrics["sharpe_ratio"])
        self.assertIsNone(metrics["cumulative_pnl_usdt"])
        self.assertIsNotNone(result["report"]["open_position"])
        self.assertEqual(result["report"]["completed_trades"], [])

    def test_refuses_mock_tainted_provenance(self):
        with self.assertRaises(RealReportProvenanceError):
            load_real_trading_report(path=FIXTURES / "real_report_poisoned_mock.json")

    def test_refuses_missing_provenance_declaration(self):
        with self.assertRaises(RealReportProvenanceError):
            load_real_trading_report(path=FIXTURES / "real_report_missing_provenance.json")

    def test_missing_file_raises_clearly(self):
        with self.assertRaises(FileNotFoundError):
            load_real_trading_report(path=FIXTURES / "does_not_exist.json")


class TestIngestionBoundaryNeverMerges(unittest.TestCase):
    def test_synthetic_and_real_are_separate_top_level_keys(self):
        if not DEFAULT_SYNTHETIC_REPORT_PATH.exists():
            self.skipTest("frontend/data/report.json not present - run backend/main.py first")

        view = get_polygraph_view(real_path=FIXTURES / "real_report_valid.json")

        self.assertEqual(set(view.keys()), {"synthetic", "real"})
        self.assertEqual(view["synthetic"]["provenance"], "synthetic_crash_test")
        self.assertEqual(view["real"]["provenance"], "bitget_paper_real_trading")
        self.assertNotIn("metrics", view["synthetic"]["report"])
        self.assertNotIn("completed_trades", view["synthetic"]["report"])
        self.assertNotIn("summary", view["real"]["report"])
        self.assertNotIn("tests", view["real"]["report"])

    def test_missing_real_report_degrades_gracefully_without_breaking_synthetic(self):
        if not DEFAULT_SYNTHETIC_REPORT_PATH.exists():
            self.skipTest("frontend/data/report.json not present - run backend/main.py first")

        view = get_polygraph_view(real_path=FIXTURES / "does_not_exist.json")
        self.assertIsNotNone(view["synthetic"]["report"])
        self.assertIsNone(view["real"]["report"])
        self.assertIn("unavailable_reason", view["real"])

    def test_poisoned_real_report_raises_rather_than_silently_serving_it(self):
        if not DEFAULT_SYNTHETIC_REPORT_PATH.exists():
            self.skipTest("frontend/data/report.json not present - run backend/main.py first")

        with self.assertRaises(RealReportProvenanceError):
            get_polygraph_view(real_path=FIXTURES / "real_report_poisoned_mock.json")


if __name__ == "__main__":
    unittest.main()
