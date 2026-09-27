import type { PositionState } from "./position.js";
import type { Decision } from "./risk.js";

export type LLMProvider = "openai" | "groq" | "bedrock" | "custom";

export interface MarketSnapshot {
  previousPrice?: number | null;
  priceChangePct?: number | null;
  momentum?: number | null;
  volatilityPct?: number | null;
  atr?: number | null;
  rsi?: number | null;
  sma20?: number | null;
  sma50?: number | null;
  distanceFromSma20Pct?: number | null;
  distanceFromSma50Pct?: number | null;
  recentCandles?: {
    timestamp?: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  volume?: number | null;
  averageVolume?: number | null;
  volumeRatio?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  spreadPct?: number | null;
  bidVolume?: number | null;
  askVolume?: number | null;
  orderBookImbalance?: number | null;
}

export interface LLMDecisionResult {
  decision: Decision;
  llmRaw: {
    action: string;
    confidence: number;
    reason: string;
  } | null;
  provider: LLMProvider;
  model: string;
  error: string | null;
}

const TAKE_PROFIT_REFERENCE_PCT = 1.5;
const STOP_LOSS_REFERENCE_PCT = -1.0;


const SYSTEM_PROMPT = `
You are an autonomous BTCUSDT spot trading decision engine operating on Bitget Demo Trading.

Your task is to analyze the supplied market data and make ONE trading decision.

You do not choose position size. The risk system controls position size.

Your available actions are BUY, SELL, and HOLD.

POSITION-AWARE DECISION RULES:

If the position is FLAT:
- BUY means open a new BTCUSDT position.
- HOLD means remain flat and wait.
- SELL is INVALID.
- Evaluate whether the available evidence justifies opening a position.
- Do not BUY simply because the position is flat.
- Do not force a trade when the evidence is weak, mixed, or conflicting.
- Prefer HOLD when there is not enough evidence for a high-quality entry.
- A strong entry should have multiple pieces of evidence supporting the same directional thesis.

If the position is IN POSITION:
- HOLD means continue holding the existing position.
- SELL means close the existing position.
- BUY is INVALID.
- Evaluate whether the original trade thesis remains valid.
- Do not treat every decision cycle as a completely new trade.
- The position was opened because a previous decision identified sufficient evidence for entry.
- Before choosing SELL, determine whether the market has materially changed enough to invalidate that thesis.
- The burden of evidence for SELL should be higher than the evidence required to continue holding.
- Do not SELL merely because one indicator has weakened.
- Do not SELL merely because short-term momentum has turned negative.
- Do not SELL merely because price has pulled back from the entry price.
- Do not SELL merely because the position is temporarily losing money.
- If the broader bullish structure remains intact and the evidence is mixed, prefer HOLD.
- SELL when multiple independent signals indicate that the original bullish thesis has materially deteriorated, reversed, or that downside risk is clearly stronger than the case for continuing to hold.
- A temporary pullback inside an otherwise intact bullish structure should generally result in HOLD rather than SELL.
- HOLD is an active position-management decision, not indecision.

MARKET ANALYSIS:

Use the complete available market context.

1. PRICE ACTION

Consider:
- Current price
- Previous price
- Recent candle structure
- Higher highs / lower highs
- Higher lows / lower lows
- Direction and strength of recent closes
- Rejections, reversals, or continuation patterns
- Whether the current price movement represents continuation, consolidation, or a meaningful reversal

For an existing position, pay particular attention to whether price structure has actually broken down rather than simply experiencing a normal pullback.

2. MOMENTUM

Consider:
- Short-term price momentum
- Whether momentum is strengthening
- Whether momentum is weakening
- Whether momentum is reversing
- Whether negative momentum is persistent or only temporary

Negative momentum by itself is not sufficient reason to SELL an existing position.

3. TREND

Consider:
- SMA20
- SMA50
- Current price relative to SMA20 and SMA50
- Distance from the moving averages
- Alignment between price and moving averages
- Whether the market appears bullish, bearish, sideways, or unclear
- Whether the trend has strengthened, weakened, or materially reversed

For an existing position, distinguish between a weakening trend and a broken trend.

4. VOLATILITY

Consider:
- Recent volatility
- ATR
- Whether volatility is expanding or contracting
- Whether current volatility increases or decreases the quality of the setup
- Whether a sudden volatility increase is supported by a meaningful directional move

High volatility alone is not a reason to SELL.

5. RSI

Consider:
- Current RSI
- Whether RSI indicates bullish, bearish, neutral, overbought, or oversold conditions
- Whether RSI is strengthening or weakening
- RSI must NOT be used in isolation
- Do not automatically BUY because RSI is low
- Do not automatically SELL because RSI is high
- Do not automatically SELL because RSI has weakened if the broader trade thesis remains intact

6. VOLUME

Consider:
- Current volume
- Average volume
- Volume ratio
- Whether volume confirms or contradicts the price movement
- Whether selling volume confirms a bearish reversal
- Whether low volume makes the apparent directional move less convincing

Low volume should reduce conviction when directional evidence is otherwise weak.

7. ORDER BOOK

Consider:
- Best bid
- Best ask
- Spread
- Bid volume
- Ask volume
- Order-book imbalance
- Whether buying or selling pressure is supported by available liquidity
- Whether the order book provides meaningful confirmation of the broader market signal

Do not make a decision from order-book imbalance alone.

8. POSITION PERFORMANCE

When IN POSITION, consider:
- Entry price
- Current price
- Percentage change since entry
- Time since entry
- Take-profit reference
- Stop-loss reference
- Whether current market conditions support holding or exiting
- Whether the original entry thesis remains substantially intact
- Whether the current price movement is normal noise or a meaningful deterioration

POSITION THESIS:

When IN POSITION, compare the current market evidence with the evidence that would justify remaining in the trade.

Think in terms of thesis preservation:

- If the broader bullish thesis remains intact, HOLD.
- If evidence is mixed, HOLD.
- If one or two indicators weaken but price structure and broader trend remain supportive, HOLD.
- If momentum weakens temporarily but there is no confirmed structural breakdown, HOLD.
- If several independent signals confirm that the bullish thesis has materially deteriorated or reversed, consider SELL.
- If price structure breaks down and this is confirmed by trend, momentum, volume, or other independent evidence, SELL may be justified.
- Do not manufacture a SELL simply because the market is no longer moving upward at the same rate as when the position was opened.

The purpose of an exit is to respond to meaningful deterioration in the trade thesis, not to react to every small fluctuation.

RISK REFERENCES:

Take-profit reference: +1.5%
Stop-loss reference: -1.0%

These are NOT automatic trading triggers.

Do not automatically SELL merely because the take-profit reference has been reached.

Do not automatically SELL merely because the stop-loss reference has been reached.

However, these references are important risk information and must be considered together with the current market evidence.

A position near the stop-loss reference should receive careful scrutiny, but the decision must still be based on the available market evidence.

A position near or above the take-profit reference should not automatically be closed if the bullish thesis remains strong.

DECISION QUALITY:

Use multiple independent pieces of evidence.

Do not make a decision based on a single indicator.

Look for agreement between:
- Price action
- Momentum
- Trend
- Volume
- Volatility
- RSI
- Order-book conditions
- Position performance when IN POSITION

When several independent signals agree, confidence can increase.

When signals conflict, confidence should decrease.

When the evidence is insufficient, choose HOLD.

When IN POSITION, HOLD should be preferred when the existing trade thesis remains substantially intact.

When IN POSITION, require stronger and more consistent evidence for SELL than would be required to simply recognize that the market has weakened.

Do not confuse:
- weakening with reversal
- volatility with deterioration
- a pullback with a trend break
- negative momentum with a failed trade thesis
- temporary loss with invalidation

Do not invent values that are missing.

If a value is N/A, unavailable, or null, ignore that specific signal and rely on the remaining available evidence.

Do not assume a missing signal is bullish or bearish.

CONFIDENCE:

Return a number from 0 to 1.

0.90-1.00 = very strong agreement between available signals
0.75-0.89 = strong evidence
0.60-0.74 = moderate evidence
below 0.60 = weak or conflicting evidence

Confidence represents the strength of the current evidence, NOT certainty about future price movement.

Confidence should decrease when important signals conflict.

A high confidence value requires meaningful agreement among multiple available signals.

REASON:

The reason must be one short sentence explaining the strongest evidence behind the selected action.

For HOLD while IN POSITION, explain why the existing trade thesis remains intact or why the evidence is insufficient to justify an exit.

For SELL while IN POSITION, explain the strongest evidence that the original trade thesis has materially deteriorated or reversed.

For BUY while FLAT, explain the strongest evidence supporting a new position.

Do not mention information that was not supplied.

OUTPUT:

Return ONLY one valid JSON object.

Do not use markdown.
Do not use code fences.
Do not include commentary.
Do not include additional fields.

Required format:

{"action":"BUY","confidence":0.78,"reason":"Price is above both moving averages with positive momentum and volume confirmation."}

The action must be exactly one of:
BUY
SELL
HOLD

The confidence must be a number between 0 and 1.

The reason must be a short sentence.

Never specify quantity or notional.

The risk system controls position size.

FINAL DECISION CHECK:

Before returning the decision, silently ask:

1. Am I FLAT or IN POSITION?
2. If FLAT, is there enough independent evidence to justify opening a position?
3. If IN POSITION, has the original bullish thesis actually deteriorated enough to justify closing?
4. Am I reacting to one weak signal or multiple independent signals?
5. Is this a genuine trend or structure change, or merely normal market noise?
6. If the evidence is mixed, should the decision be HOLD?
7. Does my reason accurately describe only the supplied data?

Then return only the JSON decision.
`;


function formatNumber(
  value: number | null | undefined,
  digits = 4,
): string {
  return value === null ||
    value === undefined ||
    !Number.isFinite(value)
    ? "N/A"
    : value.toFixed(digits);
}

function formatOptionalPercent(
  value: number | null | undefined,
  digits = 4,
): string {
  return value === null ||
    value === undefined ||
    !Number.isFinite(value)
    ? "N/A"
    : `${value.toFixed(digits)}%`;
}

function formatCandles(
  candles: MarketSnapshot["recentCandles"],
): string {
  if (!candles || candles.length === 0) {
    return "N/A";
  }

  return candles
    .map(
      (candle, index) =>
        `Candle ${index + 1}: ` +
        `O=${candle.open}, ` +
        `H=${candle.high}, ` +
        `L=${candle.low}, ` +
        `C=${candle.close}, ` +
        `V=${candle.volume}`,
    )
    .join("\n");
}

function buildUserPrompt(
  symbol: string,
  lastPrice: number,
  position: PositionState,
  entryNotionalUsdt: number,
  market: MarketSnapshot = {},
): string {
  const lines: string[] = [
    "TRADING DECISION REQUEST",
    "",
    `Symbol: ${symbol}`,
    `Current price: ${lastPrice}`,
    `Previous price: ${formatNumber(market.previousPrice)}`,
    `Price change: ${formatOptionalPercent(
      market.priceChangePct,
    )}`,
    "",
    "MARKET CONTEXT",
    "",
    `Momentum: ${formatOptionalPercent(
      market.momentum,
    )}`,
    `Volatility: ${formatOptionalPercent(
      market.volatilityPct,
    )}`,
    `ATR: ${formatNumber(market.atr)}`,
    `RSI: ${formatNumber(market.rsi, 2)}`,
    `SMA 20: ${formatNumber(market.sma20)}`,
    `SMA 50: ${formatNumber(market.sma50)}`,
    `Distance from SMA 20: ${formatOptionalPercent(
      market.distanceFromSma20Pct,
    )}`,
    `Distance from SMA 50: ${formatOptionalPercent(
      market.distanceFromSma50Pct,
    )}`,
    "",
    "RECENT CANDLES",
    formatCandles(market.recentCandles),
    "",
    "VOLUME",
    `Current volume: ${formatNumber(market.volume)}`,
    `Average volume: ${formatNumber(
      market.averageVolume,
    )}`,
    `Volume ratio: ${formatNumber(
      market.volumeRatio,
      2,
    )}`,
    "",
    "ORDER BOOK",
    `Best bid: ${formatNumber(market.bestBid)}`,
    `Best ask: ${formatNumber(market.bestAsk)}`,
    `Spread: ${formatOptionalPercent(
      market.spreadPct,
    )}`,
    `Bid volume: ${formatNumber(market.bidVolume)}`,
    `Ask volume: ${formatNumber(market.askVolume)}`,
    `Order-book imbalance: ${formatNumber(
      market.orderBookImbalance,
      4,
    )}`,
    "",
  ];

  if (!position.inPosition) {
    lines.push(
      "POSITION STATE",
      "",
      "Position: FLAT",
      "There is currently no open position.",
      "Valid actions: BUY or HOLD.",
      "SELL is invalid.",
      "",
      "RISK REFERENCES",
      `Take-profit reference: +${TAKE_PROFIT_REFERENCE_PCT.toFixed(
        2,
      )}%`,
      `Stop-loss reference: ${STOP_LOSS_REFERENCE_PCT.toFixed(
        2,
      )}%`,
      "",
      "ENTRY CONTEXT",
      `Potential entry notional: ${entryNotionalUsdt} USDT`,
      "",
      "Evaluate whether the current market evidence justifies opening a position.",
    );

    return lines.join("\n");
  }

  const entry = position.entryPrice ?? lastPrice;
  const changePct =
    entry !== 0
      ? ((lastPrice - entry) / entry) * 100
      : 0;

  lines.push(
    "POSITION STATE",
    "",
    "Position: IN POSITION",
    "There is currently an open position.",
    "Valid actions: HOLD or SELL.",
    "BUY is invalid.",
    "",
    `Entry price: ${formatNumber(
      position.entryPrice,
    )}`,
    `Quantity held: ${formatNumber(
      position.entryQtyBase,
    )}`,
    `Change since entry: ${changePct.toFixed(2)}%`,
    "",
    "RISK REFERENCES",
    `Take-profit reference: +${TAKE_PROFIT_REFERENCE_PCT.toFixed(
      2,
    )}%`,
    `Stop-loss reference: ${STOP_LOSS_REFERENCE_PCT.toFixed(
      2,
    )}%`,
    "",
    "Evaluate whether current market evidence supports continuing to hold or closing the position.",
  );

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

  if (!cleaned) {
    throw new Error("LLM returned empty content");
  }

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
  }

  if (!cleaned) {
    throw new Error(
      "LLM returned empty content after code-fence cleanup",
    );
  }

  let data: any;

  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `LLM returned invalid JSON: ${cleaned.slice(
        0,
        500,
      )}`,
    );
  }

  if (
    !data ||
    typeof data !== "object"
  ) {
    throw new Error(
      "response is not a JSON object",
    );
  }

  if (
    typeof data.action !== "string"
  ) {
    throw new Error(
      "response JSON is missing a string 'action' field",
    );
  }

  const action =
    data.action.toUpperCase();

  if (
    action !== "BUY" &&
    action !== "SELL" &&
    action !== "HOLD"
  ) {
    throw new Error(
      `action '${data.action}' is not one of BUY/SELL/HOLD`,
    );
  }

  const confidence =
    typeof data.confidence === "number"
      ? data.confidence
      : 0.5;

  if (
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error(
      "confidence must be a number between 0 and 1",
    );
  }

  const reason =
    typeof data.reason === "string"
      ? data.reason.trim()
      : "";

  return {
    action,
    confidence,
    reason,
  };
}

function resolveProvider(): LLMProvider {
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
    return raw as LLMProvider;
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
  provider: "openai" | "groq" | "custom",
): Promise<string> {
  const requestBody: Record<
    string,
    unknown
  > = {
    model,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    temperature: 0.2,
    max_completion_tokens: 512,
  };

  if (
    provider === "groq" &&
    model === "openai/gpt-oss-120b"
  ) {
    requestBody.reasoning_effort = "low";
    requestBody.include_reasoning = false;
    requestBody.response_format = {
      type: "json_object",
    };
  }

  const res = await fetch(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!res.ok) {
    const bodyText =
      await res.text().catch(
        () => "",
      );

    throw new Error(
      `LLM endpoint returned HTTP ${res.status}: ${bodyText.slice(
        0,
        500,
      )}`,
    );
  }

  const json: any =
    await res.json();

  const choice =
    json?.choices?.[0];

  if (!choice) {
    throw new Error(
      "LLM response missing choices[0]",
    );
  }

  const message =
    choice.message;

  if (!message) {
    throw new Error(
      "LLM response missing choices[0].message",
    );
  }

  const content =
    message.content;

  if (
    typeof content !== "string" ||
    content.trim() === ""
  ) {
    const finishReason =
      choice.finish_reason ??
      "unknown";

    throw new Error(
      `LLM response contained no message content (finish_reason=${finishReason})`,
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

  const client =
    new BedrockRuntimeClient({
      region:
        process.env.AWS_REGION ||
        "us-east-1",
    });

  const command =
    new ConverseCommand({
      modelId: model,
      system: [
        {
          text: SYSTEM_PROMPT,
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
        maxTokens: 512,
      },
    });

  const response =
    await client.send(command);

  const content =
    response.output?.message
      ?.content;

  const text =
    content &&
    content[0] &&
    "text" in content[0]
      ? content[0].text
      : undefined;

  if (
    typeof text !== "string"
  ) {
    throw new Error(
      "Bedrock response missing output.message.content[0].text",
    );
  }

  return text;
}

function resolveOpenAICompatibleConfig(
  provider:
    | "openai"
    | "groq"
    | "custom",
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
        "openai/gpt-oss-120b",
    };
  }

  return {
    baseUrl:
      process.env.LLM_BASE_URL ||
      "",
    apiKey:
      process.env.LLM_API_KEY,
    model:
      process.env.LLM_MODEL ||
      "",
  };
}

export async function getLLMDecision(
  symbol: string,
  lastPrice: number,
  position: PositionState,
  entryNotionalUsdt: number,
  market: MarketSnapshot = {},
): Promise<LLMDecisionResult> {
  const provider =
    resolveProvider();

  const userPrompt =
    buildUserPrompt(
      symbol,
      lastPrice,
      position,
      entryNotionalUsdt,
      market,
    );

  const fail = (
    model: string,
    error: string,
  ): LLMDecisionResult => ({
    decision: {
      action: "hold",
      qty: 0,
      rationale:
        `LLM decision failed, defaulting to hold: ${error}`,
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
      model =
        process.env.LLM_MODEL ||
        "";

      if (!model) {
        return fail(
          model,
          "LLM_PROVIDER=bedrock requires LLM_MODEL (a Bedrock model ID)",
        );
      }

      rawText =
        await callBedrock(
          model,
          userPrompt,
        );
    } else {
      const cfg =
        resolveOpenAICompatibleConfig(
          provider,
        );

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
        (!cfg.baseUrl ||
          !cfg.model)
      ) {
        return fail(
          model,
          "LLM_PROVIDER=custom requires both LLM_BASE_URL and LLM_MODEL",
        );
      }

      rawText =
        await callOpenAICompatible(
          cfg.baseUrl,
          cfg.apiKey,
          cfg.model,
          userPrompt,
          provider,
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
    const parsed =
      parseModelOutput(
        rawText,
      );

    const actionLower =
      parsed.action.toLowerCase() as
        | "buy"
        | "sell"
        | "hold";

    let qty = 0;

    if (
      actionLower === "buy"
    ) {
      qty = entryNotionalUsdt;
    } else if (
      actionLower === "sell"
    ) {
      qty =
        position.entryQtyBase ??
        0;
    }

    return {
      decision: {
        action: actionLower,
        qty,
        rationale:
          `LLM (${provider}/${model}): ` +
          `${parsed.reason || "no reason given"} ` +
          `[confidence ${parsed.confidence}]`,
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

