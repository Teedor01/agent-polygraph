from __future__ import annotations

import json
import os
import sys
import time

from scenarios import generate_scenarios, SEED
from agents import RuleBasedAgent, SimulatedAgent, LLMAgentOpenAICompatible, LLMAgentAnthropic
import evaluator

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "data")


def build_specimen_agent():
    mode = os.environ.get("AGENT_MODE", "simulated")
    if mode == "simulated":
        return SimulatedAgent()
    if mode == "llm-openai":
        return LLMAgentOpenAICompatible()
    if mode == "llm-anthropic":
        return LLMAgentAnthropic()
    raise ValueError(f"unknown AGENT_MODE={mode!r}")


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    t0 = time.time()

    scenarios = generate_scenarios()
    print(f"generated {len(scenarios)} scenarios (seed={SEED})", file=sys.stderr)

    specimen = build_specimen_agent()
    print(f"running specimen agent: {specimen.name} (simulated={specimen.is_simulated})", file=sys.stderr)
    specimen_report = evaluator.run(specimen, scenarios)

    baseline = RuleBasedAgent()
    print(f"running baseline agent: {baseline.name}", file=sys.stderr)
    baseline_scenarios = generate_scenarios()  # identical, fresh copy - same seed, same order
    baseline_report = evaluator.run(baseline, baseline_scenarios)

    with open(os.path.join(DATA_DIR, "report.json"), "w") as f:
        json.dump(specimen_report, f, indent=2)
    with open(os.path.join(DATA_DIR, "baseline_report.json"), "w") as f:
        json.dump(baseline_report, f, indent=2)

    meta = {
        "seed": SEED,
        "agent_mode": os.environ.get("AGENT_MODE", "simulated"),
        "specimen_agent_name": specimen.name,
        "specimen_is_simulated": specimen.is_simulated,
        "scenario_count": len(scenarios),
        "generated_at_unix": int(time.time()),
        "elapsed_seconds": round(time.time() - t0, 2),
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    print(json.dumps(specimen_report["summary"], indent=2))
    print(f"\nwrote reports to {os.path.abspath(DATA_DIR)} in {meta['elapsed_seconds']}s", file=sys.stderr)


if __name__ == "__main__":
    main()
