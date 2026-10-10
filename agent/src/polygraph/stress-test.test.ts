import test from "node:test";
import assert from "node:assert/strict";
import { runStressTest, runScenario, groupByRegime, simulateExecution } from "./stress-test.js";
import { generateScenarios } from "./scenarios.js";
import { RuleBasedFuturesAgent, FixedActionAgent, MalformedOutputAgent } from "./agents.js";
import { MARKET_REGIMES } from "./types.js";

test("runStressTest never throws even with an adversarial agent, and returns one result per scenario", async () => {
  const scenarios = generateScenarios(5, 2);
  const results = await runStressTest(new MalformedOutputAgent(), scenarios);
  assert.equal(results.length, scenarios.length);
});

test("the well-behaved rule-based agent produces zero risk violations across every regime", async () => {
  const scenarios = generateScenarios(5, 3);
  const results = await runStressTest(new RuleBasedFuturesAgent(), scenarios);
  const riskViolations = results.filter((r) => r.failure.category === "risk_violation");
  assert.equal(riskViolations.length, 0, JSON.stringify(riskViolations.map((r) => r.failure.details)));
});

test("a HOLD-forcing risk rejection never places a real order (simulateExecution never wouldExecute for HOLD)", async () => {
  const scenarios = generateScenarios(5, 2);
  const results = await runStressTest(new RuleBasedFuturesAgent(), scenarios);
  for (const r of results) {
    if (r.riskVerdict.approvedAction === "HOLD") {
      const sim = simulateExecution(r.scenario, r);
      assert.equal(sim.wouldExecute, false);
    }
  }
});

test("groupByRegime accounts for every scenario exactly once", () => {
  const scenarios = generateScenarios(5, 4);
  const regimeResults = groupByRegime(scenarios.map((s) => ({
    scenario: s,
    agentDecision: { decision: { action: "HOLD" as const, confidence: 0.5, reason: "x" } },
    riskVerdict: { approved: true, approvedAction: "HOLD" as const, qty: 0, leverage: 3, reasons: [] },
    passed: true,
    failure: { category: "none" as const, details: [], severity: null },
  })));
  const total = regimeResults.reduce((sum, r) => sum + r.scenarios, 0);
  assert.equal(total, scenarios.length);
  for (const r of regimeResults) {
    assert.equal(r.passed + r.failed, r.scenarios);
  }
});

test("groupByRegime only includes regimes actually exercised", () => {
  const scenarios = generateScenarios(5, 1).filter((s) => s.regime === "bull_trend");
  const regimeResults = groupByRegime(scenarios.map((s) => ({
    scenario: s,
    agentDecision: { decision: { action: "HOLD" as const, confidence: 0.5, reason: "x" } },
    riskVerdict: { approved: true, approvedAction: "HOLD" as const, qty: 0, leverage: 3, reasons: [] },
    passed: true,
    failure: { category: "none" as const, details: [], severity: null },
  })));
  assert.equal(regimeResults.length, 1);
  assert.equal(regimeResults[0].regime, "bull_trend");
});

test("an agent that always proposes OPEN_LONG produces evidence_conflict, invalid_action, unsafe_reversal, and risk_violation failures", async () => {
  const scenarios = generateScenarios(3, 3);
  const results = await runStressTest(new FixedActionAgent("OPEN_LONG"), scenarios);
  const categories = new Set(results.filter((r) => !r.passed).map((r) => r.failure.category));
  assert.ok(categories.has("evidence_conflict"));
  assert.ok(categories.has("invalid_action"));
  assert.ok(categories.has("unsafe_reversal"));
  assert.ok(categories.has("risk_violation"));
});

test("runScenario catches an agent that throws and reports it as an agent error, not a crash", async () => {
  const throwingAgent = { name: "Throws", decide: async () => { throw new Error("boom"); } };
  const scenario = generateScenarios(1, 1)[0];
  const result = await runScenario(throwingAgent, scenario);
  assert.equal(result.passed, false);
  assert.equal(result.failure.category, "agent_error");
});
