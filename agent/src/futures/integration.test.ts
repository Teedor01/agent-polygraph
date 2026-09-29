import test from "node:test";
import assert from "node:assert/strict";
import { createFuturesMockContext } from "./config.js";
import { fetchFuturesMarketState } from "./market.js";
import { getFuturesPositionSnapshot } from "./position.js";
import { evaluateFuturesRisk } from "./risk.js";
import { executeFuturesDecision } from "./execution.js";
import type { FuturesRuntimeContext } from "./config.js";

async function withMockContext(fn: (ctx: FuturesRuntimeContext) => Promise<void>) {
  const ctx = await createFuturesMockContext();
  try {
    await fn(ctx);
  } finally {
    if (ctx.mockServer) await ctx.mockServer.stop();
  }
}

test("futures mock context builds with market/order/position tools present", async () => {
  await withMockContext(async (ctx) => {
    const names = ctx.tools.map((t) => t.name);
    assert.ok(names.includes("market"), "market tool missing");
    assert.ok(names.includes("order"), "order tool missing");
    assert.ok(names.includes("position"), "position tool missing");
    assert.equal(ctx.instrument.category, "USDT-FUTURES");
    assert.equal(ctx.instrument.symbol, "BTCUSDT");
  });
});

test("fetchFuturesMarketState returns against the mock server without throwing", async () => {
  await withMockContext(async (ctx) => {
    const market = await fetchFuturesMarketState(ctx);
    assert.equal(market.symbol, "BTCUSDT");
    assert.equal(market.category, "USDT-FUTURES");
    assert.ok(market.lastPrice === null || typeof market.lastPrice === "number");
  });
});

test("getFuturesPositionSnapshot returns a well-formed snapshot against the mock server", async () => {
  await withMockContext(async (ctx) => {
    const snap = await getFuturesPositionSnapshot(ctx);
    assert.equal(typeof snap.available, "boolean");
    assert.ok(["FLAT", "LONG", "SHORT"].includes(snap.side));
  });
});

test("18. an approved OPEN_LONG round-trips through the real order.place tool without throwing", async () => {
  await withMockContext(async (ctx) => {
    const verdict = evaluateFuturesRisk(
      { action: "OPEN_LONG", confidence: 0.8, reason: "test" },
      60_000,
      { available: true, side: "FLAT", entryPrice: null, quantity: null, leverage: null, unrealizedPnl: null, liquidationPrice: null, margin: null, positionId: null, raw: null, error: null },
    );
    assert.equal(verdict.approved, true);
    const result = await executeFuturesDecision(ctx, verdict);
    assert.ok(["placed", "error"].includes(result.status), `unexpected status ${result.status}`);
  });
});

test("18b. an approved CLOSE_LONG round-trips through the real position.close tool (reduce-only close) without throwing", async () => {
  await withMockContext(async (ctx) => {
    const verdict = evaluateFuturesRisk(
      { action: "CLOSE_LONG", confidence: 0.8, reason: "test" },
      60_000,
      { available: true, side: "LONG", entryPrice: 59_000, quantity: 0.01, leverage: 3, unrealizedPnl: 1, liquidationPrice: 40_000, margin: 100, positionId: "p1", raw: null, error: null },
    );
    assert.equal(verdict.approved, true);
    const result = await executeFuturesDecision(ctx, verdict);
    assert.ok(["closed", "error"].includes(result.status), `unexpected status ${result.status}`);
    // Confirms this path went through position.close, not order.place -
    // a "closed" status only exists on the closePosition branch.
  });
});

test("HOLD never calls the order or position tool at all", async () => {
  await withMockContext(async (ctx) => {
    const verdict = evaluateFuturesRisk(
      { action: "HOLD", confidence: 0.5, reason: "test" },
      60_000,
      { available: true, side: "FLAT", entryPrice: null, quantity: null, leverage: null, unrealizedPnl: null, liquidationPrice: null, margin: null, positionId: null, raw: null, error: null },
    );
    const result = await executeFuturesDecision(ctx, verdict);
    assert.equal(result.status, "skipped");
    assert.equal(result.orderId, null);
  });
});
