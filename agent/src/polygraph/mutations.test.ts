import test from "node:test";
import assert from "node:assert/strict";
import { mutateAndEvaluate, runMutationSuite } from "./mutations.js";
import { generateScenarios } from "./scenarios.js";
import { RuleBasedFuturesAgent, MalformedOutputAgent } from "./agents.js";
import type { PolygraphAgent } from "./types.js";

test("a tiny price nudge that doesn't change the deterministic agent's decision is not flagged", async () => {
  const scenario = generateScenarios(9, 1).find((s) => s.regime === "flat")!;
  const records = await mutateAndEvaluate(new RuleBasedFuturesAgent(), scenario);
  for (const r of records) {
    if (!r.decisionChanged) {
      assert.equal(r.failureCategory, "none");
    }
  }
});

test("an agent whose output is unrelated to the scenario (always flips) surfaces as decision_inconsistency somewhere in a full suite", async () => {
  const scenarios = generateScenarios(9, 2);
  const records = await runMutationSuite(new MalformedOutputAgent(), scenarios);
  assert.ok(records.some((r) => r.failureCategory === "decision_inconsistency"));
});

test("magnitude is always within [0, 1]", async () => {
  const scenario = generateScenarios(9, 1).find((s) => s.regime === "bull_trend")!;
  const records = await mutateAndEvaluate(new RuleBasedFuturesAgent(), scenario);
  for (const r of records) {
    assert.ok(r.magnitude >= 0 && r.magnitude <= 1);
  }
});

test("mutation records reference the original scenario id", async () => {
  const scenario = generateScenarios(9, 1).find((s) => s.regime === "sideways")!;
  const records = await mutateAndEvaluate(new RuleBasedFuturesAgent(), scenario);
  for (const r of records) {
    assert.equal(r.originalScenarioId, scenario.id);
    assert.notEqual(r.mutatedScenarioId, scenario.id);
  }
});

test("a decision change is marked explainable when the perturbation crosses a declared boundary (e.g. RSI crossing 50)", async () => {
  // Build a synthetic agent that flips action purely based on RSI > 50,
  // so we can force a boundary-crossing flip deterministically.
  const rsiFlipAgent: PolygraphAgent = {
    name: "RSI flip (test double)",
    decide: async (s) => ({
      decision: { action: (s.market.rsi ?? 50) > 50 ? "OPEN_LONG" : "HOLD", confidence: 0.7, reason: "rsi test" },
    }),
  };
  const base = generateScenarios(9, 1).find((s) => s.regime === "sideways")!;
  const scenario = { ...base, market: { ...base.market, rsi: 49.6 } };
  const records = await mutateAndEvaluate(rsiFlipAgent, scenario);
  const rsiRecord = records.find((r) => r.changedFields.includes("rsi"));
  assert.ok(rsiRecord);
  assert.equal(rsiRecord!.decisionChanged, true);
  assert.equal(rsiRecord!.explainable, true);
  assert.equal(rsiRecord!.failureCategory, "none");
});
