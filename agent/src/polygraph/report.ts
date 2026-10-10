import { randomUUID } from "node:crypto";
import { generateScenarios } from "./scenarios.js";
import { groupByRegime, runStressTest } from "./stress-test.js";
import { runMutationSuite } from "./mutations.js";
import { computeScorecard, isProviderFailureRun } from "./scorecard.js";
import type { PolygraphAgent, PolygraphReport, RunKind, ScenarioResult } from "./types.js";

export interface RunPolygraphOptions {
  seed?: number;
  countPerRegime?: number;
  mutationSampleSize?: number;
  replaySampleSize?: number;
  kind?: RunKind;
}

export async function runPolygraph(agent: PolygraphAgent, options: RunPolygraphOptions = {}): Promise<PolygraphReport> {
  const seed = options.seed ?? 20260910;
  const countPerRegime = options.countPerRegime ?? 3;
  const mutationSampleSize = options.mutationSampleSize ?? 20;
  const replaySampleSize = options.replaySampleSize ?? 5;

  const scenarios = generateScenarios(seed, countPerRegime);
  const results = await runStressTest(agent, scenarios);
  const regimeResults = groupByRegime(results);

  const step = Math.max(1, Math.floor(scenarios.length / mutationSampleSize));
  const mutationSample = scenarios.filter((_, i) => i % step === 0).slice(0, mutationSampleSize);


  const baselines = new Map(results.map((r) => [r.scenario.id, r] as const));

  const mutationResults = isProviderFailureRun(results)
    ? []
    : await runMutationSuite(agent, mutationSample, baselines);

  const scorecard = computeScorecard(results, mutationResults, regimeResults);

  const failures = results.filter((r) => !r.passed);
  const passing = results.filter((r) => r.passed);
  const replaySample: ScenarioResult[] = passing.filter((_, i) => i % Math.max(1, Math.floor(passing.length / replaySampleSize)) === 0).slice(0, replaySampleSize);

  const served = results.find((r) => r.agentDecision.provider || r.agentDecision.model)?.agentDecision;
  const kind = options.kind ?? "deterministic";

  return {
    run: {
      kind,
      market: "futures",
      provider: served?.provider ?? null,
      model: served?.model ?? null,
      countPerRegime,
      mutationSampleSize,
    },
    runId: randomUUID(),
    seed,
    agent: agent.name,
    generatedAt: new Date().toISOString(),
    scorecard,
    regimeResults,
    mutationResults,
    failures,
    replaySample,
  };
}