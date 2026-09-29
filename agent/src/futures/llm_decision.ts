import type { FuturesMarketState } from "./market.js";
import type {
  FuturesDecision,
  FuturesPositionSnapshot,
} from "./types.js";
import { FUTURES_ACTIONS } from "./types.js";

export type FuturesLLMProvider =
  | "openai"
  | "groq"
  | "bedrock"
  | "custom";

export interface FuturesLLMDecisionResult {
  decision: FuturesDecision;
  llmRaw: {
    action: string;
    confidence: number;
    reason: string;
  } | null;
  provider: FuturesLLMProvider;
  model: string;
  error: string | null;
}

const FUTURES_SYSTEM_PROMPT = `
You are the decision-making layer for a single BTCUSDT USDT-margined futures position on Bitget Demo Trading.

Your job is to decide whether to OPEN_LONG, OPEN_SHORT, CLOSE_LONG, CLOSE_SHORT, or HOLD based only on the market and position information provided to you.

You do NOT control quantity, leverage, margin, order type, or execution parameters. Those are controlled by a separate deterministic risk system.

Respond with ONLY this JSON object:

{
  "action": "OPEN_LONG" | "CLOSE_LONG" | "OPEN_SHORT" | "CLOSE_SHORT" | "HOLD",
  "confidence": 0.0-1.0,
  "reason": "one short sentence"
}

--------------------------------------------------
1. CORE DECISION PRINCIPLE
--------------------------------------------------

Do not trade simply because the market is moving.

Your job is to determine whether the available evidence supports a clear directional thesis.

Look for CONVERGENCE between multiple independent signals.

The supplied market analysis may contain:

- Price structure and recent price action
- SMA20
- SMA50
- Distance from SMA20
- Distance from SMA50
- Momentum
- RSI
- ATR
- Volatility
- Volume
- Average volume
- Volume ratio
- Best bid and ask
- Spread
- Bid and ask volume
- Order-book imbalance
- Mark price
- Index price
- Funding rate
- Current position performance
- Recent 5-minute candles

Use these as evidence rather than treating any single indicator as decisive.

For trend:

- Compare price with SMA20 and SMA50.
- Consider whether the moving averages support the same directional structure.
- Do not treat price being above or below one moving average as sufficient evidence by itself.

For momentum:

- Consider both the direction and strength of recent price movement.
- Use momentum together with broader price structure.

For RSI:

- Treat RSI as supporting momentum evidence.
- Do not use an RSI threshold as an automatic buy or sell trigger.

For volume:

- Consider whether meaningful volume supports the current price movement.
- A large move on weak relative volume should be treated differently from a move supported by elevated volume.

For order-book data:

- Treat order-book imbalance as short-term market-pressure evidence.
- Do not treat it as proof of future direction.
- Do not allow order-book data alone to justify opening a position.

For volatility and ATR:

- Use them to understand the size and character of recent movement.
- They are not directional signals by themselves.

For futures-specific data:

- Consider the relationship between mark price and index price.
- Treat funding rate as contextual positioning information.
- Do not use funding rate alone to justify a trade.

For recent candles:

- Use them to assess actual price structure.
- Look for continuation, pullback, breakout, rejection, or reversal.
- Do not overreact to one candle.

Do not require every indicator to agree.

Instead, ask:

"Is there enough independent evidence pointing in the same direction to justify taking or maintaining this position?"

If the evidence is mixed, weak, contradictory, or insufficient, HOLD is the correct decision.

--------------------------------------------------
2. WHEN FLAT
--------------------------------------------------

When there is no open position, you are deciding whether to take directional exposure.

OPEN_LONG when:

- The broader market structure is bullish, AND
- Multiple independent signals support continued upside, AND
- Recent price action does not materially contradict the bullish thesis, AND
- There is no major conflicting evidence that invalidates the setup.

OPEN_SHORT when:

- The broader market structure is bearish, AND
- Multiple independent signals support continued downside, AND
- Recent price action does not materially contradict the bearish thesis, AND
- There is no major conflicting evidence that invalidates the setup.

HOLD when:

- Directional evidence is unclear.
- Bullish and bearish signals meaningfully conflict.
- The available evidence is too weak to establish a directional thesis.
- The market is showing movement without sufficient confirmation.
- The apparent setup depends mainly on one indicator.

Do not open a position because of one isolated signal.

Do not assume that positive momentum automatically means OPEN_LONG.

Do not assume that negative momentum automatically means OPEN_SHORT.

Do not assume that positive funding automatically means OPEN_LONG or OPEN_SHORT.

Do not assume that negative funding automatically means OPEN_LONG or OPEN_SHORT.

Interpret each signal in the context of the other available evidence.

--------------------------------------------------
3. WHEN LONG
--------------------------------------------------

A LONG position already exists.

Do not treat the current cycle as a brand-new trade.

The question is:

"Has the original bullish thesis materially deteriorated or reversed?"

HOLD when:

- The broader bullish structure remains intact.
- Price remains supported by the broader trend.
- The market is experiencing an ordinary pullback.
- One indicator temporarily weakens.
- Short-term momentum turns negative without broader confirmation.
- Price temporarily moves against the position.
- Volume temporarily decreases without clear structural deterioration.
- Evidence is mixed but does not clearly invalidate the thesis.

CLOSE_LONG when:

- Multiple independent signals show that the bullish thesis has materially deteriorated, OR
- The market structure has clearly reversed bearish, OR
- Recent price action confirms a meaningful bearish reversal, OR
- Strong evidence indicates that continuing the LONG position is no longer justified.

Do not close a LONG merely because of normal market noise.

Do not close a LONG merely because:

- One candle is bearish.
- RSI weakens.
- Momentum temporarily turns negative.
- Price moves slightly below SMA20.
- Volume temporarily falls.
- The position experiences a small temporary drawdown.

Do not wait for every indicator to become bearish before closing.

The evidence should be strong enough to indicate genuine deterioration rather than ordinary uncertainty.

OPEN_SHORT is NOT valid while LONG.

If the bearish thesis becomes strong enough to justify leaving the LONG position, respond with CLOSE_LONG.

A new SHORT decision can be made on a later cycle after the position is flat.

--------------------------------------------------
4. WHEN SHORT
--------------------------------------------------

A SHORT position already exists.

Do not treat the current cycle as a brand-new trade.

The question is:

"Has the original bearish thesis materially deteriorated or reversed?"

HOLD when:

- The broader bearish structure remains intact.
- Price remains consistent with the broader downtrend.
- The market experiences an ordinary bounce.
- One indicator temporarily strengthens.
- Short-term momentum turns positive without broader confirmation.
- Price temporarily moves against the position.
- Volume temporarily decreases without clear structural deterioration.
- Evidence is mixed but does not clearly invalidate the thesis.

CLOSE_SHORT when:

- Multiple independent signals show that the bearish thesis has materially deteriorated, OR
- The market structure has clearly reversed bullish, OR
- Recent price action confirms a meaningful bullish reversal, OR
- Strong evidence indicates that continuing the SHORT position is no longer justified.

Do not close a SHORT merely because of normal market noise.

Do not close a SHORT merely because:

- One candle is bullish.
- RSI strengthens.
- Momentum temporarily turns positive.
- Price moves slightly above SMA20.
- Volume temporarily falls.
- The position experiences a small temporary drawdown.

Do not wait for every indicator to become bullish before closing.

The evidence should be strong enough to indicate genuine deterioration rather than ordinary uncertainty.

OPEN_LONG is NOT valid while SHORT.

If the bullish thesis becomes strong enough to justify leaving the SHORT position, respond with CLOSE_SHORT.

A new LONG decision can be made on a later cycle after the position is flat.

--------------------------------------------------
5. HOLD IS AN ACTIVE DECISION
--------------------------------------------------

HOLD does not mean you failed to make a decision.

Use HOLD when the evidence does not justify changing the current exposure.

When FLAT, HOLD means:

"There is not enough evidence to take directional risk."

When LONG, HOLD means:

"The bullish thesis remains sufficiently intact."

When SHORT, HOLD means:

"The bearish thesis remains sufficiently intact."

Do not manufacture trades simply to avoid HOLD.

The purpose of this system is to make justified decisions, not to maximize the number of trades.

--------------------------------------------------
6. CONFIDENCE
--------------------------------------------------

Confidence represents the strength and coherence of the evidence supporting your chosen action.

Use higher confidence when:

- Multiple independent signals agree.
- The broader market structure supports the decision.
- Recent price action confirms the thesis.
- There is little conflicting evidence.

Use lower confidence when:

- Evidence is incomplete.
- Signals conflict.
- The setup is developing but not fully confirmed.
- Important market fields are unavailable.

Do not use high confidence simply because one indicator is strong.

Confidence is not a prediction of how much the price will move.

Confidence represents how strongly the available evidence supports the chosen action.

--------------------------------------------------
7. POSITION MANAGEMENT
--------------------------------------------------

Do not invent a minimum holding period.

Do not force a trade to remain open simply because it was opened recently.

If the market genuinely reverses immediately after entry, closing the position can be correct.

Likewise, do not close a position simply because the market temporarily moves against it.

Compare the current evidence with the original directional thesis.

Ask:

"Has the thesis actually changed, or has the market simply fluctuated?"

For an existing position, preserving the position requires evidence that the original thesis remains sufficiently intact.

Closing the position requires evidence that the thesis has materially deteriorated or reversed.

--------------------------------------------------
8. DATA DISCIPLINE
--------------------------------------------------

Only use information explicitly provided to you.

Never invent:

- Missing indicators
- Prices
- Candles
- Volume
- Position data
- Liquidation prices
- Funding information
- Order-book information
- Market conditions

If a field is unavailable, treat it as unavailable.

Do not infer a value simply because it would normally exist.

Do not fill missing values with assumptions.

Base the decision on the evidence that is actually available.

If important evidence is unavailable and the remaining information does not establish a clear thesis, HOLD.

--------------------------------------------------
9. ACTION CONSISTENCY
--------------------------------------------------

The current position constrains valid actions.

When FLAT:

- Valid directional actions are OPEN_LONG, OPEN_SHORT, or HOLD.
- CLOSE_LONG and CLOSE_SHORT are invalid.

When LONG:

- Valid actions are CLOSE_LONG or HOLD.
- OPEN_SHORT is invalid.
- Do not reverse directly from LONG to SHORT.

When SHORT:

- Valid actions are CLOSE_SHORT or HOLD.
- OPEN_LONG is invalid.
- Do not reverse directly from SHORT to LONG.

If a directional reversal is justified while already positioned, close the existing position first.

A new directional position can be considered on a later cycle after the position is confirmed FLAT.

--------------------------------------------------
10. FINAL DECISION CHECK
--------------------------------------------------

Before returning the decision, silently check:

1. What is the current position?
2. What is the dominant market structure?
3. Is price above or below the major moving averages?
4. What does recent price momentum show?
5. Does RSI support or contradict the directional thesis?
6. Is the current move supported by meaningful volume?
7. What does recent candle structure show?
8. What does order-book pressure suggest?
9. What do mark price, index price, and funding rate suggest?
10. Which independent signals support the directional thesis?
11. Which signals contradict it?
12. If FLAT, is there enough evidence to justify opening exposure?
13. If already positioned, has the original thesis materially deteriorated?
14. Am I reacting to genuine evidence or ordinary market noise?
15. Is my confidence proportional to the strength of the evidence?
16. Am I choosing HOLD because the evidence genuinely supports staying flat or remaining in position, rather than because I failed to decide?

Then return ONLY the required JSON object.
`;

function buildUserPrompt(
  market: FuturesMarketState,
  position: FuturesPositionSnapshot,
): string {
  const na = (
    value: number | null,
    suffix = "",
  ): string =>
    value === null
      ? "unavailable"
      : `${value}${suffix}`;

  const lines = [
    `Symbol: ${market.symbol} (USDT-margined futures)`,

    "",
    "MARKET PRICE",
    `Last price: ${na(market.lastPrice)}`,
    `Previous candle close: ${na(market.previousPrice)}`,
    `Price change: ${na(market.priceChangePct, "%")}`,

    "",
    "TREND AND MOMENTUM",
    `SMA20: ${na(market.sma20)}`,
    `SMA50: ${na(market.sma50)}`,
    `Distance from SMA20: ${na(
      market.distanceFromSma20Pct,
      "%",
    )}`,
    `Distance from SMA50: ${na(
      market.distanceFromSma50Pct,
      "%",
    )}`,
    `Momentum (5 candles): ${na(
      market.momentum,
      "%",
    )}`,
    `RSI (14): ${na(market.rsi)}`,

    "",
    "VOLATILITY AND VOLUME",
    `Volatility: ${na(
      market.volatilityPct,
      "%",
    )}`,
    `ATR (14): ${na(market.atr)}`,
    `Latest volume: ${na(market.volume)}`,
    `Average volume: ${na(market.averageVolume)}`,
    `Volume ratio: ${na(
      market.volumeRatio,
      "x",
    )}`,

    "",
    "ORDER BOOK",
    `Best bid: ${na(market.bestBid)}`,
    `Best ask: ${na(market.bestAsk)}`,
    `Spread: ${na(market.spreadPct, "%")}`,
    `Bid volume: ${na(market.bidVolume)}`,
    `Ask volume: ${na(market.askVolume)}`,
    `Order-book imbalance: ${na(
      market.orderBookImbalance,
    )}`,

    "",
    "FUTURES-SPECIFIC DATA",
    `Mark price: ${na(market.markPrice)}`,
    `Index price: ${na(market.indexPrice)}`,
    `Funding rate: ${na(market.fundingRate)}`,

    "",
    "CURRENT POSITION",
    `Position: ${position.side}`,
  ];

  if (position.side !== "FLAT") {
    lines.push(
      `Entry price: ${na(position.entryPrice)}`,
      `Quantity: ${na(position.quantity, " BTC")}`,
      `Leverage: ${na(position.leverage, "x")}`,
      `Unrealized PnL: ${na(
        position.unrealizedPnl,
        " USDT",
      )}`,
      `Liquidation price: ${na(
        position.liquidationPrice,
      )}`,
      `Margin: ${na(position.margin, " USDT")}`,
    );
  }

  lines.push(
    "",
    "RECENT 5-MINUTE CANDLES",
  );

  if (market.recentCandles.length === 0) {
    lines.push("Unavailable");
  } else {
    for (const candle of market.recentCandles) {
      lines.push(
        `${new Date(candle.timestamp).toISOString()} | ` +
          `O ${candle.open} | ` +
          `H ${candle.high} | ` +
          `L ${candle.low} | ` +
          `C ${candle.close} | ` +
          `V ${candle.volume}`,
      );
    }
  }

  return lines.join("\n");
}

function parseModelOutput(
  text: string,
): {
  action: string;
  confidence: number;
  reason: string;
} {
  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(json)?/i, "")
      .replace(/```$/, "")
      .trim();
  }

  const data = JSON.parse(cleaned);

  if (!data || typeof data.action !== "string") {
    throw new Error(
      "response JSON is missing a string 'action' field",
    );
  }

  const action = data.action.toUpperCase();

  if (!FUTURES_ACTIONS.includes(action as any)) {
    throw new Error(
      `action '${data.action}' is not one of ${FUTURES_ACTIONS.join("/")}`,
    );
  }

  const confidence =
    typeof data.confidence === "number"
      ? data.confidence
      : 0.5;

  const reason =
    typeof data.reason === "string"
      ? data.reason
      : "";

  return {
    action,
    confidence,
    reason,
  };
}

function resolveProvider(): FuturesLLMProvider {
  const raw = (
    process.env.LLM_PROVIDER || "custom"
  )
    .trim()
    .toLowerCase();

  if (
    raw === "openai" ||
    raw === "groq" ||
    raw === "bedrock" ||
    raw === "custom"
  ) {
    return raw as FuturesLLMProvider;
  }

  throw new Error(
    `Unknown LLM_PROVIDER '${raw}'. Use one of: openai, groq, bedrock, custom.`,
  );
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  userPrompt: string,
): Promise<string> {
  const isReasoningModel = /gpt-oss/i.test(model);

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: FUTURES_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    temperature: 0.2,
    max_tokens: isReasoningModel ? 800 : 150,
    response_format: {
      type: "json_object",
    },
  };

  if (isReasoningModel) {
    body.reasoning_effort = "low";
  }

  const res = await fetch(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const bodyText = await res
      .text()
      .catch(() => "");

    throw new Error(
      `LLM endpoint returned HTTP ${res.status}: ${bodyText.slice(
        0,
        200,
      )}`,
    );
  }

  const json: any = await res.json();

  const content =
    json?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error(
      "LLM response missing choices[0].message.content",
    );
  }

  return content;
}

async function callBedrock(
  model: string,
  userPrompt: string,
): Promise<string> {
  const {
    BedrockRuntimeClient,
    ConverseCommand,
  } = await import(
    "@aws-sdk/client-bedrock-runtime"
  );

  const client = new BedrockRuntimeClient({
    region:
      process.env.AWS_REGION || "us-east-1",
  });

  const command = new ConverseCommand({
    modelId: model,
    system: [
      {
        text: FUTURES_SYSTEM_PROMPT,
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            text: userPrompt,
          },
        ],
      },
    ],
    inferenceConfig: {
      temperature: 0.2,
      maxTokens: 150,
    },
  });

  const response = await client.send(command);

  const content =
    response.output?.message?.content;

  const text =
    content &&
    content[0] &&
    "text" in content[0]
      ? content[0].text
      : undefined;

  if (typeof text !== "string") {
    throw new Error(
      "Bedrock response missing output.message.content[0].text",
    );
  }

  return text;
}

function resolveOpenAICompatibleConfig(
  provider: "openai" | "groq" | "custom",
): {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
} {
  if (provider === "openai") {
    return {
      baseUrl:
        process.env.LLM_BASE_URL ||
        "https://api.openai.com/v1",
      apiKey:
        process.env.LLM_API_KEY ||
        process.env.OPENAI_API_KEY,
      model:
        process.env.LLM_MODEL ||
        "gpt-4o-mini",
    };
  }

  if (provider === "groq") {
    return {
      baseUrl:
        process.env.LLM_BASE_URL ||
        "https://api.groq.com/openai/v1",
      apiKey:
        process.env.LLM_API_KEY ||
        process.env.GROQ_API_KEY,
      model:
        process.env.LLM_MODEL ||
        "llama-3.1-8b-instant",
    };
  }

  return {
    baseUrl: process.env.LLM_BASE_URL || "",
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL || "",
  };
}

export async function getFuturesLLMDecision(
  market: FuturesMarketState,
  position: FuturesPositionSnapshot,
): Promise<FuturesLLMDecisionResult> {
  const provider = resolveProvider();
  const userPrompt = buildUserPrompt(
    market,
    position,
  );

  const fail = (
    model: string,
    error: string,
  ): FuturesLLMDecisionResult => ({
    decision: {
      action: "HOLD",
      confidence: 0,
      reason: `LLM decision failed, defaulting to HOLD: ${error}`,
    },
    llmRaw: null,
    provider,
    model,
    error,
  });

  let rawText: string;
  let model = "";

  try {
    if (provider === "bedrock") {
      model = process.env.LLM_MODEL || "";

      if (!model) {
        return fail(
          model,
          "LLM_PROVIDER=bedrock requires LLM_MODEL (a Bedrock model ID)",
        );
      }

      rawText = await callBedrock(
        model,
        userPrompt,
      );
    } else {
      const cfg =
        resolveOpenAICompatibleConfig(provider);

      model = cfg.model;

      if (!cfg.apiKey) {
        const varName =
          provider === "openai"
            ? "LLM_API_KEY or OPENAI_API_KEY"
            : provider === "groq"
              ? "LLM_API_KEY or GROQ_API_KEY"
              : "LLM_API_KEY";

        return fail(
          model,
          `LLM_PROVIDER=${provider} but no API key found (set ${varName})`,
        );
      }

      if (
        provider === "custom" &&
        (!cfg.baseUrl || !cfg.model)
      ) {
        return fail(
          model,
          "LLM_PROVIDER=custom requires both LLM_BASE_URL and LLM_MODEL",
        );
      }

      rawText = await callOpenAICompatible(
        cfg.baseUrl,
        cfg.apiKey,
        cfg.model,
        userPrompt,
      );
    }
  } catch (err) {
    return fail(
      model,
      err instanceof Error
        ? err.message
        : String(err),
    );
  }

  try {
    const parsed = parseModelOutput(rawText);

    return {
      decision: {
        action:
          parsed.action as FuturesDecision["action"],
        confidence: parsed.confidence,
        reason:
          parsed.reason || "no reason given",
      },
      llmRaw: parsed,
      provider,
      model,
      error: null,
    };
  } catch (err) {
    return fail(
      model,
      err instanceof Error
        ? err.message
        : String(err),
    );
  }
}
