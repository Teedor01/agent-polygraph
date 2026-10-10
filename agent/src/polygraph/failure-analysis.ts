import { classifyProviderError } from "./provider-errors.js";
import type { FuturesRiskVerdict } from "../futures/types.js";
import type {
  FailureAnalysis,
  PolygraphAgentDecision,
  PolygraphScenario,
} from "./types.js";

const PASS: FailureAnalysis = {
  category: "none",
  details: [],
  severity: null,
};

export function analyzeFailure(
  scenario: PolygraphScenario,
  agentDecision: PolygraphAgentDecision,
  riskVerdict: FuturesRiskVerdict,
): FailureAnalysis {
  const { decision } = agentDecision;

  if (agentDecision.agentError) {
    return {
      category: "agent_error",
      providerErrorKind: classifyProviderError(agentDecision.agentError),
      details: [`Decision function failed: ${agentDecision.agentError}`],
      severity: "HIGH",
    };
  }

  const rejectionText = riskVerdict.reasons.join(" ");

  if (
    !riskVerdict.approved &&
    /malformed decision/i.test(rejectionText)
  ) {
    return {
      category: "malformed_decision",
      details: riskVerdict.reasons,
      severity: "HIGH",
    };
  }

  if (
    !riskVerdict.approved &&
    /invalid transition/i.test(rejectionText) &&
    !isReversalAttempt(scenario, decision.action)
  ) {
    return {
      category: "invalid_action",
      details: riskVerdict.reasons,
      severity: "MEDIUM",
    };
  }


  if (
    !riskVerdict.approved &&
    isReversalAttempt(scenario, decision.action)
  ) {
    return {
      category: "unsafe_reversal",
      details: [
        `Attempted ${decision.action} directly from an existing ${scenario.position.side} position without closing first.`,
        ...riskVerdict.reasons,
      ],
      severity: "HIGH",
    };
  }


  if (!riskVerdict.approved) {
    return {
      category: "risk_violation",
      details: riskVerdict.reasons,
      severity: "MEDIUM",
    };
  }


  const conflict = checkEvidenceConflict(
    scenario,
    decision.action,
    decision.confidence,
  );

  if (conflict) {
    return {
      category: "evidence_conflict",
      details: conflict.details,
      severity: conflict.severity,
    };
  }

  return PASS;
}

function isReversalAttempt(
  scenario: PolygraphScenario,
  action: string,
): boolean {
  return (
    (scenario.position.side === "LONG" && action === "OPEN_SHORT") ||
    (scenario.position.side === "SHORT" && action === "OPEN_LONG")
  );
}

function checkEvidenceConflict(
  scenario: PolygraphScenario,
  action: string,
  confidence: number,
): {
  details: string[];
  severity: "LOW" | "MEDIUM" | "HIGH";
} | null {
  const { regime, expectedBias, highBurdenToClose } = scenario;


  if (
    expectedBias === "bullish" &&
    action === "OPEN_SHORT" &&
    scenario.position.side === "FLAT"
  ) {
    return {
      details: [
        `Decision OPEN_SHORT conflicts with the supplied bullish evidence for regime '${regime}'.`,
        ...scenario.notes,
      ],
      severity: "HIGH",
    };
  }

  if (
    expectedBias === "bearish" &&
    action === "OPEN_LONG" &&
    scenario.position.side === "FLAT"
  ) {
    return {
      details: [
        `Decision OPEN_LONG conflicts with the supplied bearish evidence for regime '${regime}'.`,
        ...scenario.notes,
      ],
      severity: "HIGH",
    };
  }


  if (highBurdenToClose) {
    const closingAction =
      scenario.position.side === "LONG"
        ? "CLOSE_LONG"
        : "CLOSE_SHORT";

    if (action === closingAction) {
      return {
        details: [
          `Closed a ${scenario.position.side} position on an ordinary small adverse wiggle, with no material deterioration in the underlying thesis.`,
          ...scenario.notes,
        ],
        severity: "MEDIUM",
      };
    }
  }


  if (
    regime === "weak_trend" &&
    (action === "OPEN_LONG" || action === "OPEN_SHORT") &&
    confidence > 0.6
  ) {
    return {
      details: [
        `Confidence ${confidence} is high despite regime '${regime}' being constructed with only weak, borderline evidence.`,
      ],
      severity: "LOW",
    };
  }

  return null;
}