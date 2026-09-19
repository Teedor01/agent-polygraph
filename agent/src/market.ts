import { safeInvoke } from "@bitget-ai/bitget-agent-sdk";
import type { RuntimeContext } from "./config.js";

export interface MarketState {
  timestamp: string;
  category: "SPOT";
  symbol: string;
  raw: unknown;
  lastPrice: number | null;
}

export async function fetchMarketState(ctx: RuntimeContext): Promise<MarketState> {
  const marketTool = ctx.tools.find((t) => t.name === "market");
  if (!marketTool) {
    throw new Error("`market` tool not present in this config's tool surface.");
  }

  const res = await safeInvoke(
    marketTool,
    { action: "tickers", category: ctx.instrument.category, symbol: ctx.instrument.symbol },
    { config: ctx.config, client: ctx.client },
  );

  if (!res.ok) {
    throw new Error(`market.tickers failed: ${JSON.stringify(res.error)}`);
  }

  const data = res.data as any;
  const row = Array.isArray(data) ? data[0] : Array.isArray(data?.data) ? data.data[0] : data;
  const lastPriceRaw = row?.lastPrice ?? row?.lastPr ?? row?.last ?? row?.close ?? null;
  const lastPrice = lastPriceRaw !== null ? Number(lastPriceRaw) : null;

  return {
    timestamp: new Date().toISOString(),
    category: ctx.instrument.category,
    symbol: ctx.instrument.symbol,
    raw: res.data,
    lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
  };
}
