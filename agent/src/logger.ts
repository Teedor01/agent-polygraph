import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimeContext } from "./config.js";
import type { MarketState } from "./market.js";
import type { Decision, RiskVerdict } from "./risk.js";
import type { ExecutionResult } from "./execution.js";
import type { PositionState } from "./position.js";

export interface LogEntry {
  timestamp: string;
  source: "bitget_mock" | "bitget_paper";
  environment: "mock" | "paper";
  symbol: string;
  category: string;
  market_state: MarketState;
  decision: Decision;
  decision_source: "deterministic" | "llm" | "llm_fallback";
  llm_meta: { provider: string; model: string; raw: { action: string; confidence: number; reason: string } | null; error: string | null } | null;
  risk_verdict: RiskVerdict;
  execution: ExecutionResult | null;
  position_before: PositionState;
  position_after: PositionState;
}

const LOG_DIR = path.join(process.cwd(), "logs");

function logPathFor(ctx: RuntimeContext): string {
  return path.join(LOG_DIR, `trades.${ctx.environment}.jsonl`);
}

export async function appendLogEntry(
  ctx: RuntimeContext,
  marketState: MarketState,
  decision: Decision,
  riskVerdict: RiskVerdict,
  execution: ExecutionResult | null,
  positionBefore: PositionState,
  positionAfter: PositionState,
  decisionSource: "deterministic" | "llm" | "llm_fallback" = "deterministic",
  llmMeta: LogEntry["llm_meta"] = null,
): Promise<string> {
  await mkdir(LOG_DIR, { recursive: true });

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    source: ctx.source,
    environment: ctx.environment,
    symbol: ctx.instrument.symbol,
    category: ctx.instrument.category,
    market_state: marketState,
    decision,
    decision_source: decisionSource,
    llm_meta: llmMeta,
    risk_verdict: riskVerdict,
    execution,
    position_before: positionBefore,
    position_after: positionAfter,
  };

  const filePath = logPathFor(ctx);
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
  return filePath;
}
