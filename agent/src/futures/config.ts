import {
  loadConfig,
  BitgetRestClient,
  buildTools,
  safeInvoke,
  type BitgetConfig,
  type ToolSpec,
} from "@bitget-ai/bitget-agent-sdk";
import { FUTURES_MAX_LEVERAGE } from "./risk.js";

export type FuturesRunMode = "mock" | "paper";

export interface FuturesRuntimeContext {
  mode: FuturesRunMode;
  source: "bitget_mock_futures" | "bitget_paper_futures";
  environment: "mock" | "paper";
  config: BitgetConfig;
  client: BitgetRestClient;
  tools: ToolSpec[];
  mockServer?: { stop: () => Promise<void>; baseUrl: string };
  instrument: { category: "USDT-FUTURES"; symbol: string };
}


const DEFAULT_FUTURES_INSTRUMENT = { category: "USDT-FUTURES" as const, symbol: "BTCUSDT" };

async function applyAccountPolicy(ctx: FuturesRuntimeContext): Promise<void> {
  const accountConfigTool = ctx.tools.find((t) => t.name === "account_config");
  if (!accountConfigTool) return; 

  const holdModeRes = await safeInvoke(
    accountConfigTool,
    { action: "setHoldingMode", holdMode: "one_way_mode" },
    { config: ctx.config, client: ctx.client },
  );
  if (!holdModeRes.ok) {
    console.warn(
      `futures: could not set one-way holding mode (continuing anyway - this only matters if the ` +
        `account was in hedge mode): ${JSON.stringify(holdModeRes.error)}`,
    );
  }

  const leverageRes = await safeInvoke(
    accountConfigTool,
    {
      action: "setLeverage",
      category: ctx.instrument.category,
      symbol: ctx.instrument.symbol,
      leverage: String(FUTURES_MAX_LEVERAGE),
    },
    { config: ctx.config, client: ctx.client },
  );
  if (!leverageRes.ok) {
    console.warn(
      `futures: could not set leverage to ${FUTURES_MAX_LEVERAGE}x (continuing anyway - the risk ` +
        `engine still enforces its own leverage cap independent of what the account is actually set ` +
        `to): ${JSON.stringify(leverageRes.error)}`,
    );
  }
}

export async function createFuturesMockContext(): Promise<FuturesRuntimeContext> {
  const { MockServer } = await import("@bitget-ai/bitget-agent-sdk/testing");

  const mock = new MockServer();
  await mock.start();

  const config = loadConfig({
    modules: "market,trade,account",
    baseUrl: mock.baseUrl,
    apiKey: "mock-key",
    secretKey: "mock-secret",
    passphrase: "mock-pass",
  });
  const client = new BitgetRestClient(config);
  const tools = buildTools(config);

  const ctx: FuturesRuntimeContext = {
    mode: "mock",
    source: "bitget_mock_futures",
    environment: "mock",
    config,
    client,
    tools,
    mockServer: mock,
    instrument: DEFAULT_FUTURES_INSTRUMENT,
  };
  await applyAccountPolicy(ctx);
  return ctx;
}

export async function createFuturesPaperContext(): Promise<FuturesRuntimeContext> {
  const config = loadConfig({
    modules: "market,trade,account",
    paperTrading: true,
  });

  if (!config.hasAuth) {
    throw new Error(
      "Futures paper mode requires the same real Bitget Demo API credentials spot uses: " +
        "BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE (Unified Trading Account - one key " +
        "covers both spot and futures). Export the three variables, then run `npm run paper:futures` again.",
    );
  }

  const client = new BitgetRestClient(config);
  const tools = buildTools(config);

  const ctx: FuturesRuntimeContext = {
    mode: "paper",
    source: "bitget_paper_futures",
    environment: "paper",
    config,
    client,
    tools,
    instrument: DEFAULT_FUTURES_INSTRUMENT,
  };
  await applyAccountPolicy(ctx);
  return ctx;
}
