import { randomUUID } from "node:crypto";
import { safeInvoke } from "@bitget-ai/bitget-agent-sdk";
import type { RuntimeContext } from "./config.js";
import type { RiskVerdict } from "./risk.js";

export interface ExecutionResult {
  orderId: string | null;
  clientOid: string;
  status: "placed" | "error";
  executedQty: number | null;
  executedPrice: number | null;
  fees: unknown;
  raw: unknown;
  error?: string;
}

export async function placeOrder(
  ctx: RuntimeContext,
  verdict: RiskVerdict,
  side: "buy" | "sell",
): Promise<ExecutionResult> {
  const orderTool = ctx.tools.find((t) => t.name === "order");
  if (!orderTool) {
    throw new Error("`order` tool not present in this config's tool surface.");
  }

  const clientOid = randomUUID();

  const res = await safeInvoke(
    orderTool,
    {
      action: "place",
      category: ctx.instrument.category,
      symbol: ctx.instrument.symbol,
      side,
      orderType: "market",
      qty: String(verdict.approvedQty),
      clientOid,
    },
    { config: ctx.config, client: ctx.client },
  );

  if (!res.ok) {
    return {
      orderId: null,
      clientOid,
      status: "error",
      executedQty: null,
      executedPrice: null,
      fees: null,
      raw: res.error,
      error: JSON.stringify(res.error),
    };
  }

  const placed = res.data as any;
  const orderId: string | null = placed?.orderId ?? placed?.data?.orderId ?? null;


  let executedQty: number | null = null;
  let executedPrice: number | null = null;
  let fees: unknown = null;
  let detailRaw: unknown = null;

  if (orderId) {
    const detailRes = await safeInvoke(
      orderTool,
      { action: "detail", category: ctx.instrument.category, symbol: ctx.instrument.symbol, orderId },
      { config: ctx.config, client: ctx.client },
    );
    if (detailRes.ok) {
      detailRaw = detailRes.data;
      const d = detailRes.data as any;
      const row = Array.isArray(d) ? d[0] : d;
      const filled = row?.cumExecQty ?? row?.filledSize ?? row?.baseVolume;
      const px = row?.avgPrice ?? row?.priceAvg ?? row?.price;
      executedQty = filled !== undefined && filled !== "" ? Number(filled) : null;
      executedPrice = px !== undefined && px !== "" ? Number(px) : null;
      if (Array.isArray(row?.feeDetail) && row.feeDetail.length > 0) {
        fees = row.feeDetail;
      }
    } else {
      detailRaw = detailRes.error;
    }
  }

  return {
    orderId,
    clientOid,
    status: "placed",
    executedQty,
    executedPrice,
    fees,
    raw: { place: placed, detail: detailRaw },
  };
}
