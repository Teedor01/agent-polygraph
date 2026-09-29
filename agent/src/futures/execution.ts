import { randomUUID } from "node:crypto";
import { safeInvoke } from "@bitget-ai/bitget-agent-sdk";
import type { FuturesRuntimeContext } from "./config.js";
import type { FuturesAction, FuturesRiskVerdict } from "./types.js";

export interface FuturesExecutionResult {
action: FuturesAction;
orderId: string | null;
clientOid: string | null;
status: "placed" | "closed" | "error" | "skipped";
executedQty: number | null;
executedPrice: number | null;
raw: unknown;
error?: string;
}

const SKIPPED: FuturesExecutionResult = {
action: "HOLD",
orderId: null,
clientOid: null,
status: "skipped",
executedQty: null,
executedPrice: null,
raw: null,
};

async function openPosition(
ctx: FuturesRuntimeContext,
verdict: FuturesRiskVerdict,
side: "buy" | "sell",
): Promise<FuturesExecutionResult> {
const orderTool = ctx.tools.find((t) => t.name === "order");

if (!orderTool) {
throw new Error(
"`order` tool not present in this config's tool surface.",
);
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
qty: String(verdict.qty),
clientOid,
},
{
config: ctx.config,
client: ctx.client,
},
);

if (!res.ok) {
return {
action: verdict.approvedAction,
orderId: null,
clientOid,
status: "error",
executedQty: null,
executedPrice: null,
raw: res.error,
error: JSON.stringify(res.error),
};
}

const placed = res.data as any;

const orderId: string | null =
placed?.orderId ??
placed?.data?.orderId ??
null;

let executedQty: number | null = null;
let executedPrice: number | null = null;
let detailRaw: unknown = null;

if (orderId) {
const orderTool2 = ctx.tools.find(
(t) => t.name === "order",
)!;


const detailRes = await safeInvoke(
  orderTool2,
  {
    action: "detail",
    category: ctx.instrument.category,
    symbol: ctx.instrument.symbol,
    orderId,
  },
  {
    config: ctx.config,
    client: ctx.client,
  },
);

if (detailRes.ok) {
  detailRaw = detailRes.data;

  const d = detailRes.data as any;
  const row = Array.isArray(d) ? d[0] : d;

  const filled =
    row?.cumExecQty ??
    row?.filledSize ??
    row?.baseVolume;

  const px =
    row?.avgPrice ??
    row?.priceAvg ??
    row?.price;

  executedQty =
    filled !== undefined && filled !== ""
      ? Number(filled)
      : null;

  executedPrice =
    px !== undefined && px !== ""
      ? Number(px)
      : null;
} else {
  detailRaw = detailRes.error;
}


}

return {
action: verdict.approvedAction,
orderId,
clientOid,
status: "placed",
executedQty,
executedPrice,
raw: {
place: placed,
detail: detailRaw,
},
};
}

function requiresConfirmation(data: unknown): boolean {
const value = data as any;

return (
value?.confirmationRequired === true ||
value?.data?.confirmationRequired === true
);
}

async function closePosition(
ctx: FuturesRuntimeContext,
verdict: FuturesRiskVerdict,
posSide: "long" | "short",
): Promise<FuturesExecutionResult> {
const positionTool = ctx.tools.find(
(t) => t.name === "position",
);

if (!positionTool) {
throw new Error(
"`position` tool not present in this config's tool surface.",
);
}

const closeArgs = {
action: "close",
category: ctx.instrument.category,
symbol: ctx.instrument.symbol,
posSide,
};

const firstRes = await safeInvoke(
positionTool,
closeArgs,
{
config: ctx.config,
client: ctx.client,
},
);

if (!firstRes.ok) {
return {
action: verdict.approvedAction,
orderId: null,
clientOid: null,
status: "error",
executedQty: null,
executedPrice: null,
raw: firstRes.error,
error: JSON.stringify(firstRes.error),
};
}

  if (requiresConfirmation(firstRes.data)) {
  const confirmedRes = await safeInvoke(
  positionTool,
  {
  ...closeArgs,
  confirm: true,
  },
  {
  config: ctx.config,
  client: ctx.client,
  },
  );


if (!confirmedRes.ok) {



  return {
    action: verdict.approvedAction,
    orderId: null,
    clientOid: null,
    status: "error",
    executedQty: null,
    executedPrice: null,
    raw: {
      initial: firstRes.data,
      confirmation: confirmedRes.error,
    },
    error: JSON.stringify(
      confirmedRes.error,
    ),
  };
}

if (requiresConfirmation(confirmedRes.data)) {
  return {
    action: verdict.approvedAction,
    orderId: null,
    clientOid: null,
    status: "error",
    executedQty: null,
    executedPrice: null,
    raw: {
      initial: firstRes.data,
      confirmation: confirmedRes.data,
    },
    error:
      "Bitget still requires confirmation after the confirmed close request.",
  };
}

return {
  action: verdict.approvedAction,
  orderId: null,
  clientOid: null,
  status: "closed",
  executedQty: verdict.qty,
  executedPrice: null,
  raw: {
    initial: firstRes.data,
    confirmation: confirmedRes.data,
  },
};


}


  return {
  action: verdict.approvedAction,
  orderId: null,
  clientOid: null,
  status: "closed",
  executedQty: verdict.qty,
  executedPrice: null,
  raw: firstRes.data,
  };
  }

export async function executeFuturesDecision(
ctx: FuturesRuntimeContext,
verdict: FuturesRiskVerdict,
): Promise<FuturesExecutionResult> {
if (
!verdict.approved ||
verdict.approvedAction === "HOLD"
) {
return {
...SKIPPED,
action: verdict.approvedAction,
};
}

switch (verdict.approvedAction) {
case "OPEN_LONG":
return openPosition(
ctx,
verdict,
"buy",
);


case "OPEN_SHORT":
  return openPosition(
    ctx,
    verdict,
    "sell",
  );

case "CLOSE_LONG":
  return closePosition(
    ctx,
    verdict,
    "long",
  );

case "CLOSE_SHORT":
  return closePosition(
    ctx,
    verdict,
    "short",
  );

default:
  return {
    ...SKIPPED,
    action: verdict.approvedAction,
    status: "error",
    error: `unhandled action ${verdict.approvedAction}`,
  };


}
}
