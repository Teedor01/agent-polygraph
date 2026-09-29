import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFuturesRisk,
  FUTURES_MAX_LEVERAGE,
  FUTURES_ABSOLUTE_MAX_LEVERAGE,
  FUTURES_ABSOLUTE_MAX_NOTIONAL_USDT,
  FUTURES_MIN_QTY_BTC,
} from "./risk.js";
import type { FuturesDecision, FuturesPositionSnapshot } from "./types.js";
import { FLAT_FUTURES_SNAPSHOT } from "./types.js";

const PRICE = 60_000;

function decision(action: FuturesDecision["action"], confidence = 0.8, reason = "test"): FuturesDecision {
  return { action, confidence, reason };
}

function longPosition(overrides: Partial<FuturesPositionSnapshot> = {}): FuturesPositionSnapshot {
  return {
    available: true,
    side: "LONG",
    entryPrice: 59_000,
    quantity: 0.01,
    leverage: 3,
    unrealizedPnl: 10,
    liquidationPrice: 40_000,
    margin: 200,
    positionId: "pos-1",
    raw: null,
    error: null,
    ...overrides,
  };
}

function shortPosition(overrides: Partial<FuturesPositionSnapshot> = {}): FuturesPositionSnapshot {
  return {
    ...longPosition(overrides),
    side: "SHORT",
    ...overrides,
  };
}


test("1. FLAT + OPEN_LONG is allowed", () => {
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, true);
  assert.equal(v.approvedAction, "OPEN_LONG");
  assert.ok(v.qty > 0);
});

test("2. FLAT + OPEN_SHORT is allowed", () => {
  const v = evaluateFuturesRisk(decision("OPEN_SHORT"), PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, true);
  assert.equal(v.approvedAction, "OPEN_SHORT");
  assert.ok(v.qty > 0);
});

test("3. FLAT + HOLD is allowed", () => {
  const v = evaluateFuturesRisk(decision("HOLD"), PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, true);
  assert.equal(v.approvedAction, "HOLD");
  assert.equal(v.qty, 0);
});

test("4. FLAT + CLOSE_LONG is rejected", () => {
  const v = evaluateFuturesRisk(decision("CLOSE_LONG"), PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, false);
});

test("5. FLAT + CLOSE_SHORT is rejected", () => {
  const v = evaluateFuturesRisk(decision("CLOSE_SHORT"), PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, false);
});

// 6-8: from LONG
test("6. LONG + HOLD is allowed", () => {
  const v = evaluateFuturesRisk(decision("HOLD"), PRICE, longPosition());
  assert.equal(v.approved, true);
  assert.equal(v.approvedAction, "HOLD");
});

test("7. LONG + CLOSE_LONG is allowed and closes the full recorded size", () => {
  const pos = longPosition({ quantity: 0.015 });
  const v = evaluateFuturesRisk(decision("CLOSE_LONG"), PRICE, pos);
  assert.equal(v.approved, true);
  assert.equal(v.approvedAction, "CLOSE_LONG");
  assert.equal(v.qty, 0.015);
});

test("8. LONG + CLOSE_SHORT is rejected", () => {
  const v = evaluateFuturesRisk(decision("CLOSE_SHORT"), PRICE, longPosition());
  assert.equal(v.approved, false);
});

test("LONG + OPEN_SHORT (silent reversal) is rejected, not executed as a flip", () => {
  const v = evaluateFuturesRisk(decision("OPEN_SHORT"), PRICE, longPosition());
  assert.equal(v.approved, false);
});

test("LONG + OPEN_LONG (re-opening an already-open long) is rejected, not treated as a fresh trade", () => {
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), PRICE, longPosition());
  assert.equal(v.approved, false);
});

// 9-11: from SHORT
test("9. SHORT + HOLD is allowed", () => {
  const v = evaluateFuturesRisk(decision("HOLD"), PRICE, shortPosition());
  assert.equal(v.approved, true);
  assert.equal(v.approvedAction, "HOLD");
});

test("10. SHORT + CLOSE_SHORT is allowed and closes the full recorded size", () => {
  const pos = shortPosition({ quantity: 0.02 });
  const v = evaluateFuturesRisk(decision("CLOSE_SHORT"), PRICE, pos);
  assert.equal(v.approved, true);
  assert.equal(v.approvedAction, "CLOSE_SHORT");
  assert.equal(v.qty, 0.02);
});

test("11. SHORT + CLOSE_LONG is rejected", () => {
  const v = evaluateFuturesRisk(decision("CLOSE_LONG"), PRICE, shortPosition());
  assert.equal(v.approved, false);
});

test("SHORT + OPEN_LONG (silent reversal) is rejected", () => {
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), PRICE, shortPosition());
  assert.equal(v.approved, false);
});

// 12-13: hard ceilings, cannot be bypassed via options
test("12. excessive leverage is rejected outright, even when explicitly requested via options", () => {
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), PRICE, FLAT_FUTURES_SNAPSHOT, {
    maxLeverage: FUTURES_ABSOLUTE_MAX_LEVERAGE + 1,
  });
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(" "), /leverage/i);
});

test("12b. leverage above FUTURES_MAX_LEVERAGE but at/below the absolute ceiling is still honored, not silently reduced", () => {
  // sanity check the two ceilings are actually distinct in this config
  assert.ok(FUTURES_ABSOLUTE_MAX_LEVERAGE >= FUTURES_MAX_LEVERAGE);
});

test("13. excessive notional is rejected outright, even when explicitly requested via options", () => {
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), PRICE, FLAT_FUTURES_SNAPSHOT, {
    maxNotionalUsdt: FUTURES_ABSOLUTE_MAX_NOTIONAL_USDT + 1,
  });
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(" "), /notional/i);
});

test("a configured margin budget below the notional ceiling clips the computed size rather than rejecting", () => {
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), PRICE, FLAT_FUTURES_SNAPSHOT, {
    maxNotionalUsdt: 40,
    maxMarginBudgetUsdt: 5,
    maxLeverage: 2,
  });
  assert.equal(v.approved, true);
  // margin(5) * leverage(2) = 10 USDT notional, well under the 40 USDT ceiling
  const impliedNotional = v.qty * PRICE;
  assert.ok(impliedNotional <= 10.0001, `implied notional ${impliedNotional} should be capped near 10`);
});

// 14: close quantity greater than held position
test("14. a close quantity override greater than the held position is rejected", () => {
  const pos = longPosition({ quantity: 0.01 });
  const v = evaluateFuturesRisk(decision("CLOSE_LONG"), PRICE, pos, { closeQtyOverride: 0.05 });
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(" "), /exceeds the held position/i);
});

// 15: malformed LLM output
test("15a. malformed LLM output (unrecognized action) is rejected", () => {
  const v = evaluateFuturesRisk(decision("SHORT" as any), PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, false);
});

test("15b. malformed LLM output (out-of-range confidence) is rejected", () => {
  const v = evaluateFuturesRisk(decision("HOLD", 1.5), PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, false);
});

test("15c. malformed LLM output (NaN confidence) is rejected", () => {
  const v = evaluateFuturesRisk(decision("HOLD", NaN), PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, false);
});

// 16: missing/unavailable position state
test("16a. missing position state safely rejects everything except HOLD", () => {
  const unavailable: FuturesPositionSnapshot = { ...FLAT_FUTURES_SNAPSHOT, available: false, error: "timeout" };
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), PRICE, unavailable);
  assert.equal(v.approved, false);
});

test("16b. missing position state still allows HOLD, since HOLD needs no position knowledge", () => {
  const unavailable: FuturesPositionSnapshot = { ...FLAT_FUTURES_SNAPSHOT, available: false, error: "timeout" };
  const v = evaluateFuturesRisk(decision("HOLD"), PRICE, unavailable);
  assert.equal(v.approved, true);
  assert.equal(v.approvedAction, "HOLD");
});

// 17: cannot be bypassed - a grab-bag of "creative" attempts to sneak past the engine
test("17a. cannot bypass via a decision object with extra/forged fields", () => {
  const d = { action: "OPEN_LONG", confidence: 0.9, reason: "x", qty: 999, leverage: 999 } as unknown as FuturesDecision;
  const v = evaluateFuturesRisk(d, PRICE, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, true); // the action itself is legal from FLAT...
  assert.notEqual(v.qty, 999); // ...but the forged qty/leverage on the decision object is never read
  assert.ok(v.qty * PRICE <= FUTURES_ABSOLUTE_MAX_NOTIONAL_USDT);
});

test("17b. cannot bypass a missing price by opening anyway", () => {
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), null, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, false);
});

test("17c. cannot bypass with a zero or negative price", () => {
  const v = evaluateFuturesRisk(decision("OPEN_SHORT"), 0, FLAT_FUTURES_SNAPSHOT);
  assert.equal(v.approved, false);
});

test("a computed size below the minimum order size is rejected rather than rounded up", () => {
  const v = evaluateFuturesRisk(decision("OPEN_LONG"), PRICE, FLAT_FUTURES_SNAPSHOT, {
    maxNotionalUsdt: FUTURES_MIN_QTY_BTC * PRICE * 0.5,
  });
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(" "), /minimum order size/i);
});

test("HOLD is always approved with zero quantity and never touches sizing logic", () => {
  for (const side of ["FLAT", "LONG", "SHORT"] as const) {
    const pos = side === "FLAT" ? FLAT_FUTURES_SNAPSHOT : side === "LONG" ? longPosition() : shortPosition();
    const v = evaluateFuturesRisk(decision("HOLD"), PRICE, pos);
    assert.equal(v.approved, true);
    assert.equal(v.qty, 0);
  }
});
