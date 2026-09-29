import type { FuturesAction, FuturesDecision, FuturesPositionSnapshot, FuturesRiskVerdict, FuturesSide } from "./types.js";
import { FUTURES_ACTIONS } from "./types.js";


export const FUTURES_ABSOLUTE_MAX_LEVERAGE = 5;
export const FUTURES_MAX_LEVERAGE = Math.min(
  Number(process.env.FUTURES_MAX_LEVERAGE || 3),
  FUTURES_ABSOLUTE_MAX_LEVERAGE,
);


export const FUTURES_ABSOLUTE_MAX_NOTIONAL_USDT = 50;
export const FUTURES_MAX_NOTIONAL_USDT = Math.min(
  Number(process.env.FUTURES_MAX_NOTIONAL_USDT || 20),
  FUTURES_ABSOLUTE_MAX_NOTIONAL_USDT,
);


export const FUTURES_MAX_MARGIN_BUDGET_USDT = Number(
  process.env.FUTURES_MAX_MARGIN_BUDGET_USDT || FUTURES_MAX_NOTIONAL_USDT / FUTURES_MAX_LEVERAGE,
);


export const FUTURES_MIN_QTY_BTC = 0.0001;

function reject(reasons: string[], leverage = FUTURES_MAX_LEVERAGE): FuturesRiskVerdict {
  return { approved: false, approvedAction: "HOLD", qty: 0, leverage, reasons };
}

function holdApproved(reasons: string[] = []): FuturesRiskVerdict {
  return { approved: true, approvedAction: "HOLD", qty: 0, leverage: FUTURES_MAX_LEVERAGE, reasons };
}


const LEGAL_TRANSITIONS: Record<FuturesSide, ReadonlySet<FuturesAction>> = {
  FLAT: new Set<FuturesAction>(["OPEN_LONG", "OPEN_SHORT", "HOLD"]),
  LONG: new Set<FuturesAction>(["CLOSE_LONG", "HOLD"]),
  SHORT: new Set<FuturesAction>(["CLOSE_SHORT", "HOLD"]),
};

export function evaluateFuturesRisk(
  decision: FuturesDecision,
  lastPrice: number | null,
  position: FuturesPositionSnapshot,
  options?: { maxNotionalUsdt?: number; maxMarginBudgetUsdt?: number; maxLeverage?: number; closeQtyOverride?: number },
): FuturesRiskVerdict {
  const requestedLeverage = options?.maxLeverage ?? FUTURES_MAX_LEVERAGE;
  const requestedNotional = options?.maxNotionalUsdt ?? FUTURES_MAX_NOTIONAL_USDT;


  if (requestedLeverage > FUTURES_ABSOLUTE_MAX_LEVERAGE) {
    return reject([
      `requested leverage ${requestedLeverage}x exceeds the absolute ceiling of ${FUTURES_ABSOLUTE_MAX_LEVERAGE}x - rejected outright, not clamped`,
    ], FUTURES_ABSOLUTE_MAX_LEVERAGE);
  }
  if (requestedNotional > FUTURES_ABSOLUTE_MAX_NOTIONAL_USDT) {
    return reject([
      `requested notional ${requestedNotional} USDT exceeds the absolute ceiling of ${FUTURES_ABSOLUTE_MAX_NOTIONAL_USDT} USDT - rejected outright, not clamped`,
    ], requestedLeverage);
  }

  const maxNotional = requestedNotional;
  const maxMargin = options?.maxMarginBudgetUsdt ?? FUTURES_MAX_MARGIN_BUDGET_USDT;
  const leverage = requestedLeverage;


  if (!FUTURES_ACTIONS.includes(decision.action)) {
    return reject([`malformed decision: action '${decision.action}' is not a recognized futures action`], leverage);
  }
  if (
    typeof decision.confidence !== "number" ||
    Number.isNaN(decision.confidence) ||
    decision.confidence < 0 ||
    decision.confidence > 1
  ) {
    return reject([`malformed decision: confidence ${decision.confidence} is not a number in [0, 1]`], leverage);
  }

  if (!position.available) {
    if (decision.action === "HOLD") {
      return { approved: true, approvedAction: "HOLD", qty: 0, leverage, reasons: [`position state unavailable (${position.error ?? "unknown reason"}), but HOLD requires no position knowledge`] };
    }
    return reject([`position state unavailable (${position.error ?? "unknown reason"}) - refusing every action except HOLD`], leverage);
  }

  if (decision.action === "HOLD") {
    return holdApproved();
  }


  const legal = LEGAL_TRANSITIONS[position.side];
  if (!legal.has(decision.action)) {
    return reject([
      `invalid transition: ${decision.action} is not legal from position side ${position.side} ` +
        `(reversal is not supported by this architecture - a position must be explicitly closed first)`,
    ], leverage);
  }


  if (decision.action === "CLOSE_LONG" || decision.action === "CLOSE_SHORT") {
    const qty = position.quantity ?? 0;
    if (qty <= 0) {
      return reject([`position side is ${position.side} but recorded quantity is ${qty} - nothing to close`], leverage);
    }

    if (options?.closeQtyOverride !== undefined && options.closeQtyOverride > qty) {
      return reject([
        `requested close quantity ${options.closeQtyOverride} exceeds the held position size ${qty} - rejected`,
      ], leverage);
    }
    return { approved: true, approvedAction: decision.action, qty, leverage, reasons: [] };
  }


  if (lastPrice === null || lastPrice <= 0) {
    return reject(["no valid market price available - refusing to size a new position"], leverage);
  }

  const reasons: string[] = [];
  let notional = maxNotional;
  const marginImpliedNotional = maxMargin * leverage;
  if (marginImpliedNotional < notional) {
    reasons.push(
      `margin budget ${maxMargin} USDT at ${leverage}x caps notional to ${marginImpliedNotional} USDT (below the ${maxNotional} USDT ceiling)`,
    );
    notional = marginImpliedNotional;
  }

  const qty = Math.floor((notional / lastPrice) * 1e5) / 1e5; 
  if (qty < FUTURES_MIN_QTY_BTC) {
    return reject([
      `computed size ${qty} BTC (from ${notional} USDT notional at price ${lastPrice}) is below the minimum ` +
        `order size ${FUTURES_MIN_QTY_BTC} BTC`,
    ], leverage);
  }

  return { approved: true, approvedAction: decision.action, qty, leverage, reasons };
}
