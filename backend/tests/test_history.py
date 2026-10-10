import json, os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import history


def _summary(name, simulated, total=10, passed=7):
    return {"agent_name": name, "is_simulated": simulated, "total_tests": total, "passed": passed,
            "failed": total - passed, "risk_violations": 2, "decision_inconsistencies": 1,
            "timeout_or_provider_failures": 0, "failure_categories": {"risk_violation": 2},
            "scores": {"reliability": 70.0, "_formulas": {"x": "y"}}}


class SpotHistoryTests(unittest.TestCase):
    def _write(self, d, meta_ts=1789486392):
        for n, s in (("report.json", _summary("Simulated Specimen Agent", True)),
                     ("baseline_report.json", _summary("Fixed-Rule Baseline", False, passed=9))):
            json.dump({"summary": s}, open(os.path.join(d, n), "w"))
        json.dump({"seed": 1, "agent_mode": "simulated", "generated_at_unix": meta_ts}, open(os.path.join(d, "meta.json"), "w"))

    def test_import_is_idempotent_and_flagged(self):
        with tempfile.TemporaryDirectory() as d:
            self._write(d)
            self.assertEqual(len(history.import_existing(d)), 2)
            self.assertEqual(len(history.import_existing(d)), 2)  # re-import adds nothing
            rows = history.load(d)
            self.assertTrue(all("imported" in r for r in rows))
            self.assertEqual({r["kind"] for r in rows}, {"simulated_specimen", "deterministic"})

    def test_new_run_does_not_overwrite_old(self):
        with tempfile.TemporaryDirectory() as d:
            self._write(d, meta_ts=1000)
            history.import_existing(d)
            self._write(d, meta_ts=2000)
            sp = json.load(open(os.path.join(d, "report.json")))
            bl = json.load(open(os.path.join(d, "baseline_report.json")))
            meta = json.load(open(os.path.join(d, "meta.json")))
            history.record_run(d, sp, bl, meta)
            self.assertEqual(len(history.load(d)), 4)

    def test_full_reports_are_stored_verbatim_and_new_runs_add_files(self):
        with tempfile.TemporaryDirectory() as d:
            self._write(d, meta_ts=1000)
            history.import_existing(d)
            rows = history.load(d)
            self.assertTrue(all(r["detail"] == "full" for r in rows))
            spec = [r for r in rows if r["role"] == "specimen"][0]
            self.assertEqual(open(os.path.join(d, "runs", spec["file"]), "rb").read(),
                             open(os.path.join(d, "report.json"), "rb").read())
            self._write(d, meta_ts=2000)
            history.record_run(d, json.load(open(os.path.join(d, "report.json"))),
                               json.load(open(os.path.join(d, "baseline_report.json"))),
                               json.load(open(os.path.join(d, "meta.json"))))
            files = [f for f in os.listdir(os.path.join(d, "runs")) if f.startswith("spot-") and f != "spot-index.json"]
            self.assertEqual(len(files), 4)  # 2 imported + 2 new, none overwritten

    def test_formulas_not_stored_as_scores_and_missing_files_refused(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(FileNotFoundError):
                history.import_existing(d)
            self._write(d)
            history.import_existing(d)
            self.assertNotIn("_formulas", history.load(d)[0]["scores"])


if __name__ == "__main__":
    unittest.main()
