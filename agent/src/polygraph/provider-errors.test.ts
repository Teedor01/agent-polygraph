import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderError } from "./provider-errors.js";
import { analyzeFailure } from "./failure-analysis.js";
import { computeScorecard } from "./scorecard.js";
import { generateScenarios } from "./scenarios.js";
import { evaluateFuturesRisk } from "../futures/risk.js";
import type { ScenarioResult } from "./types.js";

// Messages below are copied from the real agent/llm-report.json (Groq run).
const NETWORK = "LLM network request failed: fetch failed | cause: AggregateError";
const TPD =
  'LLM endpoint returned HTTP 429 | retry-after: 287s: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` ... on tokens per day (TPD): Limit 200000, Used 197088","code":"rate_limit_exceeded"}}';

test("network failure is classified as network, not malformed or unknown", () => {
  assert.equal(classifyProviderError(NETWORK), "network");
});
test("Groq daily-token 429 is quota_exhausted", () => {
  assert.equal(classifyProviderError(TPD), "quota_exhausted");
});
test("a plain 429 is rate_limited", () => {
  assert.equal(classifyProviderError("LLM endpoint returned HTTP 429 | retry-after: 3s: slow down"), "rate_limited");
});
test("401/403 are auth, 5xx are provider_http_error", () => {
  assert.equal(classifyProviderError("LLM endpoint returned HTTP 401: bad key"), "auth");
  assert.equal(classifyProviderError("LLM endpoint returned HTTP 503: down"), "provider_http_error");
});
test("unparseable or out-of-contract responses are malformed_response", () => {
  assert.equal(classifyProviderError("LLM endpoint returned invalid JSON response: x"), "malformed_response");
  assert.equal(classifyProviderError("LLM response missing choices[0].message.content"), "malformed_response");
  assert.equal(classifyProviderError("action 'SHORT' is not one of OPEN_LONG/HOLD"), "malformed_response");
});
test("config problems and unrecognized text are not disguised", () => {
  assert.equal(classifyProviderError("LLM_PROVIDER=groq but no API key found (set LLM_API_KEY or GROQ_API_KEY)"), "config_error");
  assert.equal(classifyProviderError("something odd"), "unknown");
});

function errored(msg: string): ScenarioResult {
  const scenario = generateScenarios(1, 1)[0];
  const agentDecision = { decision: { action: "HOLD" as const, confidence: 0, reason: "x" }, agentError: msg };
  const riskVerdict = evaluateFuturesRisk(agentDecision.decision, scenario.market.lastPrice, scenario.position);
  const failure = analyzeFailure(scenario, agentDecision, riskVerdict);
  return { scenario, agentDecision, riskVerdict, passed: false, failure };
}

test("agent_error results carry a providerErrorKind and the scorecard breaks them down", () => {
  const r = [errored(NETWORK), errored(TPD), errored(TPD)];
  assert.equal(r[0].failure.category, "agent_error");
  assert.equal(r[0].failure.providerErrorKind, "network");
  const sc = computeScorecard(r, [], []);
  assert.deepEqual(sc.providerErrorsByKind, { network: 1, quota_exhausted: 2 });
  assert.equal(sc.validity, "invalid_provider_failures");
  assert.equal(sc.decisionReliabilityPct, null);
  assert.equal(sc.failed, 0); 
});
