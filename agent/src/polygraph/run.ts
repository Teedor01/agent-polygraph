import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { recordRun } from "./history.js";
import { runPolygraph } from "./report.js";
import { LLMFuturesAgent, RuleBasedFuturesAgent, FixedActionAgent } from "./agents.js";
import { MAX_AGENT_ERROR_RATE } from "./scorecard.js";
import { MARKET_REGIMES } from "./types.js";
import type { PolygraphAgent } from "./types.js";

const APPROX_TOKENS_PER_LLM_CALL = 3500;
const MAX_MUTATIONS_PER_SCENARIO = 5;

function arg(name: string, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function intArg(name: string, argv: string[], fallback: number): number {
  const raw = arg(name, argv);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

function fmtPct(v: number | null): string {
  return v === null ? "n/a" : `${v}%`;
}

async function main() {
  const argv = process.argv.slice(2);
  const agentFlag = arg("agent", argv) ?? "rule-based";
  const seed = Number(arg("seed", argv) ?? 20260910);
  const countPerRegime = intArg("count", argv, 3);
  const mutationSampleSize = intArg("mutation-sample", argv, 20);
  const outPath = arg("out", argv);

  let agent: PolygraphAgent;
  if (agentFlag === "llm") {
    agent = new LLMFuturesAgent();
  } else if (agentFlag === "adversarial") {
    agent = new FixedActionAgent("OPEN_LONG");
  } else {
    agent = new RuleBasedFuturesAgent();
  }

  console.log(`Agent Polygraph - Futures Stress Test`);
  console.log(`Agent: ${agent.name}`);
  if (agentFlag === "llm") {
    console.log(`NOTE: --agent=llm makes REAL network calls to the configured LLM_PROVIDER for every`);
    console.log(`decision below. It never places a real Bitget order (see stress-test.ts's safety`);
    console.log(`boundary), but it is not free and not deterministic run-to-run.`);
  } else if (agentFlag === "adversarial") {
    console.log(`NOTE: this is a scripted test double that always proposes OPEN_LONG regardless of`);
    console.log(`the scenario - it exists to demonstrate that Polygraph actually catches rule`);
    console.log(`violations, not to represent a real trading strategy. It never touches Bitget.`);
  } else {
    console.log(`(deterministic, offline, no API key or network call - the default demo agent)`);
  }
  console.log(`Seed: ${seed}, scenarios/regime: ${countPerRegime}`);

  if (agentFlag === "llm") {
    const scenarioCount = MARKET_REGIMES.length * countPerRegime;
    const sampled = Math.min(mutationSampleSize, scenarioCount);
    const maxCalls = scenarioCount + sampled * MAX_MUTATIONS_PER_SCENARIO;
    const delayMs = Number(process.env.POLYGRAPH_LLM_DELAY_MS ?? 30000);
    const minutes = Math.round((maxCalls * delayMs) / 60000);
    console.log(
      `LLM cost estimate: up to ${maxCalls} calls (~${Math.round((maxCalls * APPROX_TOKENS_PER_LLM_CALL) / 1000)}k tokens), ` +
        `about ${minutes} min at POLYGRAPH_LLM_DELAY_MS=${delayMs}.`,
    );
    console.log(`Mutation sample: ${sampled} scenario(s). If provider errors exceed ${MAX_AGENT_ERROR_RATE * 100}% of scenarios,`);
    console.log(`the run is flagged INVALID and mutation testing is skipped to save quota.`);
  }
  console.log("");

  const kind = agentFlag === "llm" ? "llm" : agentFlag === "adversarial" ? "adversarial" : "deterministic";
  const report = await runPolygraph(agent, { seed, countPerRegime, mutationSampleSize, kind });
  const historyDir = argv.includes("--no-history")
    ? undefined
    : arg("history-dir", argv) ?? (outPath ? join(dirname(outPath), "runs") : undefined);
  const s = report.scorecard;

  if (s.scenarios === 0) {
    console.log("No scenarios were generated (--count=0) - nothing to report.");
    console.log("This is an empty run, not a passing or failing one; the percentages below would be");
    console.log("computed from zero data and are intentionally not printed.");
    if (outPath) {
      await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
      console.log(`\nEmpty report written to ${outPath}`);
    }
    return;
  }

  const invalid = s.validity !== "valid";

  if (invalid) {
    console.log("==================================================================");
    console.log("INVALID RUN: PROVIDER FAILURES");
    console.log(`${s.agentErrors} of ${s.scenarios} scenarios (${s.agentErrorRatePct}%) ended in a provider/network/API`);
    console.log(`error, above the ${MAX_AGENT_ERROR_RATE * 100}% limit. This run measured the provider, NOT the agent.`);
    console.log("Agent-quality percentages are withheld (n/a). Mutation testing was skipped.");
    console.log("Do not quote any number from this run as agent performance. Re-run when the");
    console.log("provider is available (check rate limits / daily token quota).");
    console.log("==================================================================");
    console.log("");
  }

  console.log(`Scenarios tested: ${s.scenarios}`);
  console.log(`Passed: ${s.passed}`);
  console.log(`Failed: ${s.failed}`);
  if (s.agentErrors > 0) {
    console.log(`Agent errors (provider/network/API - NOT counted as agent failures): ${s.agentErrors} (${s.agentErrorRatePct}%)`);
    console.log(`Answered scenarios (agent actually produced a decision): ${s.answeredScenarios}`);
    for (const [k, n] of Object.entries(s.providerErrorsByKind)) console.log(`  provider error ${k}: ${n}`);
  }
  console.log("");
  console.log(`Risk violations: ${s.riskViolations}`);
  console.log(`Decision inconsistencies: ${s.consistencyFailures} (out of ${s.mutationChecks} total mutation checks, sampled from the scenario set - not exhaustive)`);
  console.log(`Invalid actions: ${s.invalidActions}`);
  console.log(`Unsafe reversals: ${s.unsafeReversals}`);
  console.log(`Malformed decisions: ${s.malformedDecisions}`);
  console.log("");
  console.log(`Decision reliability: ${fmtPct(s.decisionReliabilityPct)} (answered scenarios that passed every check below)`);
  console.log(`Risk compliance: ${fmtPct(s.riskCompliancePct)}`);
  console.log(
    `Decision consistency: ${fmtPct(s.decisionConsistencyPct)} ` +
      (s.decisionConsistencyPct === null && !invalid ? "(no mutation checks ran)" : "(mutation sample only)"),
  );
  console.log(`Position management: ${fmtPct(s.positionManagementPct)}`);
  console.log(`Scenario coverage: ${s.scenarioCoveragePct}% (${report.regimeResults.length}/${MARKET_REGIMES.length} regimes exercised)`);
  console.log("");
  console.log("REGIME RESULTS");
  for (const r of report.regimeResults) {
    console.log(`  ${r.regime}: ${r.passed}/${r.scenarios} passed`);
  }

  console.log("");
  if (report.failures.length > 0) {
    console.log(`FAILURES (${report.failures.length}) - first 5:`);
    for (const f of report.failures.slice(0, 5)) {
      console.log(`  [${f.failure.severity ?? "n/a"}] ${f.scenario.regime} (${f.scenario.id}): ${f.failure.category}`);
      console.log(`    Scenario: ${f.scenario.description}`);
      console.log(`    Agent decision: ${f.agentDecision.decision.action} (confidence ${f.agentDecision.decision.confidence})`);
      console.log(`    Why flagged:`);
      for (const d of f.failure.details) console.log(`      - ${d}`);
    }
  } else {
    console.log("No failures detected in this run (0 of every configured failure category).");
    console.log("This means the agent passed every scenario Polygraph generated this run - it does");
    console.log("NOT mean the agent is safe in general: coverage is limited to the 21 regimes and");
    console.log("the mutation sample above, evidence-conflict grading only applies to unambiguous");
    console.log("regimes, and nothing here executes against real market data or real capital.");
  }

  console.log("");
  if (invalid) {
    console.log("MUTATION TESTING: skipped (invalid run - the provider was failing).");
  } else if (report.mutationResults.length === 0) {
    console.log("MUTATION TESTING: no comparisons were run (sample size 0, or every call errored).");
    console.log("Decision consistency is therefore n/a, not 100%.");
  } else {
    console.log(`MUTATION TESTING (decision-consistency check, ${report.mutationResults.length} total checks, bounded sample - not exhaustive)`);
    const changed = report.mutationResults.filter((m) => m.decisionChanged);
    const flaggedInconsistent = report.mutationResults.filter((m) => m.failureCategory === "decision_inconsistency");
    console.log(`  Decisions that changed after a tiny perturbation: ${changed.length}/${report.mutationResults.length}`);
    console.log(`  Flagged as unexplained inconsistency: ${flaggedInconsistent.length}`);
    const exampleChanged = changed.find((m) => m.failureCategory === "none") ?? changed[0];
    if (exampleChanged) {
      console.log(`  Example - explainable change:`);
      console.log(`    Mutated ${exampleChanged.changedFields.join(", ")} (magnitude ${exampleChanged.magnitude.toFixed(2)})`);
      console.log(`    Decision: ${exampleChanged.originalDecision.action} -> ${exampleChanged.mutatedDecision.action} (${exampleChanged.explainable ? "considered reasonable - large enough change or a real boundary crossed" : "flagged as inconsistent"})`);
    }
    const exampleFlagged = flaggedInconsistent[0];
    if (exampleFlagged) {
      console.log(`  Example - flagged inconsistency:`);
      console.log(`    Mutated ${exampleFlagged.changedFields.join(", ")} (magnitude ${exampleFlagged.magnitude.toFixed(2)}) - too small to explain a decision change`);
      console.log(`    Decision: ${exampleFlagged.originalDecision.action} -> ${exampleFlagged.mutatedDecision.action} (flagged as decision_inconsistency)`);
    } else {
      console.log(`  No unexplained inconsistencies found in this sample.`);
    }
  }

  if (outPath) {
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\nFull report written to ${outPath}`);
  }
  if (historyDir) {
    const entry = await recordRun(report, historyDir);
    console.log(entry ? `Run stored in history: ${join(historyDir, entry.file)}` : "Run already present in history.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});