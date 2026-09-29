export type FuturesSide = "FLAT" | "LONG" | "SHORT";


export type FuturesAction = "OPEN_LONG" | "CLOSE_LONG" | "OPEN_SHORT" | "CLOSE_SHORT" | "HOLD";

export const FUTURES_ACTIONS: readonly FuturesAction[] = [
  "OPEN_LONG",
  "CLOSE_LONG",
  "OPEN_SHORT",
  "CLOSE_SHORT",
  "HOLD",
];


export interface FuturesDecision {
  action: FuturesAction;
  confidence: number;
  reason: string;
}


export interface FuturesPositionSnapshot {
  available: boolean;
  side: FuturesSide;
  entryPrice: number | null;
  quantity: number | null; 
  leverage: number | null;
  unrealizedPnl: number | null;
  liquidationPrice: number | null; 
  margin: number | null;
  positionId: string | null;
  raw: unknown;
  error: string | null;
}

export const FLAT_FUTURES_SNAPSHOT: FuturesPositionSnapshot = {
  available: true,
  side: "FLAT",
  entryPrice: null,
  quantity: null,
  leverage: null,
  unrealizedPnl: null,
  liquidationPrice: null,
  margin: null,
  positionId: null,
  raw: null,
  error: null,
};

export interface FuturesRiskVerdict {
  approved: boolean;
  approvedAction: FuturesAction;
  qty: number; 
  leverage: number; 
  reasons: string[];
}
