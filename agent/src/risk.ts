import type { PositionState } from "./position.js";

export interface Decision {
  action: "buy" | "hold" | "sell";
  qty: number; 
  rationale: string;
}

export interface RiskVerdict {
  approved: boolean;
  approvedQty: number;
  reasons: string[];
}

export const MAX_NOTIONAL_USDT = 5;
export const MIN_NOTIONAL_USDT = 2;
export const REQUIRE_KNOWN_PRICE = true;

export function evaluateRisk(
  decision: Decision,
  lastPrice: number | null,
  position: PositionState,
): RiskVerdict {
  const reasons: string[] = [];

  if (REQUIRE_KNOWN_PRICE && lastPrice === null) {
    return { approved: false, approvedQty: 0, reasons: ["no market price available - refusing to trade blind"] };
  }

  if (decision.action === "hold") {
    return { approved: true, approvedQty: 0, reasons: [] };
  }

  if (decision.action === "buy") {
    if (position.inPosition) {
      return { approved: false, approvedQty: 0, reasons: ["already in position - refusing to buy again"] };
    }
    let notional = decision.qty;
    if (notional > MAX_NOTIONAL_USDT) {
      reasons.push(`requested notional ${notional} USDT exceeds MAX_NOTIONAL_USDT ${MAX_NOTIONAL_USDT} - clipped`);
      notional = MAX_NOTIONAL_USDT;
    }
    if (notional < MIN_NOTIONAL_USDT) {
      return { approved: false, approvedQty: 0, reasons: [`notional ${notional} USDT below MIN_NOTIONAL_USDT ${MIN_NOTIONAL_USDT}`] };
    }
    return { approved: true, approvedQty: notional, reasons };
  }

  if (!position.inPosition || !position.entryQtyBase || position.entryQtyBase <= 0) {
    return { approved: false, approvedQty: 0, reasons: ["no open position to sell"] };
  }
  let qtyBase = decision.qty;
  if (qtyBase > position.entryQtyBase) {
    reasons.push(`requested sell qty ${qtyBase} exceeds held ${position.entryQtyBase} - clipped to held amount`);
    qtyBase = position.entryQtyBase;
  }
  if (qtyBase <= 0) {
    return { approved: false, approvedQty: 0, reasons: ["non-positive sell quantity"] };
  }
  return { approved: true, approvedQty: qtyBase, reasons };
}
