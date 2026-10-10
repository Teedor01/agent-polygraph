"""Persistent Spot run history.

main.py overwrites frontend/data/report.json on every run. This module keeps one
summary row per run in frontend/data/runs/spot-index.json so earlier runs are
never lost. Each run's specimen and baseline reports are also stored IN FULL (verbatim JSON,
~1.7 MB each) under runs/, so a past run can be reopened with every scenario.

Nothing is invented: legacy reports are imported only from files that exist, with
the timestamp taken from meta.json, and flagged `imported`.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone

HISTORY_FILE = "spot-index.json"


def _kind(summary: dict, role: str) -> str:
    if role == "baseline":
        return "deterministic"
    return "simulated_specimen" if summary.get("is_simulated") else "llm"


def summarize(summary: dict, role: str, generated_at: str, seed, agent_mode: str,
              run_id: str | None = None, provider=None, model=None, imported: dict | None = None,
              file: str | None = None) -> dict:
    row = {
        "runId": run_id or str(uuid.uuid4()),
        "market": "spot",
        "role": role,  # "specimen" or "baseline"
        "kind": _kind(summary, role),
        "agent": summary["agent_name"],
        "agentMode": agent_mode,
        "provider": provider,
        "model": model,
        "generatedAt": generated_at,
        "seed": seed,
        "scenarios": summary["total_tests"],
        "passed": summary["passed"],
        "failed": summary["failed"],
        "riskViolations": summary["risk_violations"],
        "decisionInconsistencies": summary["decision_inconsistencies"],
        "providerFailures": summary.get("timeout_or_provider_failures", 0),
        "invalidActions": summary.get("invalid_actions", 0),
        "malformedOutputs": summary.get("malformed_outputs", 0),
        "failureCategories": summary.get("failure_categories", {}),
        "scores": {k: v for k, v in summary.get("scores", {}).items() if not k.startswith("_")},
        "file": file,  # full verbatim report for this run, relative to runs/
        "detail": "full" if file else "summary_only",
    }
    if imported:
        row["imported"] = imported
    return row


def load(data_dir: str) -> list:
    path = os.path.join(data_dir, "runs", HISTORY_FILE)
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f)  # a corrupt index raises rather than being silently replaced


def append(data_dir: str, rows: list) -> list:
    os.makedirs(os.path.join(data_dir, "runs"), exist_ok=True)
    existing = load(data_dir)
    seen = {r["runId"] for r in existing}
    existing.extend(r for r in rows if r["runId"] not in seen)
    existing.sort(key=lambda r: r["generatedAt"], reverse=True)
    with open(os.path.join(data_dir, "runs", HISTORY_FILE), "w") as f:
        json.dump(existing, f, indent=2)
    return existing


def _stamp(unix: int) -> str:
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y%m%d%H%M%S")


def _write_json(path: str, obj) -> None:
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)


def record_run(data_dir: str, specimen_report: dict, baseline_report: dict, meta: dict) -> list:
    runs_dir = os.path.join(data_dir, "runs")
    os.makedirs(runs_dir, exist_ok=True)
    ts = datetime.fromtimestamp(meta["generated_at_unix"], tz=timezone.utc).isoformat()
    mode = meta.get("agent_mode", "simulated")
    provider = os.environ.get("LLM_PROVIDER") if mode != "simulated" else None
    model = os.environ.get("LLM_MODEL") if mode != "simulated" else None
    rid = uuid.uuid4().hex[:8]
    base = f"spot-{_stamp(meta['generated_at_unix'])}-{rid}"
    _write_json(os.path.join(runs_dir, f"{base}-specimen.json"), specimen_report)
    _write_json(os.path.join(runs_dir, f"{base}-baseline.json"), baseline_report)
    return append(data_dir, [
        summarize(specimen_report["summary"], "specimen", ts, meta["seed"], mode, run_id=f"{base}-specimen",
                  provider=provider, model=model, file=f"{base}-specimen.json"),
        summarize(baseline_report["summary"], "baseline", ts, meta["seed"], "rule-based",
                  run_id=f"{base}-baseline", file=f"{base}-baseline.json"),
    ])


def import_existing(data_dir: str) -> list:
    """Import the currently saved report.json/baseline_report.json/meta.json (if all exist), copying the
    report files VERBATIM. Re-importing the same saved files is a no-op."""
    paths = {n: os.path.join(data_dir, n) for n in ("report.json", "baseline_report.json", "meta.json")}
    missing = [n for n, p in paths.items() if not os.path.exists(p)]
    if missing:
        raise FileNotFoundError(f"cannot import, missing: {', '.join(missing)}")
    raw = {n: open(p, "rb").read() for n, p in paths.items()}
    loaded = {n: json.loads(b) for n, b in raw.items()}
    meta = loaded["meta.json"]
    ts = datetime.fromtimestamp(meta["generated_at_unix"], tz=timezone.utc).isoformat()
    note = {"from": "frontend/data/report.json + baseline_report.json + meta.json",
            "note": "Imported verbatim from the reports saved at the time; timestamp from meta.json. Model/provider were not recorded."}
    base = f"spot-{meta['generated_at_unix']}-{meta['seed']}"
    runs_dir = os.path.join(data_dir, "runs")
    os.makedirs(runs_dir, exist_ok=True)
    rows = []
    for role, name in (("specimen", "report.json"), ("baseline", "baseline_report.json")):
        fname = f"{base}-{role}.json"
        with open(os.path.join(runs_dir, fname), "wb") as f:
            f.write(raw[name])
        rows.append(summarize(loaded[name]["summary"], role, ts, meta["seed"],
                              meta.get("agent_mode", "simulated") if role == "specimen" else "rule-based",
                              run_id=f"{base}-{role}", imported=note, file=fname))
    return append(data_dir, rows)


if __name__ == "__main__":
    import sys
    d = os.path.join(os.path.dirname(__file__), "..", "frontend", "data")
    if "--import" in sys.argv:
        rows = import_existing(d)
        print(f"history now has {len(rows)} spot rows")
    else:
        print("usage: python3 backend/history.py --import")
