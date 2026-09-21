import { createMockContext, createPaperContext, type RunMode, type RuntimeContext } from "./config.js";
import { fetchMarketState } from "./market.js";
import { evaluateRisk, type Decision } from "./risk.js";
import { placeOrder } from "./execution.js";
import { appendLogEntry } from "./logger.js";
import { loadPosition, savePosition, FLAT_POSITION, type PositionState } from "./position.js";
import { acquireLock } from "./lock.js";
import { getLLMDecision } from "./llm_decision.js";
import { unlinkSync } from "node:fs";
import path from "node:path";

const TAKE_PROFIT_PCT = 0.005;
const STOP_LOSS_PCT = 0.005; 
const ENTRY_NOTIONAL_USDT = 5;

type DecisionMode = "deterministic" | "llm";

function parseMode(argv: string[]): RunMode {
  const idx = argv.indexOf("--mode");
  const fromFlag = idx !== -1 ? argv[idx + 1] : undefined;
  const fromEnv = process.env.AGENT_RUN_MODE;
  const mode = (fromFlag || fromEnv || "").trim();
  if (mode !== "mock" && mode !== "paper") {
    throw new Error('Missing or invalid mode. Pass --mode mock or --mode paper (or set AGENT_RUN_MODE).');
  }
  return mode;
}

function parseDecisionMode(): DecisionMode {
  const raw = (process.env.AGENT_MODE || "deterministic").trim();
  if (raw !== "deterministic" && raw !== "llm") {
    throw new Error(`Invalid AGENT_MODE='${raw}'. Must be 'deterministic' or 'llm'.`);
  }
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decideDeterministic(lastPrice: number | null, position: PositionState): Decision {
  if (lastPrice === null) {
    return { action: "hold", qty: 0, rationale: "no market price available" };
  }

  if (!position.inPosition) {
    return {
      action: "buy",
      qty: ENTRY_NOTIONAL_USDT,
      rationale: `flat - entering at observed price ${lastPrice}`,
    };
  }

  const entryPrice = position.entryPrice!;
  const changePct = (lastPrice - entryPrice) / entryPrice;

  if (changePct >= TAKE_PROFIT_PCT) {
    return {
      action: "sell",
      qty: position.entryQtyBase ?? 0,
      rationale: `take-profit: entry ${entryPrice}, now ${lastPrice} (+${(changePct * 100).toFixed(2)}%)`,
    };
  }
  if (changePct <= -STOP_LOSS_PCT) {
    return {
      action: "sell",
      qty: position.entryQtyBase ?? 0,
      rationale: `stop-loss: entry ${entryPrice}, now ${lastPrice} (${(changePct * 100).toFixed(2)}%)`,
    };
  }
  return {
    action: "hold",
    qty: 0,
    rationale: `in position since entry ${entryPrice}, now ${lastPrice} (${(changePct * 100).toFixed(2)}%), within thresholds`,
  };
}

async function runCycle(ctx: RuntimeContext, decisionMode: DecisionMode) {
  const positionBefore = await loadPosition(ctx);
  const marketState = await fetchMarketState(ctx);

  let decision: Decision;
  let llmMeta: { provider: string; model: string; raw: { action: string; confidence: number; reason: string } | null; error: string | null } | null = null;
  let decisionSourceForLog: "deterministic" | "llm" | "llm_fallback" = decisionMode;

  if (marketState.lastPrice === null) {
    decision = { action: "hold", qty: 0, rationale: "no market price available" };
  } else if (decisionMode === "llm") {
    const result = await getLLMDecision(ctx.instrument.symbol, marketState.lastPrice, positionBefore, ENTRY_NOTIONAL_USDT);
    decision = result.decision;
    llmMeta = { provider: result.provider, model: result.model, raw: result.llmRaw, error: result.error };
    decisionSourceForLog = result.error ? "llm_fallback" : "llm";
  } else {
    decision = decideDeterministic(marketState.lastPrice, positionBefore);
  }

  const riskVerdict = evaluateRisk(decision, marketState.lastPrice, positionBefore);

  const execution =
    riskVerdict.approved && riskVerdict.approvedQty > 0 && (decision.action === "buy" || decision.action === "sell")
      ? await placeOrder(ctx, riskVerdict, decision.action)
      : null;

  let positionAfter = positionBefore;
  const confirmedFill = execution?.status === "placed" && execution.executedQty !== null && execution.executedQty > 0;

  if (confirmedFill && decision.action === "buy") {
    positionAfter = {
      inPosition: true,
      entryPrice: execution!.executedPrice ?? marketState.lastPrice,
      entryQtyBase: execution!.executedQty,
      entryOrderId: execution!.orderId,
      entryTimestamp: new Date().toISOString(),
    };
  } else if (confirmedFill && decision.action === "sell") {
    positionAfter = { ...FLAT_POSITION };
  }

  if (positionAfter !== positionBefore) {
    await savePosition(ctx, positionAfter);
  }

  const logPath = await appendLogEntry(
    ctx, marketState, decision, riskVerdict, execution, positionBefore, positionAfter,
    decisionSourceForLog, llmMeta,
  );

  return {
    timestamp: new Date().toISOString(),
    mode: ctx.mode,
    source: ctx.source,
    decisionMode,
    decisionSource: decisionSourceForLog,
    symbol: ctx.instrument.symbol,
    lastPrice: marketState.lastPrice,
    decision,
    llmMeta,
    riskVerdict,
    execution,
    positionBefore,
    positionAfter,
    loggedTo: logPath,
  };
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const decisionMode = parseDecisionMode();
  const once = process.argv.includes("--once");
  const intervalMs = Number(process.env.AGENT_INTERVAL_MS || 15 * 60 * 1000);

  const ctx = mode === "mock" ? await createMockContext() : createPaperContext();

  const releaseLock = await acquireLock(ctx);
  const lockPath = path.join(process.cwd(), "logs", `agent.${ctx.environment}.lock`);
  const cleanupAndExit = (code: number) => () => {
    try {
      unlinkSync(lockPath);
    } catch {
    }
    process.exit(code);
  };

  process.on("SIGINT", cleanupAndExit(0));
  process.on("SIGTERM", cleanupAndExit(0));
  process.on("exit", () => {
    try {
      unlinkSync(lockPath);
    } catch {
    }
  });

  console.log(
    (once
      ? `Running one ${mode} cycle (decision mode: ${decisionMode})...`
      : `Running ${mode} continuously (decision mode: ${decisionMode}), one cycle every ${Math.round(intervalMs / 1000)}s. Press Ctrl+C to stop.`),
  );
  if (decisionMode === "llm" && !process.env.LLM_API_KEY) {
    console.warn("AGENT_MODE=llm but LLM_API_KEY is not set - every cycle will hold with an explicit failure reason until it is.");
  }

  try {
    while (true) {
      try {
        const summary = await runCycle(ctx, decisionMode);
        console.log(JSON.stringify(summary, null, 2));
      } catch (err) {
        console.error("Cycle failed, will retry next interval:", err instanceof Error ? err.message : err);
      }

      if (once) break;
      await sleep(intervalMs);
    }
  } finally {
    if (ctx.mockServer) {
      await ctx.mockServer.stop();
    }
    await releaseLock();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
