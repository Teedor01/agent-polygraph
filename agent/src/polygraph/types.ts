import type { FuturesAction, FuturesDecision, FuturesPositionSnapshot, FuturesRiskVerdict, FuturesSide } from "../futures/types.js";
import type { FuturesMarketState } from "../futures/market.js";

export type MarketRegime =
  | "bull_trend"
  | "bear_trend"
  | "sideways"
  | "volatility_spike"
  | "sharp_price_drop"
  | "sharp_price_increase"
  | "momentum_reversal"
  | "volume_spike"
  | "volume_collapse"
  | "breakout"
  | "breakdown"
  | "overbought"
  | "oversold"
  | "conflicting_indicators"
  | "weak_trend"
  | "strong_trend"
  | "existing_long"
  | "existing_short"
  | "flat"
  | "data_missing_price"
  | "data_missing_position";

export const MARKET_REGIMES: readonly MarketRegime[] = [
  "bull_trend",
  "bear_trend",
  "sideways",
  "volatility_spike",
  "sharp_price_drop",
  "sharp_price_increase",
  "momentum_reversal",
  "volume_spike",
  "volume_collapse",
  "breakout",
  "breakdown",
  "overbought",
  "oversold",
  "conflicting_indicators",
  "weak_trend",
  "strong_trend",
  "existing_long",
  "existing_short",
  "flat",
  "data_missing_price",
  "data_missing_position",
];

export type ExpectedBias = "bullish" | "bearish" | "neutral";

export interface PolygraphScenario {
  id: string;
  regime: MarketRegime;
  description: string;
  market: FuturesMarketState;
  position: FuturesPositionSnapshot;
  expectedBias: ExpectedBias;
  highBurdenToClose: boolean;
  notes: string[];
}

export interface PolygraphAgentDecision {
  decision: FuturesDecision;
  provider?: string;
  model?: string;
  agentError?: string;
}

export interface PolygraphAgent {
  name: string;
  decide(scenario: PolygraphScenario): Promise<PolygraphAgentDecision>;
}

export type FailureCategory =
  | "none"
  | "agent_error"
  | "malformed_decision"
  | "invalid_action"
  | "unsafe_reversal"
  | "risk_violation"
  | "evidence_conflict"
  | "decision_inconsistency";


export type ProviderErrorKind =
  | "network"
  | "timeout"
  | "rate_limited"
  | "quota_exhausted"
  | "auth"
  | "provider_http_error"
  | "malformed_response"
  | "config_error"
  | "unknown";

export interface FailureAnalysis {
  category: FailureCategory;
  providerErrorKind?: ProviderErrorKind;
  details: string[];
  severity: "LOW" | "MEDIUM" | "HIGH" | null;
}

export interface ScenarioResult {
  scenario: PolygraphScenario;
  agentDecision: PolygraphAgentDecision;
  riskVerdict: FuturesRiskVerdict;
  passed: boolean;
  failure: FailureAnalysis;
}

export interface MutationRecord {
  originalScenarioId: string;
  mutatedScenarioId: string;
  changedFields: string[];
  magnitude: number;
  originalDecision: FuturesDecision;
  mutatedDecision: FuturesDecision;
  confidenceDifference: number;
  decisionChanged: boolean;
  explainable: boolean;
  failureCategory: FailureCategory; 
}

export interface RegimeResult {
  regime: MarketRegime;
  scenarios: number;
  passed: number;
  failed: number;
}

export type RunValidity = "valid" | "invalid_provider_failures";

export interface Scorecard {
  scenarios: number;

  answeredScenarios: number;
  passed: number;
  failed: number;
  riskViolations: number;
  consistencyFailures: number;
  invalidActions: number;
  unsafeReversals: number;
  malformedDecisions: number;
  agentErrors: number;
  agentErrorRatePct: number;
  providerErrorsByKind: Partial<Record<ProviderErrorKind, number>>;
  mutationChecks: number;
  validity: RunValidity;
  decisionReliabilityPct: number | null;
  riskCompliancePct: number | null;
  decisionConsistencyPct: number | null; 
  positionManagementPct: number | null;
  invalidDecisionRatePct: number | null;
  unsafeActionRatePct: number | null;
  scenarioCoveragePct: number; 
}

export type RunKind = "deterministic" | "adversarial" | "llm";

export interface RunMeta {
  kind: RunKind;
  market: "futures";
  provider: string | null;
  model: string | null;
  countPerRegime: number;
  mutationSampleSize: number;
}

export interface PolygraphReport {
  run?: RunMeta;
  runId: string;
  seed: number;
  agent: string;
  generatedAt: string;
  scorecard: Scorecard;
  regimeResults: RegimeResult[];
  mutationResults: MutationRecord[];
  failures: ScenarioResult[];
  replaySample: ScenarioResult[]; 
}