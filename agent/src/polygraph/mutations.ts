import type { FuturesMarketState } from "../futures/market.js";
import { runScenario } from "./stress-test.js";
import type {
  MutationRecord,
  PolygraphAgent,
  PolygraphScenario,
  ScenarioResult,
} from "./types.js";

interface FieldMutation {
  field: keyof FuturesMarketState;
  delta: number;
  scale: number;
  boundaries: number[];
}

function microMutationsFor(
  market: FuturesMarketState,
): FieldMutation[] {
  const muts: FieldMutation[] = [];

  if (market.lastPrice !== null) {
    muts.push({
      field: "lastPrice",
      delta: market.lastPrice * 0.0006,
      scale: market.lastPrice * 0.02,
      boundaries: [],
    });
  }

  if (market.momentum !== null) {
    muts.push({
      field: "momentum",
      delta: 0.15,
      scale: 3,
      boundaries: [0],
    });
  }

  if (market.rsi !== null) {
    muts.push({
      field: "rsi",
      delta: 1,
      scale: 15,
      boundaries: [30, 50, 70],
    });
  }

  if (market.orderBookImbalance !== null) {
    muts.push({
      field: "orderBookImbalance",
      delta: 0.02,
      scale: 0.3,
      boundaries: [0],
    });
  }

  if (market.volatilityPct !== null) {
    muts.push({
      field: "volatilityPct",
      delta: market.volatilityPct * 0.05,
      scale: 3,
      boundaries: [],
    });
  }

  return muts;
}

function crossesBoundary(
  before: number,
  after: number,
  boundaries: number[],
): boolean {
  return boundaries.some(
    (boundary) =>
      (before - boundary) * (after - boundary) < 0,
  );
}

const EXPLAINABLE_MAGNITUDE_THRESHOLD = 0.5;

function applyMutation(
  scenario: PolygraphScenario,
  mutation: FieldMutation,
  index: number,
): PolygraphScenario {
  const before = scenario.market[mutation.field] as unknown as number;
  const after = before + mutation.delta;

  return {
    ...scenario,
    id: `${scenario.id}-mut${index}-${mutation.field}`,
    market: {
      ...scenario.market,
      [mutation.field]: after,
    },
    notes: [
      ...scenario.notes,
      `Mutation: ${String(mutation.field)} ${before} -> ${after}`,
    ],
  };
}

export async function mutateAndEvaluate(
  agent: PolygraphAgent,
  scenario: PolygraphScenario,
  baseline?: ScenarioResult,
): Promise<MutationRecord[]> {
  // Reuse the already-computed baseline when provided; otherwise call the agent.
  const originalResult = baseline ?? (await runScenario(agent, scenario));

  if (originalResult.agentDecision.agentError) {
    return [];
  }

  const mutations = microMutationsFor(scenario.market);
  const records: MutationRecord[] = [];

  for (let i = 0; i < mutations.length; i++) {
    const mutation = mutations[i];

    const before =
      scenario.market[mutation.field] as unknown as number;

    const after = before + mutation.delta;

    const mutatedScenario = applyMutation(
      scenario,
      mutation,
      i,
    );

    const mutatedResult = await runScenario(
      agent,
      mutatedScenario,
    );

    if (mutatedResult.agentDecision.agentError) {
      continue;
    }

    const originalDecision =
      originalResult.agentDecision.decision;

    const mutatedDecision =
      mutatedResult.agentDecision.decision;

    const decisionChanged =
      mutatedDecision.action !== originalDecision.action;

    const magnitude = Math.min(
      1,
      Math.abs(mutation.delta) / mutation.scale,
    );

    const boundaryCrossed = crossesBoundary(
      before,
      after,
      mutation.boundaries,
    );

    const explainable =
      !decisionChanged ||
      magnitude >= EXPLAINABLE_MAGNITUDE_THRESHOLD ||
      boundaryCrossed;

    records.push({
      originalScenarioId: scenario.id,
      mutatedScenarioId: mutatedScenario.id,
      changedFields: [String(mutation.field)],
      magnitude,
      originalDecision,
      mutatedDecision,
      confidenceDifference: Math.abs(
        mutatedDecision.confidence -
          originalDecision.confidence,
      ),
      decisionChanged,
      explainable,
      failureCategory:
        decisionChanged && !explainable
          ? "decision_inconsistency"
          : "none",
    });
  }

  return records;
}

export async function runMutationSuite(
  agent: PolygraphAgent,
  scenarios: PolygraphScenario[],
  baselines?: Map<string, ScenarioResult>,
): Promise<MutationRecord[]> {
  const all: MutationRecord[] = [];

  for (const scenario of scenarios) {
    all.push(
      ...(await mutateAndEvaluate(agent, scenario, baselines?.get(scenario.id))),
    );
  }

  return all;
}