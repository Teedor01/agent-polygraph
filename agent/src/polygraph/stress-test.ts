import { evaluateFuturesRisk } from "../futures/risk.js";
import { analyzeFailure } from "./failure-analysis.js";
import type { PolygraphAgent, PolygraphScenario, RegimeResult, ScenarioResult } from "./types.js";
import { MARKET_REGIMES } from "./types.js";

export interface SimulatedExecution {
  wouldExecute: boolean;
  action: string;
  qty: number;
  leverage: number;
}

export function simulateExecution(scenario: PolygraphScenario, result: Pick<ScenarioResult, "riskVerdict">): SimulatedExecution {
  const v = result.riskVerdict;
  return {
    wouldExecute: v.approved && v.approvedAction !== "HOLD",
    action: v.approvedAction,
    qty: v.qty,
    leverage: v.leverage,
  };
}

export async function runScenario(agent: PolygraphAgent, scenario: PolygraphScenario): Promise<ScenarioResult> {
  let agentDecision;
  try {
    agentDecision = await agent.decide(scenario);
  } catch (err) {
    agentDecision = {
      decision: { action: "HOLD" as const, confidence: 0, reason: "agent threw" },
      agentError: err instanceof Error ? err.message : String(err),
    };
  }

  const riskVerdict = evaluateFuturesRisk(agentDecision.decision, scenario.market.lastPrice, scenario.position);
  const failure = analyzeFailure(scenario, agentDecision, riskVerdict);

  return {
    scenario,
    agentDecision,
    riskVerdict,
    passed: failure.category === "none",
    failure,
  };
}

export async function runStressTest(agent: PolygraphAgent, scenarios: PolygraphScenario[]): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(agent, scenario));
  }
  return results;
}

export function groupByRegime(results: ScenarioResult[]): RegimeResult[] {
  const byRegime = new Map<string, { scenarios: number; passed: number; failed: number }>();
  for (const regime of MARKET_REGIMES) byRegime.set(regime, { scenarios: 0, passed: 0, failed: 0 });

  for (const r of results) {
    const bucket = byRegime.get(r.scenario.regime)!;
    bucket.scenarios++;
    if (r.passed) bucket.passed++;
    else bucket.failed++;
  }

  return MARKET_REGIMES.filter((regime) => byRegime.get(regime)!.scenarios > 0).map((regime) => ({
    regime,
    ...byRegime.get(regime)!,
  }));
}
