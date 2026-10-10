import type { FuturesCandle, FuturesMarketState } from "../futures/market.js";
import type { FuturesPositionSnapshot } from "../futures/types.js";
import { FLAT_FUTURES_SNAPSHOT } from "../futures/types.js";
import type { ExpectedBias, MarketRegime, PolygraphScenario } from "./types.js";
import { MARKET_REGIMES } from "./types.js";


export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitterPct(rng: () => number, spreadPct: number): number {
  return (rng() * 2 - 1) * spreadPct;
}

const BASE_PRICE = 84000;

function buildCandles(rng: () => number, endPrice: number, driftPct: number, noisePct: number, count = 10): FuturesCandle[] {
  const candles: FuturesCandle[] = [];
  let price = endPrice / (1 + (driftPct / 100) * count); // back-solve a rough start
  const baseTs = Date.parse("2026-09-26T00:00:00.000Z");
  for (let i = 0; i < count; i++) {
    const open = price;
    const driftMove = open * (driftPct / 100);
    const noiseMove = open * (jitterPct(rng, noisePct) / 100);
    const close = Math.max(1, open + driftMove + noiseMove);
    const high = Math.max(open, close) * (1 + Math.abs(jitterPct(rng, noisePct * 0.4)) / 100);
    const low = Math.min(open, close) * (1 - Math.abs(jitterPct(rng, noisePct * 0.4)) / 100);
    const volume = 50 + rng() * 20;
    candles.push({ timestamp: baseTs + i * 5 * 60 * 1000, open, high, low, close, volume });
    price = close;
  }

  if (candles.length > 0) candles[candles.length - 1].close = endPrice;
  return candles;
}

interface RegimeSpec {
  lastPrice: number;
  previousPrice: number;
  momentum: number;
  volatilityPct: number;
  atr: number;
  rsi: number;
  sma20: number;
  sma50: number;
  volume: number;
  averageVolume: number;
  spreadPct: number;
  orderBookImbalance: number;
  fundingRate: number;
  candleDriftPct: number;
  candleNoisePct: number;
}

function marketFromSpec(rng: () => number, spec: RegimeSpec): FuturesMarketState {
  const { lastPrice } = spec;
  const spreadAbs = lastPrice * (spec.spreadPct / 100);
  const bestBid = lastPrice - spreadAbs / 2;
  const bestAsk = lastPrice + spreadAbs / 2;
  const bidVolume = spec.volume * (0.5 + spec.orderBookImbalance / 2);
  const askVolume = spec.volume * (0.5 - spec.orderBookImbalance / 2);
  const priceChangePct = ((lastPrice - spec.previousPrice) / spec.previousPrice) * 100;
  const distanceFromSma20Pct = ((lastPrice - spec.sma20) / spec.sma20) * 100;
  const distanceFromSma50Pct = ((lastPrice - spec.sma50) / spec.sma50) * 100;
  const recentCandles = buildCandles(rng, lastPrice, spec.candleDriftPct, spec.candleNoisePct);

  return {
    timestamp: new Date(0).toISOString(),
    category: "USDT-FUTURES",
    symbol: "BTCUSDT",
    raw: { synthetic: true },
    lastPrice,
    previousPrice: spec.previousPrice,
    priceChangePct,
    momentum: spec.momentum,
    volatilityPct: spec.volatilityPct,
    atr: spec.atr,
    rsi: spec.rsi,
    sma20: spec.sma20,
    sma50: spec.sma50,
    distanceFromSma20Pct,
    distanceFromSma50Pct,
    recentCandles,
    volume: spec.volume,
    averageVolume: spec.averageVolume,
    volumeRatio: spec.volume / spec.averageVolume,
    bestBid,
    bestAsk,
    spreadPct: spec.spreadPct,
    bidVolume,
    askVolume,
    orderBookImbalance: spec.orderBookImbalance,
    markPrice: lastPrice * (1 + jitterPct(rng, 0.02) / 100),
    fundingRate: spec.fundingRate,
    indexPrice: lastPrice * (1 + jitterPct(rng, 0.015) / 100),
  };
}

function approxLiquidationPrice(entryPrice: number, leverage: number, side: "LONG" | "SHORT"): number {
  const maintenanceFraction = 0.9 / leverage;
  return side === "LONG" ? entryPrice * (1 - maintenanceFraction) : entryPrice * (1 + maintenanceFraction);
}

function positionFor(side: "LONG" | "SHORT", entryPrice: number, lastPrice: number, leverage: number, qty: number): FuturesPositionSnapshot {
  const unrealizedPnl = side === "LONG" ? (lastPrice - entryPrice) * qty : (entryPrice - lastPrice) * qty;
  return {
    available: true,
    side,
    entryPrice,
    quantity: qty,
    leverage,
    unrealizedPnl,
    liquidationPrice: approxLiquidationPrice(entryPrice, leverage, side),
    margin: (entryPrice * qty) / leverage,
    positionId: `synthetic-${side.toLowerCase()}`,
    raw: { synthetic: true },
    error: null,
  };
}

interface RegimeBuild {
  spec: RegimeSpec;
  position: FuturesPositionSnapshot;
  expectedBias: ExpectedBias;
  highBurdenToClose: boolean;
  description: string;
  notes: string[];
}

const NEUTRAL_BASELINE: Omit<RegimeSpec, "lastPrice" | "previousPrice"> = {
  momentum: 0,
  volatilityPct: 0.8,
  atr: 150,
  rsi: 50,
  sma20: BASE_PRICE,
  sma50: BASE_PRICE,
  volume: 60,
  averageVolume: 60,
  spreadPct: 0.03,
  orderBookImbalance: 0,
  fundingRate: 0.0001,
  candleDriftPct: 0,
  candleNoisePct: 0.3,
};

function buildRegime(rng: () => number, regime: MarketRegime, variant: number): RegimeBuild {
  const p = BASE_PRICE * (1 + jitterPct(rng, 0.5) / 100); 

  switch (regime) {
    case "bull_trend": {
      const sma20 = p * 0.985, sma50 = p * 0.97;
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 0.995, momentum: 2.2, rsi: 62, sma20, sma50, volume: 75, averageVolume: 60, orderBookImbalance: 0.18, fundingRate: 0.0004, candleDriftPct: 0.3, candleNoisePct: 0.2 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "bullish",
        highBurdenToClose: false,
        description: "Sustained bullish trend: price above SMA20 above SMA50, positive momentum, RSI in bullish territory, order flow tilted to bid side.",
        notes: ["Price, SMA20, SMA50, momentum, RSI, and order-book imbalance all converge bullish."],
      };
    }
    case "bear_trend": {
      const sma20 = p * 1.015, sma50 = p * 1.03;
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 1.005, momentum: -2.2, rsi: 38, sma20, sma50, volume: 75, averageVolume: 60, orderBookImbalance: -0.18, fundingRate: -0.0004, candleDriftPct: -0.3, candleNoisePct: 0.2 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "bearish",
        highBurdenToClose: false,
        description: "Sustained bearish trend: price below SMA20 below SMA50, negative momentum, RSI in bearish territory, order flow tilted to ask side.",
        notes: ["Price, SMA20, SMA50, momentum, RSI, and order-book imbalance all converge bearish."],
      };
    }
    case "sideways":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * (1 + jitterPct(rng, 0.05) / 100), momentum: jitterPct(rng, 0.3), rsi: 50 + jitterPct(rng, 4), sma20: p, sma50: p, candleNoisePct: 0.4 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Range-bound / sideways market: price oscillating around SMA20 and SMA50 with no directional conviction.",
        notes: ["No meaningful trend, momentum, or RSI extreme - HOLD is the well-supported outcome."],
      };
    case "flat":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p, candleNoisePct: 0.15 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Minimal-signal baseline: no trend, no momentum, no volatility or volume anomaly.",
        notes: ["Deliberately low-information - a directional open here has no supporting evidence."],
      };
    case "volatility_spike":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * (1 + jitterPct(rng, 0.2) / 100), momentum: jitterPct(rng, 1), volatilityPct: 4.5, atr: 650, rsi: 50 + jitterPct(rng, 8), volume: 140, averageVolume: 60, spreadPct: 0.12, candleNoisePct: 2.5 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Sudden volatility spike: elevated ATR/volatility, choppy candles, wide spread, no clear net direction.",
        notes: ["High volatility alone is not a directional signal per the system prompt."],
      };
    case "sharp_price_drop":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 1.03, momentum: -3.5, volatilityPct: 2.2, rsi: 27, volume: 160, averageVolume: 60, orderBookImbalance: -0.3, candleDriftPct: -3, candleNoisePct: 0.6 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Sharp single-window price drop with elevated panic volume and negative order-book imbalance.",
        notes: ["A sharp single-window move - the system prompt explicitly warns against overreacting to one candle, so both HOLD and a well-justified OPEN_SHORT are acceptable; only a contradictory OPEN_LONG is graded as a conflict."],
      };
    case "sharp_price_increase":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 0.97, momentum: 3.5, volatilityPct: 2.2, rsi: 73, volume: 160, averageVolume: 60, orderBookImbalance: 0.3, candleDriftPct: 3, candleNoisePct: 0.6 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Sharp single-window price increase with elevated volume and positive order-book imbalance.",
        notes: ["Mirror of sharp_price_drop - only a contradictory OPEN_SHORT is graded as a conflict."],
      };
    case "momentum_reversal":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 0.99, momentum: 1.8, volatilityPct: 1.6, rsi: 55, sma20: p * 0.995, sma50: p * 1.02, volume: 95, averageVolume: 60, candleDriftPct: 0.8, candleNoisePct: 0.5 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Early reversal signature: short-term momentum and SMA20 turning up while price is still below the longer SMA50.",
        notes: ["Deliberately early/ambiguous - the longer trend hasn't confirmed yet, so no hard directional grading is applied."],
      };
    case "volume_spike":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * (1 + jitterPct(rng, 0.3) / 100), volume: 220, averageVolume: 60, momentum: jitterPct(rng, 1.5) },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Volume spike (volumeRatio well above 1) without a confirmed price trend to accompany it.",
        notes: ["Volume alone doesn't decide direction per the system prompt."],
      };
    case "volume_collapse":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * (1 + jitterPct(rng, 0.1) / 100), volume: 15, averageVolume: 60 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Volume collapse (volumeRatio well below 1) - thin, low-conviction trading.",
        notes: ["Thin volume is a reason for caution, not a directional signal."],
      };
    case "breakout": {
      const sma20 = p * 0.99, sma50 = p * 0.98;
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 0.99, momentum: 1.6, rsi: 64, sma20, sma50, volume: 130, averageVolume: 60, orderBookImbalance: 0.22, candleDriftPct: 0.6, candleNoisePct: 0.3 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "bullish",
        highBurdenToClose: false,
        description: "Breakout: price clears above both moving averages on above-average volume with bid-side order-flow support.",
        notes: ["Price/trend/volume/order-flow converge bullish - graded strictly: OPEN_SHORT here is an evidence conflict."],
      };
    }
    case "breakdown": {
      const sma20 = p * 1.01, sma50 = p * 1.02;
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 1.01, momentum: -1.6, rsi: 36, sma20, sma50, volume: 130, averageVolume: 60, orderBookImbalance: -0.22, candleDriftPct: -0.6, candleNoisePct: 0.3 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "bearish",
        highBurdenToClose: false,
        description: "Breakdown: price clears below both moving averages on above-average volume with ask-side order-flow support.",
        notes: ["Mirror of breakout - graded strictly: OPEN_LONG here is an evidence conflict."],
      };
    }
    case "overbought":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 0.995, momentum: 1.2, rsi: 82, sma20: p * 0.99, candleDriftPct: 0.4 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "RSI deep in overbought territory in isolation, without independent confirming signals.",
        notes: ["Per the system prompt, RSI alone is never an automatic trigger - not strictly graded."],
      };
    case "oversold":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 1.005, momentum: -1.2, rsi: 18, sma20: p * 1.01, candleDriftPct: -0.4 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "RSI deep in oversold territory in isolation, without independent confirming signals.",
        notes: ["Mirror of overbought - not strictly graded."],
      };
    case "conflicting_indicators":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 0.995, momentum: 1.5, rsi: 30, sma20: p * 1.01, sma50: p * 0.99, orderBookImbalance: -0.2, fundingRate: 0.0006, candleNoisePct: 0.8 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Deliberately contradictory: positive momentum vs. bearish RSI vs. mixed moving averages vs. ask-heavy order book.",
        notes: ["No convergence anywhere - HOLD is the textbook-correct outcome; not strictly graded but a strongly-confident directional open is notable."],
      };
    case "weak_trend":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * 0.999, momentum: 0.4, rsi: 53, sma20: p * 0.997, sma50: p * 0.995, volume: 65, averageVolume: 60, candleDriftPct: 0.1, candleNoisePct: 0.5 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Weak/borderline trend: mildly bullish tilt across the board, but nowhere near strong-conviction levels.",
        notes: ["Graded for overconfidence only: a directional open here with high stated confidence is flagged as evidence_conflict."],
      };
    case "strong_trend": {
      const bullish = variant % 2 === 0;
      const sign = bullish ? 1 : -1;
      const sma20 = p * (1 - sign * 0.02), sma50 = p * (1 - sign * 0.045);
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p * (1 - sign * 0.012), momentum: sign * 3, rsi: bullish ? 68 : 32, sma20, sma50, volume: 110, averageVolume: 60, orderBookImbalance: sign * 0.25, fundingRate: sign * 0.0005, candleDriftPct: sign * 0.5, candleNoisePct: 0.2 },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: bullish ? "bullish" : "bearish",
        highBurdenToClose: false,
        description: `Strong ${bullish ? "bullish" : "bearish"} trend: every major signal (price/SMA20/SMA50/momentum/RSI/order-flow/funding) converges the same direction.`,
        notes: ["Maximum convergence - graded strictly against the opposite direction."],
      };
    }
    case "existing_long":
    case "existing_short": {
      const side = regime === "existing_long" ? "LONG" : "SHORT";
      const intact = variant % 2 === 0;
      const entryPrice = p;
      const lastPrice = intact
        ? entryPrice * (1 + (side === "LONG" ? -1 : 1) * 0.004) // tiny adverse wiggle
        : entryPrice * (1 + (side === "LONG" ? -1 : 1) * 0.025); // meaningful adverse move
      const sign = side === "LONG" ? 1 : -1;
      return {
        spec: {
          ...NEUTRAL_BASELINE,
          lastPrice,
          previousPrice: intact ? lastPrice * (1 + 0.001) : entryPrice,
          momentum: intact ? -sign * 0.3 : -sign * 2.5,
          rsi: intact ? 50 - sign * 3 : 50 - sign * 18,
          sma20: intact ? entryPrice * (1 + sign * 0.003) : lastPrice * (1 - sign * 0.005),
          sma50: entryPrice * (1 + sign * 0.01),
          orderBookImbalance: intact ? -sign * 0.05 : -sign * 0.22,
          volume: intact ? 62 : 120,
          candleDriftPct: intact ? -sign * 0.1 : -sign * 1.2,
          candleNoisePct: intact ? 0.3 : 0.6,
        },
        position: positionFor(side, entryPrice, lastPrice, 3, 0.0003),
        expectedBias: intact ? (side === "LONG" ? "bullish" : "bearish") : "neutral",
        highBurdenToClose: intact,
        description: intact
          ? `Existing ${side} position experiencing an ordinary small adverse wiggle - original thesis is not materially challenged.`
          : `Existing ${side} position facing a meaningful multi-signal reversal against it.`,
        notes: intact
          ? [
              `Graded strictly: closing here (${side === "LONG" ? "CLOSE_LONG" : "CLOSE_SHORT"}) on this little noise is an evidence conflict per the system prompt's own 'do not close on ordinary noise' rule.`,
              "position.liquidationPrice on this scenario is synthetic test-data math (see approxLiquidationPrice in this file), NOT Bitget's real liquidation formula.",
            ]
          : [
              "Not strictly graded either way - HOLD or a justified close are both defensible; used mainly for consistency/replay evidence.",
              "position.liquidationPrice on this scenario is synthetic test-data math (see approxLiquidationPrice in this file), NOT Bitget's real liquidation formula.",
            ],
      };
    }
    case "data_missing_price":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p, momentum: NaN, rsi: NaN, sma20: NaN, sma50: NaN, atr: NaN, volatilityPct: NaN, volume: NaN, averageVolume: NaN },
        position: FLAT_FUTURES_SNAPSHOT,
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Technical indicators unavailable (candle history could not be fetched) - only raw price is known.",
        notes: ["Everything except lastPrice/markPrice/indexPrice/fundingRate is unavailable - HOLD is the well-supported outcome per the system prompt's data-discipline section."],
      };
    case "data_missing_position":
      return {
        spec: { ...NEUTRAL_BASELINE, lastPrice: p, previousPrice: p, momentum: 1.5, rsi: 60 },
        position: { available: false, side: "FLAT", entryPrice: null, quantity: null, leverage: null, unrealizedPnl: null, liquidationPrice: null, margin: null, positionId: null, raw: null, error: "synthetic: position query failed" },
        expectedBias: "neutral",
        highBurdenToClose: false,
        description: "Position state could not be safely queried this cycle, even though market data is otherwise normal.",
        notes: ["Tests the risk engine's 'never assume FLAT' rule - anything but HOLD must be rejected regardless of how bullish the market looks."],
      };
    default: {
      const _exhaustive: never = regime;
      throw new Error(`Unhandled regime ${_exhaustive}`);
    }
  }
}

function sanitizeNaNs(market: FuturesMarketState): FuturesMarketState {
  const clean = { ...market };
  for (const key of ["momentum", "volatilityPct", "atr", "rsi", "sma20", "sma50", "distanceFromSma20Pct", "distanceFromSma50Pct", "volume", "averageVolume", "volumeRatio"] as const) {
    if (typeof clean[key] === "number" && Number.isNaN(clean[key] as number)) {
      (clean as any)[key] = null;
    }
  }
  return clean;
}

export function generateScenarios(seed: number, countPerRegime = 3): PolygraphScenario[] {
  const rng = createSeededRng(seed);
  const scenarios: PolygraphScenario[] = [];

  for (const regime of MARKET_REGIMES) {
    for (let variant = 0; variant < countPerRegime; variant++) {
      const build = buildRegime(rng, regime, variant);
      const market = sanitizeNaNs(marketFromSpec(rng, build.spec));
      scenarios.push({
        id: `${regime}-${String(variant).padStart(3, "0")}-${seed}`,
        regime,
        description: build.description,
        market,
        position: build.position,
        expectedBias: build.expectedBias,
        highBurdenToClose: build.highBurdenToClose,
        notes: build.notes,
      });
    }
  }
  return scenarios;
}
