import { getFuturesLLMDecision } from "../futures/llm_decision.js";
import type { FuturesAction, FuturesDecision } from "../futures/types.js";
import type {
  PolygraphAgent,
  PolygraphAgentDecision,
  PolygraphScenario,
} from "./types.js";

export class LLMFuturesAgent implements PolygraphAgent {
  name = "Futures LLM Agent";

  private lastCallAt = 0;

  async decide(scenario: PolygraphScenario): Promise<PolygraphAgentDecision> {
    const delayMs = Number(
      process.env.POLYGRAPH_LLM_DELAY_MS || 30000,
    );

    if (this.lastCallAt > 0 && delayMs > 0) {
      const elapsed = Date.now() - this.lastCallAt;
      const remaining = delayMs - elapsed;

      if (remaining > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, remaining);
        });
      }
    }

    this.lastCallAt = Date.now();

    const result = await getFuturesLLMDecision(
      scenario.market,
      scenario.position,
    );

    return {
      decision: result.decision,
      agentError: result.error ?? undefined,
      provider: result.provider,
      model: result.model || undefined,
    };
  }
}


export class RuleBasedFuturesAgent implements PolygraphAgent {
  name = "Rule-Based Futures Agent (deterministic, offline)";

  async decide(scenario: PolygraphScenario): Promise<PolygraphAgentDecision> {
    const { market, position } = scenario;
    let bullSignals = 0;
    let bearSignals = 0;
    let total = 0;

    const vote = (value: number | null, threshold: number) => {
      if (value === null) return;
      total++;
      if (value > threshold) bullSignals++;
      else if (value < -threshold) bearSignals++;
    };

    vote(market.momentum, 0.8);
    vote(market.priceChangePct, 0.5);
    vote(market.distanceFromSma20Pct, 0.4);
    vote(market.distanceFromSma50Pct, 0.4);
    vote(market.orderBookImbalance, 0.08);
    if (market.rsi !== null) {
      total++;
      if (market.rsi > 55) bullSignals++;
      else if (market.rsi < 45) bearSignals++;
    }

    const convergence =
      total > 0 ? Math.max(bullSignals, bearSignals) / total : 0;
    const netBullish = bullSignals - bearSignals;
    const confidence = Math.min(0.95, 0.4 + convergence * 0.5);

    let action: FuturesAction = "HOLD";
    let reason = "Insufficient convergence across signals.";

    if (position.side === "FLAT") {
      if (total >= 3 && convergence >= 0.7 && netBullish >= 2) {
        action = "OPEN_LONG";
        reason = "Multiple independent signals converge bullish.";
      } else if (total >= 3 && convergence >= 0.7 && netBullish <= -2) {
        action = "OPEN_SHORT";
        reason = "Multiple independent signals converge bearish.";
      }
    } else if (position.side === "LONG") {
      // High burden to close: require strong, multi-signal deterioration.
      if (total >= 3 && convergence >= 0.75 && netBullish <= -3) {
        action = "CLOSE_LONG";
        reason =
          "Bullish thesis has materially deteriorated across multiple signals.";
      } else {
        reason = "Bullish thesis remains sufficiently intact.";
      }
    } else if (position.side === "SHORT") {
      if (total >= 3 && convergence >= 0.75 && netBullish >= 3) {
        action = "CLOSE_SHORT";
        reason =
          "Bearish thesis has materially deteriorated across multiple signals.";
      } else {
        reason = "Bearish thesis remains sufficiently intact.";
      }
    }

    return {
      decision: {
        action,
        confidence:
          action === "HOLD" ? Math.min(confidence, 0.6) : confidence,
        reason,
      },
    };
  }
}

export class FixedActionAgent implements PolygraphAgent {
  name: string;

  constructor(
    private readonly action: FuturesAction,
    private readonly confidence = 0.9,
  ) {
    this.name = `Fixed-Action Agent (${action})`;
  }

  async decide(): Promise<PolygraphAgentDecision> {
    return {
      decision: {
        action: this.action,
        confidence: this.confidence,
        reason: "scripted adversarial agent",
      },
    };
  }
}

export class MalformedOutputAgent implements PolygraphAgent {
  name = "Malformed-Output Agent (adversarial)";

  private readonly variants: FuturesDecision[] = [
    {
      action: "SHORT" as FuturesAction,
      confidence: 0.8,
      reason: "not a real action",
    },
    {
      action: "HOLD",
      confidence: 1.7,
      reason: "confidence out of range",
    },
    {
      action: "HOLD",
      confidence: NaN,
      reason: "NaN confidence",
    },
    {
      action: "OPEN_LONG",
      confidence: -0.2,
      reason: "negative confidence",
    },
  ];

  private i = 0;

  async decide(): Promise<PolygraphAgentDecision> {
    const d = this.variants[this.i % this.variants.length];
    this.i++;
    return { decision: d };
  }
}