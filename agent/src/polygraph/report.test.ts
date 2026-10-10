import test from "node:test";
import assert from "node:assert/strict";
import { runPolygraph } from "./report.js";
import { RuleBasedFuturesAgent, FixedActionAgent } from "./agents.js";
import type { PolygraphAgent, PolygraphScenario } from "./types.js";

test("runPolygraph produces a fully-populated, internally consistent report for the deterministic agent", async () => {
  const report = await runPolygraph(new RuleBasedFuturesAgent(), { seed: 2026, countPerRegime: 3, mutationSampleSize: 10 });

  assert.equal(report.seed, 2026);
  assert.equal(report.agent, new RuleBasedFuturesAgent().name);
  assert.ok(report.runId);
  assert.ok(report.generatedAt);

  assert.equal(report.scorecard.scenarios, report.regimeResults.reduce((s, r) => s + r.scenarios, 0));
  // failed excludes provider errors (agent_error), which are counted separately.
  assert.equal(report.scorecard.passed + report.scorecard.failed + report.scorecard.agentErrors, report.scorecard.scenarios);
  assert.equal(report.scorecard.answeredScenarios, report.scorecard.scenarios - report.scorecard.agentErrors);
  assert.equal(report.failures.length, report.scorecard.failed + report.scorecard.agentErrors);
  assert.equal(report.scorecard.validity, "valid");
});

test("runPolygraph is fully reproducible for a fixed seed", async () => {
  const r1 = await runPolygraph(new RuleBasedFuturesAgent(), { seed: 555, countPerRegime: 2, mutationSampleSize: 5 });
  const r2 = await runPolygraph(new RuleBasedFuturesAgent(), { seed: 555, countPerRegime: 2, mutationSampleSize: 5 });
  assert.deepEqual(r1.scorecard, r2.scorecard);
  assert.deepEqual(r1.regimeResults, r2.regimeResults);
});

test("runPolygraph against an adversarial fixed-action agent surfaces multiple distinct failure categories with real counts", async () => {
  const report = await runPolygraph(new FixedActionAgent("OPEN_LONG"), { seed: 3, countPerRegime: 4, mutationSampleSize: 5 });
  assert.ok(report.scorecard.failed > 0);
  const categories = new Set(report.failures.map((f) => f.failure.category));
  assert.ok(categories.size >= 3);
  for (const cat of ["risk_violation", "invalid_action", "unsafe_reversal"] as const) {
    const count = report.failures.filter((f) => f.failure.category === cat).length;
    if (cat === "risk_violation") assert.equal(count, report.scorecard.riskViolations);
    if (cat === "invalid_action") assert.equal(count, report.scorecard.invalidActions);
    if (cat === "unsafe_reversal") assert.equal(count, report.scorecard.unsafeReversals);
  }
});

test("replaySample only ever contains passing scenarios", async () => {
  const report = await runPolygraph(new FixedActionAgent("OPEN_LONG"), { seed: 3, countPerRegime: 4, mutationSampleSize: 5, replaySampleSize: 5 });
  for (const r of report.replaySample) {
    assert.equal(r.passed, true);
  }
});

test("report never contains an execution field that implies a real order was placed", async () => {
  const report = await runPolygraph(new RuleBasedFuturesAgent(), { seed: 8, countPerRegime: 2 });
  const json = JSON.stringify(report);
  assert.ok(!json.includes("clientOid"));
});

test("countPerRegime=0 produces an empty-but-valid report, not a crash or a misleading score", async () => {
  const report = await runPolygraph(new RuleBasedFuturesAgent(), { seed: 1, countPerRegime: 0 });
  assert.equal(report.scorecard.scenarios, 0);
  assert.equal(report.scorecard.passed, 0);
  assert.equal(report.scorecard.failed, 0);
  assert.equal(report.regimeResults.length, 0);
  assert.equal(report.failures.length, 0);
  assert.equal(report.replaySample.length, 0);
  assert.equal(report.scorecard.validity, "valid");
  // Nothing was run, so nothing is computable: n/a (null), never 0% or 100%.
  assert.equal(report.scorecard.decisionReliabilityPct, null);
  assert.equal(report.scorecard.riskCompliancePct, null);
  assert.equal(report.scorecard.decisionConsistencyPct, null);
});

test("mutationSampleSize=0 runs zero mutations without crashing, and consistency is n/a (null), not 100%", async () => {
  const report = await runPolygraph(new RuleBasedFuturesAgent(), { seed: 1, countPerRegime: 2, mutationSampleSize: 0 });
  assert.equal(report.mutationResults.length, 0);
  assert.equal(report.scorecard.mutationChecks, 0);
  assert.equal(report.scorecard.decisionConsistencyPct, null);
  // Scenario-level metrics are still computed normally.
  assert.equal(report.scorecard.decisionReliabilityPct, 100);
});

test("an agent that fails every scenario is reported as 100% failed with a correct, non-misleading scorecard", async () => {
  const { MalformedOutputAgent } = await import("./agents.js");
  const report = await runPolygraph(new MalformedOutputAgent(), { seed: 1, countPerRegime: 2, mutationSampleSize: 0 });
  assert.equal(report.scorecard.passed, 0);
  assert.equal(report.scorecard.failed, report.scorecard.scenarios);
  assert.equal(report.scorecard.decisionReliabilityPct, 0);
  assert.equal(report.failures.length, report.scorecard.scenarios);
});

test("an agent that hits a provider error on every scenario yields an invalid run and spends no calls on mutations", async () => {
  let calls = 0;
  const erroringAgent: PolygraphAgent = {
    name: "AlwaysProviderError",
    decide: async (_scenario: PolygraphScenario) => {
      calls++;
      return {
        decision: { action: "HOLD", confidence: 0, reason: "fallback" },
        agentError: "HTTP 429",
      };
    },
  };
  const report = await runPolygraph(erroringAgent, { seed: 1, countPerRegime: 2, mutationSampleSize: 5 });

  assert.equal(report.scorecard.validity, "invalid_provider_failures");
  assert.equal(report.scorecard.agentErrors, report.scorecard.scenarios);
  assert.equal(report.scorecard.answeredScenarios, 0);
  assert.equal(report.scorecard.decisionReliabilityPct, null);
  assert.equal(report.scorecard.decisionConsistencyPct, null);
  assert.equal(report.mutationResults.length, 0);
  assert.equal(calls, report.scorecard.scenarios);
});

test("mutation baselines are reused from the stress test, so the agent is never called twice for the same scenario", async () => {
  const inner = new RuleBasedFuturesAgent();
  let calls = 0;
  const countingAgent: PolygraphAgent = {
    name: inner.name,
    decide: async (scenario: PolygraphScenario) => {
      calls++;
      return inner.decide(scenario);
    },
  };
  const report = await runPolygraph(countingAgent, { seed: 7, countPerRegime: 2, mutationSampleSize: 6 });

  assert.ok(report.mutationResults.length > 0);
  assert.equal(calls, report.scorecard.scenarios + report.mutationResults.length);
});