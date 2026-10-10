import test from "node:test";
import assert from "node:assert/strict";
import { generateScenarios, createSeededRng } from "./scenarios.js";
import { MARKET_REGIMES } from "./types.js";

test("same seed produces byte-identical scenarios", () => {
  const a = generateScenarios(42, 3);
  const b = generateScenarios(42, 3);
  assert.deepEqual(a, b);
});

test("different seeds produce different scenarios", () => {
  const a = generateScenarios(1, 3);
  const b = generateScenarios(2, 3);
  assert.notDeepEqual(a, b);
});

test("every declared regime is actually generated", () => {
  const scenarios = generateScenarios(7, 2);
  const regimesSeen = new Set(scenarios.map((s) => s.regime));
  for (const regime of MARKET_REGIMES) {
    assert.ok(regimesSeen.has(regime), `regime ${regime} was never generated`);
  }
});

test("countPerRegime is honored exactly", () => {
  const scenarios = generateScenarios(7, 5);
  assert.equal(scenarios.length, MARKET_REGIMES.length * 5);
});

test("scenario ids are unique", () => {
  const scenarios = generateScenarios(7, 4);
  const ids = new Set(scenarios.map((s) => s.id));
  assert.equal(ids.size, scenarios.length);
});

test("bull_trend scenarios are internally coherent: price above both SMAs, positive momentum and RSI", () => {
  const scenarios = generateScenarios(7, 3).filter((s) => s.regime === "bull_trend");
  for (const s of scenarios) {
    assert.ok(s.market.lastPrice! > s.market.sma20!);
    assert.ok(s.market.sma20! > s.market.sma50!);
    assert.ok(s.market.momentum! > 0);
    assert.ok(s.market.rsi! > 55);
    assert.equal(s.expectedBias, "bullish");
  }
});

test("bear_trend scenarios are internally coherent: price below both SMAs, negative momentum and RSI", () => {
  const scenarios = generateScenarios(7, 3).filter((s) => s.regime === "bear_trend");
  for (const s of scenarios) {
    assert.ok(s.market.lastPrice! < s.market.sma20!);
    assert.ok(s.market.sma20! < s.market.sma50!);
    assert.ok(s.market.momentum! < 0);
    assert.ok(s.market.rsi! < 45);
    assert.equal(s.expectedBias, "bearish");
  }
});

test("data_missing_price scenarios genuinely null out indicators, not fabricate placeholders", () => {
  const scenarios = generateScenarios(7, 2).filter((s) => s.regime === "data_missing_price");
  for (const s of scenarios) {
    assert.equal(s.market.rsi, null);
    assert.equal(s.market.sma20, null);
    assert.equal(s.market.momentum, null);
    // price itself is still known - only technicals are missing
    assert.ok(typeof s.market.lastPrice === "number");
  }
});

test("data_missing_position scenarios mark position unavailable, never FLAT-by-assumption", () => {
  const scenarios = generateScenarios(7, 2).filter((s) => s.regime === "data_missing_position");
  for (const s of scenarios) {
    assert.equal(s.position.available, false);
  }
});

test("existing_long/existing_short scenarios carry a real open position with entry/qty/leverage", () => {
  const scenarios = generateScenarios(7, 4).filter((s) => s.regime === "existing_long" || s.regime === "existing_short");
  assert.ok(scenarios.length > 0);
  for (const s of scenarios) {
    assert.ok(s.position.side === "LONG" || s.position.side === "SHORT");
    assert.ok(typeof s.position.entryPrice === "number");
    assert.ok(typeof s.position.quantity === "number" && s.position.quantity > 0);
  }
});

test("intact existing-position variants are marked highBurdenToClose", () => {
  const scenarios = generateScenarios(7, 4).filter((s) => s.regime === "existing_long");
  assert.ok(scenarios.some((s) => s.highBurdenToClose === true));
});

test("existing_long/existing_short scenarios document that their liquidationPrice is synthetic, not real Bitget math", () => {
  const scenarios = generateScenarios(7, 4).filter((s) => s.regime === "existing_long" || s.regime === "existing_short");
  for (const s of scenarios) {
    assert.ok(
      s.notes.some((n) => /synthetic/i.test(n) && /liquidation/i.test(n)),
      `scenario ${s.id} does not document its synthetic liquidation price`,
    );
  }
});

test("mulberry32 PRNG is deterministic for a given seed", () => {
  const a = createSeededRng(99);
  const b = createSeededRng(99);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1);
  }
});

test("recentCandles agree with lastPrice (last candle closes at lastPrice)", () => {
  const scenarios = generateScenarios(7, 2);
  for (const s of scenarios) {
    if (s.market.recentCandles.length > 0) {
      const lastCandle = s.market.recentCandles[s.market.recentCandles.length - 1];
      assert.equal(lastCandle.close, s.market.lastPrice);
    }
  }
});

test("neutral/ambiguous regimes never carry a strict directional bias", () => {
  const neutralRegimes = ["sideways", "flat", "volatility_spike", "conflicting_indicators", "overbought", "oversold", "volume_spike", "volume_collapse"];
  const scenarios = generateScenarios(7, 3).filter((s) => neutralRegimes.includes(s.regime));
  for (const s of scenarios) {
    assert.equal(s.expectedBias, "neutral");
  }
});
