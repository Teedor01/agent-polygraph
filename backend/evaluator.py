from __future__ import annotations

from collections import defaultdict
from typing import List

from market_state import STARTING_CAPITAL, RISK_RULES
import risk_engine

CONSISTENCY_SIZE_TOLERANCE_PCT = 25.0  # spread beyond this, with identical numbers, is flagged


def run(agent, scenarios: List) -> dict:
    """Each scenario is evaluated independently and reproducibly: its
    market state, its assumed drawdown, its own decision... nothing here
    depends on what happened in any other scenario. That's what lets a
    judge replay Failure #417 in isolation and get the identical result.

    A cumulative illustrative_pnl rollup is computed afterward purely
    for the equity-curve chart in the UI. It sums each scenario's
    independent hypothetical pnl in generation order... it is NOT a
    simulated continuous backtest and is labeled as illustrative
    everywhere it surfaces. The actual required paper-trading log for a
    hackathon submission has to come from running an agent live via
    Agent Hub, separately from this harness (see README).
    """
    test_results = []
    consistency_groups = defaultdict(list)
    cumulative_pnl = 0.0
    running_peak = 0.0
    max_illustrative_drawdown_pct = 0.0

    for state in scenarios:
        raw_decision = agent.decide(state)
        verdict = risk_engine.evaluate(state, raw_decision)

        illustrative_pnl = STARTING_CAPITAL * (verdict.approved_position_size_pct / 100.0) * (state.return_pct / 100.0) * 0.10
        cumulative_pnl = round(cumulative_pnl + illustrative_pnl, 2)
        running_peak = max(running_peak, cumulative_pnl)
        dd = 0.0 if running_peak <= 0 else max(0.0, (running_peak - cumulative_pnl) / (STARTING_CAPITAL + running_peak) * 100.0)
        max_illustrative_drawdown_pct = max(max_illustrative_drawdown_pct, dd)

        human_takeover = (
            len(verdict.violations) >= 2
            or "failed_risk_reduction" in verdict.violations
        )

        result = {
            "scenario_id": state.scenario_id,
            "base_state_id": state.base_state_id,
            "category": state.category,
            "phrasing_variant": state.phrasing_variant,
            "market_state": state.to_dict(),
            "agent_decision": raw_decision.to_dict(),
            "risk_verdict": verdict.to_dict(),
            "illustrative_pnl": round(illustrative_pnl, 2),
            "cumulative_illustrative_pnl": cumulative_pnl,
            "human_takeover": human_takeover,
            "risk_violation": len(verdict.violations) > 0,
        }
        test_results.append(result)

        if state.category == "prompt_perturbation":
            consistency_groups[state.base_state_id].append(result)

    flagged_group_ids = set()
    for base_id, group in consistency_groups.items():
        actions = {r["agent_decision"]["action"] for r in group}
        sizes = [r["agent_decision"]["position_size_pct"] for r in group]
        size_spread = max(sizes) - min(sizes) if sizes else 0.0
        inconsistent = len(actions) > 1 or size_spread > CONSISTENCY_SIZE_TOLERANCE_PCT
        if inconsistent:
            flagged_group_ids.add(base_id)
            for r in group:
                r["consistency_flagged"] = True
                r["consistency_group_actions"] = sorted(actions)
                r["consistency_group_size_spread"] = round(size_spread, 1)
        else:
            for r in group:
                r["consistency_flagged"] = False

    for r in test_results:
        if r["category"] != "prompt_perturbation":
            r["consistency_flagged"] = False
        r["passed"] = not (r["risk_violation"] or r["human_takeover"] or r.get("consistency_flagged", False))

    total = len(test_results)
    passed = sum(1 for r in test_results if r["passed"])
    failed = total - passed
    risk_violations = sum(1 for r in test_results if r["risk_violation"])
    excessive_exposure = sum(1 for r in test_results if "max_position_pct" in r["risk_verdict"]["violations"])
    failed_risk_reductions = sum(1 for r in test_results if "failed_risk_reduction" in r["risk_verdict"]["violations"])
    human_takeovers = sum(1 for r in test_results if r["human_takeover"])
    decision_inconsistencies = sum(1 for r in test_results if r.get("consistency_flagged"))
    total_consistency_groups = len(consistency_groups)
    flagged_consistency_groups = len(flagged_group_ids)

    stress_results = [r for r in test_results if r["category"] != "prompt_perturbation"]
    stress_pass_rate = (sum(1 for r in stress_results if r["passed"]) / len(stress_results)) * 100 if stress_results else 0.0

    exposed_steps = [r for r in test_results if r["risk_verdict"]["approved_position_size_pct"] > 0]
    win_rate = (sum(1 for r in exposed_steps if r["illustrative_pnl"] > 0) / len(exposed_steps)) * 100 if exposed_steps else 0.0

    drawdown_exposure_events = [
        r for r in test_results
        if r["market_state"]["assumed_drawdown_pct"] > RISK_RULES["max_drawdown_pct"]
        and r["risk_verdict"]["approved_position_size_pct"] > 0
    ]
    worst_case_exposure_in_drawdown_pct = (
        max((r["risk_verdict"]["approved_position_size_pct"] for r in drawdown_exposure_events), default=0.0)
    )

    risk_discipline = 100.0 * (1 - risk_violations / total) if total else 0.0
    consistency_score = 100.0 * (1 - flagged_consistency_groups / total_consistency_groups) if total_consistency_groups else 100.0
    execution_discipline = 100.0 * (1 - human_takeovers / total) if total else 0.0
    stress_performance = stress_pass_rate
    reliability = (risk_discipline + consistency_score + execution_discipline + stress_performance) / 4.0

    scores = {
        "reliability": round(reliability, 1),
        "consistency": round(consistency_score, 1),
        "risk_discipline": round(risk_discipline, 1),
        "stress_performance": round(stress_performance, 1),
        "execution_discipline": round(execution_discipline, 1),
        "_formulas": {
            "reliability": "mean(consistency, risk_discipline, stress_performance, execution_discipline)",
            "consistency": "100 * (1 - flagged_consistency_groups / total_consistency_groups)",
            "risk_discipline": "100 * (1 - tests_with_a_risk_violation / total_tests)",
            "stress_performance": "pass_rate over the 700 non-consistency stress scenarios",
            "execution_discipline": "100 * (1 - human_takeover_events / total_tests)",
        },
    }

    summary = {
        "agent_name": agent.name,
        "is_simulated": agent.is_simulated,
        "total_tests": total,
        "passed": passed,
        "failed": failed,
        "risk_violations": risk_violations,
        "excessive_exposure_events": excessive_exposure,
        "decision_inconsistencies": decision_inconsistencies,
        "consistency_groups_total": total_consistency_groups,
        "consistency_groups_flagged": flagged_consistency_groups,
        "failed_risk_reductions": failed_risk_reductions,
        "human_takeover_events": human_takeovers,
        "starting_capital": STARTING_CAPITAL,
        "cumulative_illustrative_pnl": cumulative_pnl,
        "cumulative_illustrative_return_pct": round(cumulative_pnl / STARTING_CAPITAL * 100, 2),
        "max_illustrative_drawdown_pct": round(max_illustrative_drawdown_pct, 2),
        "worst_case_exposure_pct_while_in_drawdown": round(worst_case_exposure_in_drawdown_pct, 1),
        "win_rate_pct": round(win_rate, 1),
        "risk_rules": RISK_RULES,
        "scores": scores,
    }

    return {"summary": summary, "tests": test_results}
