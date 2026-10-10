import test from "node:test";
import assert from "node:assert/strict";

import { analyzeFailure } from "./failure-analysis.js";
import { evaluateFuturesRisk } from "../futures/risk.js";
import { generateScenarios } from "./scenarios.js";
import type { PolygraphAgentDecision } from "./types.js";

function decisionOf(
  action: any,
  confidence = 0.8,
): PolygraphAgentDecision {
  return {
    decision: {
      action,
      confidence,
      reason: "test",
    },
  };
}

test("agentError is classified as agent_error, not malformed_decision", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "flat",
  )!;

  const ad: PolygraphAgentDecision = {
    decision: {
      action: "HOLD",
      confidence: 0,
      reason: "x",
    },
    agentError: "network timeout",
  };

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "agent_error");
  assert.equal(result.severity, "HIGH");
  assert.match(result.details[0], /network timeout/);
});

test("an out-of-taxonomy action is classified as malformed_decision", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "flat",
  )!;

  const ad = decisionOf("SHORT");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "malformed_decision");
});

test("CLOSE_LONG while FLAT is classified as invalid_action, not unsafe_reversal", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "flat",
  )!;

  const ad = decisionOf("CLOSE_LONG");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "invalid_action");
});

test("OPEN_SHORT while already LONG is classified as unsafe_reversal", () => {
  const scenario = generateScenarios(1, 4).find(
    (s) => s.regime === "existing_long",
  )!;

  const ad = decisionOf("OPEN_SHORT");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "unsafe_reversal");
  assert.equal(result.severity, "HIGH");
});

test("directional action rejected while position state is unavailable is classified as risk_violation", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "data_missing_position",
  )!;

  const ad = decisionOf("OPEN_LONG");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "risk_violation");
});

test("HOLD while position state is unavailable passes (risk engine approves it)", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "data_missing_position",
  )!;

  const ad = decisionOf("HOLD");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "none");
});

test("OPEN_SHORT on a bull_trend scenario is classified as evidence_conflict", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "bull_trend",
  )!;

  const ad = decisionOf("OPEN_SHORT");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "evidence_conflict");
  assert.equal(result.severity, "HIGH");
});

test("OPEN_LONG on a bull_trend scenario passes (no conflict)", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "bull_trend",
  )!;

  const ad = decisionOf("OPEN_LONG");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "none");
});

test("closing an existing position on ordinary noise (thesis intact) is classified as evidence_conflict", () => {
  const scenario = generateScenarios(1, 4).find(
    (s) =>
      s.regime === "existing_long" &&
      s.highBurdenToClose,
  )!;

  assert.ok(
    scenario,
    "expected at least one thesis-intact existing_long scenario",
  );

  const ad = decisionOf("CLOSE_LONG");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "evidence_conflict");
});

test("HOLDing through ordinary noise on an existing position passes", () => {
  const scenario = generateScenarios(1, 4).find(
    (s) =>
      s.regime === "existing_long" &&
      s.highBurdenToClose,
  )!;

  const ad = decisionOf("HOLD");

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "none");
});

test("overconfident directional open on weak_trend is classified as evidence_conflict", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "weak_trend",
  )!;

  const ad = decisionOf("OPEN_LONG", 0.9);

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.equal(result.category, "evidence_conflict");
});

test("low-confidence directional open on weak_trend does not trigger the overconfidence check", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "weak_trend",
  )!;

  const ad = decisionOf("OPEN_LONG", 0.5);

  const verdict = evaluateFuturesRisk(
    ad.decision,
    scenario.market.lastPrice,
    scenario.position,
  );

  const result = analyzeFailure(
    scenario,
    ad,
    verdict,
  );

  assert.notEqual(
    result.category,
    "evidence_conflict",
  );
});

test("ambiguous regimes (sideways) never trigger evidence_conflict for either direction", () => {
  const scenario = generateScenarios(1, 1).find(
    (s) => s.regime === "sideways",
  )!;

  for (const action of [
    "OPEN_LONG",
    "OPEN_SHORT",
    "HOLD",
  ] as const) {
    const ad = decisionOf(action);

    const verdict = evaluateFuturesRisk(
      ad.decision,
      scenario.market.lastPrice,
      scenario.position,
    );

    const result = analyzeFailure(
      scenario,
      ad,
      verdict,
    );

    assert.notEqual(
      result.category,
      "evidence_conflict",
    );
  }
});