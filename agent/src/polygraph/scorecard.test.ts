import test from "node:test";
import assert from "node:assert/strict";
import { computeScorecard, isProviderFailureRun, MAX_AGENT_ERROR_RATE } from "./scorecard.js";
import { generateScenarios } from "./scenarios.js";
import type { FailureCategory, MutationRecord, ScenarioResult } from "./types.js";

const scenario = generateScenarios(1, 1)[0];

function mk(passed: boolean, category: FailureCategory): ScenarioResult {
  return {
    scenario,
    agentDecision: { decision: { action: "HOLD", confidence: 0.5, reason: "x" } },
    riskVerdict: { approved: true, approvedAction: "HOLD", qty: 0, leverage: 3, reasons: [] },
    passed,
    failure: { category, details: [], severity: null },
  };
}

function mkMutation(category: FailureCategory): MutationRecord {
  return {
    originalScenarioId: "a",
    mutatedScenarioId: "b",
    changedFields: ["lastPrice"],
    magnitude: 0.1,
    originalDecision: { action: "HOLD", confidence: 0.5, reason: "x" },
    mutatedDecision: { action: "HOLD", confidence: 0.5, reason: "x" },
    confidenceDifference: 0,
    decisionChanged: category === "decision_inconsistency",
    explainable: false,
    failureCategory: category,
  };
}

test("2/21 provider-failure run is flagged invalid and withholds agent-quality metrics", () => {
  const results = [mk(true, "none"), mk(true, "none"), ...Array.from({ length: 19 }, () => mk(false, "agent_error"))];
  const sc = computeScorecard(results, [], []);
  assert.equal(sc.validity, "invalid_provider_failures");
  assert.equal(sc.scenarios, 21);
  assert.equal(sc.agentErrors, 19);
  assert.equal(sc.answeredScenarios, 2);
  assert.equal(sc.decisionReliabilityPct, null);
  assert.equal(sc.riskCompliancePct, null);
  assert.equal(sc.decisionConsistencyPct, null);
  assert.equal(sc.positionManagementPct, null);
  assert.equal(sc.agentErrorRatePct, 90.48);
});

test("clean run with zero mutation checks reports consistency as null (n/a), not 100", () => {
  const sc = computeScorecard([mk(true, "none")], [], []);
  assert.equal(sc.validity, "valid");
  assert.equal(sc.mutationChecks, 0);
  assert.equal(sc.decisionConsistencyPct, null);
  assert.equal(sc.decisionReliabilityPct, 100);
});

test("a few provider errors stay valid and are excluded from the reliability denominator", () => {
  const results = [
    ...Array.from({ length: 18 }, () => mk(true, "none")),
    mk(false, "risk_violation"),
    mk(false, "agent_error"),
  ];
  const sc = computeScorecard(results, [], []);
  assert.equal(sc.validity, "valid");
  assert.equal(sc.answeredScenarios, 19);
  assert.equal(sc.failed, 1);
  assert.equal(sc.decisionReliabilityPct, 94.74);
  assert.equal(sc.agentErrors, 1);
});

test("consistency is computed over genuine mutation comparisons only", () => {
  const mutations = [mkMutation("none"), mkMutation("decision_inconsistency")];
  const sc = computeScorecard([mk(true, "none")], mutations, []);
  assert.equal(sc.mutationChecks, 2);
  assert.equal(sc.consistencyFailures, 1);
  assert.equal(sc.decisionConsistencyPct, 50);
});

test("scenarios ran but the mutation suite produced no records: consistency is n/a", () => {
  const sc = computeScorecard([mk(true, "none")], [], []);
  assert.equal(sc.mutationChecks, 0);
  assert.equal(sc.decisionConsistencyPct, null);
});

test("empty run returns null percentages, never misleading numbers", () => {
  const sc = computeScorecard([], [], []);
  assert.equal(sc.validity, "valid");
  assert.equal(sc.decisionReliabilityPct, null);
  assert.equal(sc.riskCompliancePct, null);
  assert.equal(sc.decisionConsistencyPct, null);
});

test("isProviderFailureRun threshold: exactly at the limit is valid, above is invalid", () => {
  const atLimit = [
    ...Array.from({ length: 8 }, () => mk(true, "none")),
    ...Array.from({ length: 2 }, () => mk(false, "agent_error")),
  ]; // 20% == MAX_AGENT_ERROR_RATE, not above
  assert.equal(MAX_AGENT_ERROR_RATE, 0.2);
  assert.equal(isProviderFailureRun(atLimit), false);
  const above = [
    ...Array.from({ length: 7 }, () => mk(true, "none")),
    ...Array.from({ length: 3 }, () => mk(false, "agent_error")),
  ]; // 30%
  assert.equal(isProviderFailureRun(above), true);
});

test("genuine agent failures (non-error) still lower reliability on a valid run", () => {
  const results = [mk(true, "none"), mk(true, "none"), mk(false, "risk_violation"), mk(false, "unsafe_reversal")];
  const sc = computeScorecard(results, [], []);
  assert.equal(sc.decisionReliabilityPct, 50);
  assert.equal(sc.riskCompliancePct, 75);
  assert.equal(sc.positionManagementPct, 75);
});