/**
 * LLM-based trading decision for the real Bitget Demo agent.
 *
 * Supports any of: OpenAI, Groq, Amazon Bedrock, or a "custom" OpenAI-
 * compatible endpoint (the original Bitget-Qwen-endpoint path from the
 * first version of this module still works unchanged as "custom").
 *
 * Isolated from backend/agents.py's LLM adapters on purpose - those are
 * Python, this project's Bitget-facing agent is Node/TS, so there is no
 * clean way to share code across the runtime boundary.
 *
 * Whichever provider is used, the raw text response goes through the
 * SAME strict parseModelOutput() validator below - provider choice only
 * changes how the text gets fetched, never how it's interpreted or
 * enforced. What this module does NOT do, by design, regardless of
 * provider:
 *   - choose order size (always the existing fixed ENTRY_NOTIONAL_USDT
 *     for a buy, or the exact held qty for a sell)
 *   - talk to Bitget directly in any way
 *   - get treated as authoritative - its output is just another
 *     Decision, subject to the exact same risk engine (risk.ts) as the
 *     deterministic strategy, unchanged
 *
 * A failed call, a failed provider, or a response that doesn't parse
 * into the required shape never becomes a guessed trade - it becomes an
 * explicit HOLD with the failure reason recorded, both in the console
 * and the log.
 */

import type { PositionState } from "./position.js";
import type { Decision } from "./risk.js";

export type LLMProvider = "openai" | "groq" | "bedrock" | "custom";

export interface LLMDecisionResult {
  decision: Decision;
  llmRaw: { action: string; confidence: number; reason: string } | null;
  provider: LLMProvider;
  model: string;
  error: string | null;
}

const SYSTEM_PROMPT =
  'You are a trading decision function for a single small BTCUSDT spot position on Bitget Demo Trading (simulated funds, not real capital). ' +
  "You do not choose position size - only the action. Respond with ONLY a JSON object, no other text, no markdown fences:\n" +
  '{"action": "BUY" | "SELL" | "HOLD", "confidence": <number 0.0-1.0>, "reason": "<one short sentence>"}\n' +
  "Rules:\n" +
  "- If told the position is FLAT, a SELL will be rejected downstream (nothing to sell) - BUY or HOLD are the meaningful choices.\n" +
  "- If told the position is IN POSITION, a BUY will be rejected downstream (one position at a time) - SELL or HOLD are the meaningful choices.\n" +
  "- You never specify quantity or notional - that is fixed by a separate risk system regardless of what you say.";

function buildUserPrompt(symbol: string, lastPrice: number, position: PositionState): string {
  if (!position.inPosition) {
    return `Symbol: ${symbol}\nCurrent price: ${lastPrice}\nPosition: FLAT (no open position)`;
  }
  const entry = position.entryPrice ?? lastPrice;
  const changePct = ((lastPrice - entry) / entry) * 100;
  return (
    `Symbol: ${symbol}\nCurrent price: ${lastPrice}\nPosition: IN POSITION\n` +
    `Entry price: ${position.entryPrice}\nQuantity held: ${position.entryQtyBase}\n` +
    `Change since entry: ${changePct.toFixed(2)}%`
  );
}

/** Provider-agnostic: every provider's raw text answer is validated the
 * same way, so structured-output enforcement never depends on which
 * provider happens to be configured. */
function parseModelOutput(text: string): { action: string; confidence: number; reason: string } {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  }
  const data = JSON.parse(cleaned);
  if (!data || typeof data.action !== "string") {
    throw new Error("response JSON is missing a string 'action' field");
  }
  const action = data.action.toUpperCase();
  if (action !== "BUY" && action !== "SELL" && action !== "HOLD") {
    throw new Error(`action '${data.action}' is not one of BUY/SELL/HOLD`);
  }
  const confidence = typeof data.confidence === "number" ? data.confidence : 0.5;
  const reason = typeof data.reason === "string" ? data.reason : "";
  return { action, confidence, reason };
}

interface ProviderConfig {
  provider: LLMProvider;
  model: string;
}

function resolveProvider(): LLMProvider {
  const raw = (process.env.LLM_PROVIDER || "custom").trim().toLowerCase();
  if (raw === "openai" || raw === "groq" || raw === "bedrock" || raw === "custom") return raw as LLMProvider;
  throw new Error(`Unknown LLM_PROVIDER '${raw}'. Use one of: openai, groq, bedrock, custom.`);
}

/** Every provider below is OpenAI-compatible chat-completions except
 * Bedrock, which is handled separately in callBedrock(). */
async function callOpenAICompatible(baseUrl: string, apiKey: string, model: string, userPrompt: string): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 150,
      // Best-effort structured-output enforcement. Servers that don't
      // recognize this field are expected to ignore it per normal JSON
      // API convention; parseModelOutput() above is the real
      // enforcement either way.
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`LLM endpoint returned HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  const json: any = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LLM response missing choices[0].message.content");
  }
  return content;
}

/** Amazon Bedrock uses the Converse API (unified across model families -
 * Anthropic, Meta, etc.) rather than an OpenAI-compatible endpoint, and
 * SigV4-signs requests via AWS credentials instead of a bearer token -
 * genuinely different auth and request shape, hence the official AWS
 * SDK rather than a hand-rolled HTTP call. Dynamically imported so the
 * dependency is only loaded when Bedrock is actually selected. */
async function callBedrock(model: string, userPrompt: string): Promise<string> {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
  const command = new ConverseCommand({
    modelId: model,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ text: userPrompt }] }],
    inferenceConfig: { temperature: 0.2, maxTokens: 150 },
  });
  const response = await client.send(command);
  const content = response.output?.message?.content;
  const text = content && content[0] && "text" in content[0] ? content[0].text : undefined;
  if (typeof text !== "string") {
    throw new Error("Bedrock response missing output.message.content[0].text");
  }
  return text;
}

function resolveOpenAICompatibleConfig(provider: "openai" | "groq" | "custom"): { baseUrl: string; apiKey: string | undefined; model: string } {
  if (provider === "openai") {
    return {
      baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
      model: process.env.LLM_MODEL || "gpt-4o-mini",
    };
  }
  if (provider === "groq") {
    return {
      baseUrl: process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1",
      apiKey: process.env.LLM_API_KEY || process.env.GROQ_API_KEY,
      model: process.env.LLM_MODEL || "openai/gpt-oss-120b",
    };
  }
  // custom: e.g. Bitget's hackathon Qwen endpoint, or any other
  // OpenAI-compatible server - both LLM_BASE_URL and LLM_MODEL are
  // required since there's no universal sensible default here.
  return {
    baseUrl: process.env.LLM_BASE_URL || "",
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL || "",
  };
}

export async function getLLMDecision(
  symbol: string,
  lastPrice: number,
  position: PositionState,
  entryNotionalUsdt: number,
): Promise<LLMDecisionResult> {
  const provider = resolveProvider();
  const userPrompt = buildUserPrompt(symbol, lastPrice, position);

  const fail = (model: string, error: string): LLMDecisionResult => ({
    decision: { action: "hold", qty: 0, rationale: `LLM decision failed, defaulting to hold: ${error}` },
    llmRaw: null,
    provider,
    model,
    error,
  });

  let rawText: string;
  let model: string;

  try {
    if (provider === "bedrock") {
      model = process.env.LLM_MODEL || "";
      if (!model) return fail(model, "LLM_PROVIDER=bedrock requires LLM_MODEL (a Bedrock model ID)");
      rawText = await callBedrock(model, userPrompt);
    } else {
      const cfg = resolveOpenAICompatibleConfig(provider);
      model = cfg.model;
      if (!cfg.apiKey) {
        const varName = provider === "openai" ? "LLM_API_KEY or OPENAI_API_KEY" : provider === "groq" ? "LLM_API_KEY or GROQ_API_KEY" : "LLM_API_KEY";
        return fail(model, `LLM_PROVIDER=${provider} but no API key found (set ${varName})`);
      }
      if (provider === "custom" && (!cfg.baseUrl || !cfg.model)) {
        return fail(model, "LLM_PROVIDER=custom requires both LLM_BASE_URL and LLM_MODEL");
      }
      rawText = await callOpenAICompatible(cfg.baseUrl, cfg.apiKey, cfg.model, userPrompt);
    }
  } catch (err) {
    return fail(model! ?? "", err instanceof Error ? err.message : String(err));
  }

  try {
    const parsed = parseModelOutput(rawText);
    const actionLower = parsed.action.toLowerCase() as "buy" | "sell" | "hold";

    // Size is never taken from the model - same fixed constants the
    // deterministic strategy uses for the same actions, regardless of
    // which provider answered.
    let qty = 0;
    if (actionLower === "buy") qty = entryNotionalUsdt;
    else if (actionLower === "sell") qty = position.entryQtyBase ?? 0;

    return {
      decision: {
        action: actionLower,
        qty,
        rationale: `LLM (${provider}/${model}): ${parsed.reason || "no reason given"} [confidence ${parsed.confidence}]`,
      },
      llmRaw: parsed,
      provider,
      model,
      error: null,
    };
  } catch (err) {
    return fail(model, err instanceof Error ? err.message : String(err));
  }
}
