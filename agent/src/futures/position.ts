import { safeInvoke } from "@bitget-ai/bitget-agent-sdk";
import type { FuturesRuntimeContext } from "./config.js";
import type { FuturesPositionSnapshot, FuturesSide } from "./types.js";

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function getFuturesPositionSnapshot(
  ctx: FuturesRuntimeContext,
): Promise<FuturesPositionSnapshot> {
  const positionTool = ctx.tools.find((t) => t.name === "position");

  if (!positionTool) {
    return {
      available: false,
      side: "FLAT",
      entryPrice: null,
      quantity: null,
      leverage: null,
      unrealizedPnl: null,
      liquidationPrice: null,
      margin: null,
      positionId: null,
      raw: null,
      error: "`position` tool not present in this config's tool surface",
    };
  }

  const res = await safeInvoke(
    positionTool,
    {
      action: "info",
      category: ctx.instrument.category,
      symbol: ctx.instrument.symbol,
    },
    {
      config: ctx.config,
      client: ctx.client,
    },
  );

  if (!res.ok) {
    return {
      available: false,
      side: "FLAT",
      entryPrice: null,
      quantity: null,
      leverage: null,
      unrealizedPnl: null,
      liquidationPrice: null,
      margin: null,
      positionId: null,
      raw: res.error,
      error: JSON.stringify(res.error),
    };
  }

  const data = res.data as any;

  const rows: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.data)
        ? data.data
        : data
          ? [data]
          : [];


  const openRow = rows.find((row) => {
    const size = num(row?.total ?? row?.size ?? row?.available);
    return size !== null && size > 0;
  });

  if (!openRow) {
    return {
      available: true,
      side: "FLAT",
      entryPrice: null,
      quantity: null,
      leverage: null,
      unrealizedPnl: null,
      liquidationPrice: null,
      margin: null,
      positionId: null,
      raw: res.data,
      error: null,
    };
  }


  const positionSide = String(
    openRow.posSide ??
      openRow.holdSide ??
      openRow.side ??
      "",
  ).toLowerCase();

  const side: FuturesSide =
    positionSide === "long"
      ? "LONG"
      : positionSide === "short"
        ? "SHORT"
        : "FLAT";

  return {
    available: true,
    side,
    entryPrice: num(
      openRow.avgPrice ??
        openRow.openPriceAvg ??
        openRow.entryPrice ??
        openRow.avgOpenPrice,
    ),
    quantity: num(
      openRow.total ??
        openRow.size ??
        openRow.available,
    ),
    leverage: num(openRow.leverage),
    unrealizedPnl: num(
      openRow.unrealisedPnl ??
        openRow.unrealizedPnl ??
        openRow.unrealizedPL ??
        openRow.upl,
    ),
    liquidationPrice: num(
      openRow.liquidationPrice ??
        openRow.liqPx,
    ),
    margin: num(
      openRow.margin ??
        openRow.marginSize ??
        openRow.positionBalance,
    ),
    positionId: (
      openRow.positionId ??
      openRow.posId ??
      null
    ) as string | null,
    raw: res.data,
    error: null,
  };
}