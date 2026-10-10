import type { MutationRecord, RegimeResult, RunValidity, ScenarioResult, Scorecard } from "./types.js";
import { MARKET_REGIMES } from "./types.js";

/** Above this share of agent_error scenarios the run measures the provider, not the agent. */
export const MAX_AGENT_ERROR_RATE = 0.2;

/** Rounded percentage, or null when the denominator is zero (not computable). */
function pctOrNull(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 10000) / 100;
}

function complement(p: number | null): number | null {
  return p === null ? null : Math.round((100 - p) * 100) / 100;
}

export function isProviderFailureRun(results: ScenarioResult[]): boolean {
  if (results.length === 0) return false;
  const errs = results.filter((r) => r.failure.category === "agent_error").length;
  return errs / results.length > MAX_AGENT_ERROR_RATE;
}

export function computeScorecard(
  results: ScenarioResult[],
  mutations: MutationRecord[],
  regimeResults: RegimeResult[],
): Scorecard {
  const scenarios = results.length;
  const byCategory = (cat: string) => results.filter((r) => r.failure.category === cat).length;

  const agentErrors = byCategory("agent_error");
  const providerErrorsByKind: Scorecard["providerErrorsByKind"] = {};
  for (const r of results) {
    if (r.failure.category !== "agent_error") continue;
    const kind = r.failure.providerErrorKind ?? "unknown";
    providerErrorsByKind[kind] = (providerErrorsByKind[kind] ?? 0) + 1;
  }
  const answeredScenarios = scenarios - agentErrors;
  const validity: RunValidity = isProviderFailureRun(results) ? "invalid_provider_failures" : "valid";

  const passed = results.filter((r) => r.passed).length;
  const failed = answeredScenarios - passed;

  const riskViolations = byCategory("risk_violation");
  const invalidActions = byCategory("invalid_action");
  const unsafeReversals = byCategory("unsafe_reversal");
  const malformedDecisions = byCategory("malformed_decision");

  // mutations.ts never emits a record for a comparison that hit an agentError,
  // so every record here is a genuine comparison.
  const mutationChecks = mutations.length;
  const mutationConsistencyFailures = mutations.filter(
    (m) => m.failureCategory === "decision_inconsistency",
  ).length;
  // decision_inconsistency can also come from scenario-level results (rare -
  // failure-analysis.ts doesn't emit it directly today).
  const consistencyFailures = byCategory("decision_inconsistency") + mutationConsistencyFailures;

  const regimesExercised = regimeResults.filter((r) => r.scenarios > 0).length;

  // On an invalid run, withhold every agent-quality percentage.
  const gate = (v: number | null): number | null => (validity === "valid" ? v : null);

  return {
    scenarios,
    answeredScenarios,
    passed,
    failed,
    riskViolations,
    consistencyFailures,
    invalidActions,
    unsafeReversals,
    malformedDecisions,
    agentErrors,
    agentErrorRatePct: pctOrNull(agentErrors, scenarios) ?? 0,
    providerErrorsByKind,
    mutationChecks,
    validity,
    decisionReliabilityPct: gate(pctOrNull(passed, answeredScenarios)),
    riskCompliancePct: gate(complement(pctOrNull(riskViolations, answeredScenarios))),
    decisionConsistencyPct: gate(complement(pctOrNull(mutationConsistencyFailures, mutationChecks))),
    positionManagementPct: gate(complement(pctOrNull(unsafeReversals, answeredScenarios))),
    invalidDecisionRatePct: gate(pctOrNull(invalidActions, answeredScenarios)),
    unsafeActionRatePct: gate(pctOrNull(unsafeReversals, answeredScenarios)),
    scenarioCoveragePct: pctOrNull(regimesExercised, MARKET_REGIMES.length) ?? 0,
  };
}