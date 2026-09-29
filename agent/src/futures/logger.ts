import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FuturesRuntimeContext } from "./config.js";
import type { FuturesMarketState } from "./market.js";
import type { FuturesDecision, FuturesPositionSnapshot, FuturesRiskVerdict } from "./types.js";
import type { FuturesExecutionResult } from "./execution.js";

export interface FuturesLogEntry {
  timestamp: string;
  mode: "mock" | "paper";
  source: "bitget_mock_futures" | "bitget_paper_futures";
  decisionMode: "llm";
  decisionSource: "llm" | "llm_fallback";
  symbol: string;
  marketType: "USDT-FUTURES";
  positionBefore: FuturesPositionSnapshot;
  marketState: FuturesMarketState;
  decision: FuturesDecision;
  riskVerdict: FuturesRiskVerdict;
  execution: FuturesExecutionResult | null;
  positionAfter: FuturesPositionSnapshot | null; // null when not re-queried this cycle (see agent.ts)
  llmMeta: { provider: string; model: string; raw: { action: string; confidence: number; reason: string } | null; error: string | null } | null;
}

const LOG_DIR = path.join(process.cwd(), "logs");

function logPathFor(ctx: FuturesRuntimeContext): string {
  return path.join(LOG_DIR, `trades-futures.${ctx.environment}.jsonl`);
}

export async function appendFuturesLogEntry(ctx: FuturesRuntimeContext, entry: Omit<FuturesLogEntry, "timestamp" | "mode" | "source" | "symbol" | "marketType">): Promise<string> {
  await mkdir(LOG_DIR, { recursive: true });

  const full: FuturesLogEntry = {
    timestamp: new Date().toISOString(),
    mode: ctx.mode,
    source: ctx.source,
    symbol: ctx.instrument.symbol,
    marketType: ctx.instrument.category,
    ...entry,
  };

  const filePath = logPathFor(ctx);
  await appendFile(filePath, JSON.stringify(full) + "\n", "utf-8");
  return filePath;
}
