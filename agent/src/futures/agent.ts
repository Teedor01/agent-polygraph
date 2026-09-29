import { createFuturesMockContext, createFuturesPaperContext, type FuturesRunMode, type FuturesRuntimeContext } from "./config.js";
import { fetchFuturesMarketState } from "./market.js";
import { getFuturesPositionSnapshot } from "./position.js";
import { evaluateFuturesRisk } from "./risk.js";
import { executeFuturesDecision } from "./execution.js";
import { appendFuturesLogEntry } from "./logger.js";
import { getFuturesLLMDecision } from "./llm_decision.js";
import { acquireFuturesLock, futuresLockPath } from "./lock.js";
import { unlinkSync } from "node:fs";

function parseMode(argv: string[]): FuturesRunMode {
  const idx = argv.indexOf("--mode");
  const fromFlag = idx !== -1 ? argv[idx + 1] : undefined;
  const fromEnv = process.env.AGENT_RUN_MODE;
  const mode = (fromFlag || fromEnv || "").trim();
  if (mode !== "mock" && mode !== "paper") {
    throw new Error("Missing or invalid mode. Pass --mode mock or --mode paper (or set AGENT_RUN_MODE).");
  }
  return mode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFuturesCycle(ctx: FuturesRuntimeContext) {
  const positionBefore = await getFuturesPositionSnapshot(ctx);
  const marketState = await fetchFuturesMarketState(ctx);

  const llmResult = await getFuturesLLMDecision(marketState, positionBefore);
  const decision = llmResult.decision;
  const decisionSource: "llm" | "llm_fallback" = llmResult.error ? "llm_fallback" : "llm";

  const riskVerdict = evaluateFuturesRisk(decision, marketState.lastPrice, positionBefore);

  const execution = riskVerdict.approved && riskVerdict.approvedAction !== "HOLD"
    ? await executeFuturesDecision(ctx, riskVerdict)
    : null;


  const positionAfter = execution && execution.status !== "skipped" && execution.status !== "error"
    ? await getFuturesPositionSnapshot(ctx)
    : positionBefore;

  const logPath = await appendFuturesLogEntry(ctx, {
    decisionMode: "llm",
    decisionSource,
    positionBefore,
    marketState,
    decision,
    riskVerdict,
    execution,
    positionAfter,
    llmMeta: { provider: llmResult.provider, model: llmResult.model, raw: llmResult.llmRaw, error: llmResult.error },
  });

  return {
    timestamp: new Date().toISOString(),
    mode: ctx.mode,
    source: ctx.source,
    symbol: ctx.instrument.symbol,
    marketType: ctx.instrument.category,
    marketState,
    positionBefore,
    decision,
    decisionSource,
    riskVerdict,
    execution,
    positionAfter,
    loggedTo: logPath,
  };
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const once = process.argv.includes("--once");
  const intervalMs = Number(process.env.AGENT_INTERVAL_MS || 15 * 60 * 1000);

  const ctx = mode === "mock" ? await createFuturesMockContext() : await createFuturesPaperContext();

  const releaseLock = await acquireFuturesLock(ctx);
  const lockPath = futuresLockPath(ctx);
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
    once
      ? `Running one futures ${mode} cycle...`
      : `Running futures ${mode} continuously, one cycle every ${Math.round(intervalMs / 1000)}s. Press Ctrl+C to stop.`,
  );
  if (!process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GROQ_API_KEY) {
    console.warn("No LLM API key found in the environment - every futures cycle will HOLD with an explicit failure reason until one is set.");
  }

  try {

    while (true) {
      try {
        const summary = await runFuturesCycle(ctx);
        console.log(JSON.stringify(summary, null, 2));
      } catch (err) {
        console.error("Futures cycle failed, will retry next interval:", err instanceof Error ? err.message : err);
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