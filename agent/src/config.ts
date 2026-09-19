import {
  loadConfig,
  BitgetRestClient,
  buildTools,
  type BitgetConfig,
  type ToolSpec,
} from "@bitget-ai/bitget-agent-sdk";

export type RunMode = "mock" | "paper";

export interface RuntimeContext {
  mode: RunMode;
  source: "bitget_mock" | "bitget_paper";
  environment: "mock" | "paper";
  config: BitgetConfig;
  client: BitgetRestClient;
  tools: ToolSpec[];
  mockServer?: { stop: () => Promise<void>; baseUrl: string };
  instrument: { category: "SPOT"; symbol: string };
}

const DEFAULT_INSTRUMENT = { category: "SPOT" as const, symbol: "BTCUSDT" };

export async function createMockContext(): Promise<RuntimeContext> {
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

  return {
    mode: "mock",
    source: "bitget_mock",
    environment: "mock",
    config,
    client,
    tools,
    mockServer: mock,
    instrument: DEFAULT_INSTRUMENT,
  };
}

export function createPaperContext(): RuntimeContext {
  const config = loadConfig({
    modules: "market,trade,account",
    paperTrading: true,
  });

  if (!config.hasAuth) {
    throw new Error(
      "Paper mode requires real Bitget Demo API credentials in the environment: " +
        "BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE. " +
        "Create a Demo API Key at https://www.bitget.com/en/api-management, " +
        "export the three variables, then run `npm run paper` again. " +
        "This step cannot be completed on your behalf.",
    );
  }

  const client = new BitgetRestClient(config);
  const tools = buildTools(config);

  return {
    mode: "paper",
    source: "bitget_paper",
    environment: "paper",
    config,
    client,
    tools,
    instrument: DEFAULT_INSTRUMENT,
  };
}
