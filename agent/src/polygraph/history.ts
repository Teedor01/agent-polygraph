import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyProviderError } from "./provider-errors.js";
import type { PolygraphReport, ProviderErrorKind, RunKind, Scorecard } from "./types.js";

export interface HistoryEntry {
  runId: string;
  file: string; // relative to the history dir
  market: "futures";
  kind: RunKind;
  agent: string;
  provider: string | null;
  model: string | null;
  generatedAt: string;
  seed: number;
  scenarios: number;
  answeredScenarios: number;
  passed: number;
  failed: number;
  agentErrors: number;
  agentErrorRatePct: number;
  providerErrorsByKind: Partial<Record<ProviderErrorKind, number>>;
  riskViolations: number;
  consistencyFailures: number;
  mutationChecks: number;
  validity: Scorecard["validity"];
  decisionReliabilityPct: number | null;
  riskCompliancePct: number | null;
  decisionConsistencyPct: number | null;
  /** Present only for reports imported from before run metadata existed. */
  imported?: { from: string; inferred: string[]; note: string };
}

function inferKind(agentName: string): RunKind | null {
  if (/LLM/i.test(agentName)) return "llm";
  if (/Rule-Based/i.test(agentName)) return "deterministic";
  if (/Fixed-Action|Malformed|adversarial/i.test(agentName)) return "adversarial";
  return null;
}

function safeStamp(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 14);
}

export function summarizeReport(report: PolygraphReport, file: string, importedFrom?: string): HistoryEntry {
  const s = report.scorecard;
  const inferred: string[] = [];

  let kind: RunKind;
  let provider = report.run?.provider ?? null;
  let model = report.run?.model ?? null;
  if (report.run) {
    kind = report.run.kind;
  } else {
    const k = inferKind(report.agent);
    if (!k) throw new Error(`Cannot determine run kind for agent "${report.agent}"; refusing to guess.`);
    kind = k;
    inferred.push("kind");
    if (kind === "llm") {
      // Only the provider's own error text can reveal these in a legacy report.
      const text = report.failures.map((f) => f.agentDecision.agentError ?? "").join("\n");
      const m = /model `([^`]+)`/.exec(text);
      if (m) { model = m[1]; inferred.push("model"); }
      if (/groq\.com/i.test(text)) { provider = "groq"; inferred.push("provider"); }
    }
  }

  let byKind = s.providerErrorsByKind;
  if (!byKind) {
    byKind = {};
    for (const f of report.failures) {
      if (f.failure.category !== "agent_error") continue;
      const k = classifyProviderError(f.agentDecision.agentError ?? "");
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    if (s.agentErrors) inferred.push("providerErrorsByKind");
  }

  const entry: HistoryEntry = {
    runId: report.runId,
    file,
    market: "futures",
    kind,
    agent: report.agent,
    provider,
    model,
    generatedAt: report.generatedAt,
    seed: report.seed,
    scenarios: s.scenarios,
    answeredScenarios: s.answeredScenarios ?? s.scenarios,
    passed: s.passed,
    failed: s.failed,
    agentErrors: s.agentErrors ?? 0,
    agentErrorRatePct: s.agentErrorRatePct ?? 0,
    providerErrorsByKind: byKind,
    riskViolations: s.riskViolations,
    consistencyFailures: s.consistencyFailures,
    mutationChecks: s.mutationChecks ?? report.mutationResults.length,
    validity: s.validity ?? "valid",
    decisionReliabilityPct: s.decisionReliabilityPct ?? null,
    riskCompliancePct: s.riskCompliancePct ?? null,
    decisionConsistencyPct: s.decisionConsistencyPct ?? null,
  };
  if (importedFrom) {
    entry.imported = {
      from: importedFrom,
      inferred,
      note: "Imported unchanged from a report written before run metadata existed; inferred fields listed above.",
    };
  }
  return entry;
}

async function readIndex(dir: string): Promise<HistoryEntry[]> {
  try {
    return JSON.parse(await readFile(join(dir, "index.json"), "utf-8")) as HistoryEntry[];
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw new Error(`History index in ${dir} is unreadable (${err?.message}); refusing to overwrite it.`);
  }
}

async function writeIndex(dir: string, entries: HistoryEntry[]): Promise<void> {
  entries.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  await writeFile(join(dir, "index.json"), JSON.stringify(entries, null, 2), "utf-8");
}

/** Stores a freshly generated report. Returns the index entry, or null if this runId was already stored. */
export async function recordRun(report: PolygraphReport, dir: string): Promise<HistoryEntry | null> {
  await mkdir(dir, { recursive: true });
  const index = await readIndex(dir);
  if (index.some((e) => e.runId === report.runId)) return null;
  const file = `futures-${safeStamp(report.generatedAt)}-${report.runId.slice(0, 8)}.json`;
  await writeFile(join(dir, file), JSON.stringify(report, null, 2), "utf-8");
  const entry = summarizeReport(report, file);
  index.push(entry);
  await writeIndex(dir, index);
  return entry;
}

/** Imports an existing report file verbatim. Returns null if its runId is already stored. */
export async function importReportFile(path: string, dir: string): Promise<HistoryEntry | null> {
  const report = JSON.parse(await readFile(path, "utf-8")) as PolygraphReport;
  if (!report.runId || !report.scorecard || !report.generatedAt) {
    throw new Error(`${path} is not a Futures Polygraph report (missing runId/scorecard/generatedAt).`);
  }
  await mkdir(dir, { recursive: true });
  const index = await readIndex(dir);
  if (index.some((e) => e.runId === report.runId)) return null;
  const file = `futures-${safeStamp(report.generatedAt)}-${report.runId.slice(0, 8)}.json`;
  const entry = summarizeReport(report, file, path);
  await copyFile(path, join(dir, file));
  index.push(entry);
  await writeIndex(dir, index);
  return entry;
}
