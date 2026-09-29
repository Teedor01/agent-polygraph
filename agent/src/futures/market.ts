import { safeInvoke } from "@bitget-ai/bitget-agent-sdk";
import type { FuturesRuntimeContext } from "./config.js";

export interface FuturesCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FuturesMarketState {
  timestamp: string;
  category: "USDT-FUTURES";
  symbol: string;
  raw: unknown;

  lastPrice: number | null;
  previousPrice: number | null;
  priceChangePct: number | null;

  momentum: number | null;
  volatilityPct: number | null;
  atr: number | null;
  rsi: number | null;

  sma20: number | null;
  sma50: number | null;
  distanceFromSma20Pct: number | null;
  distanceFromSma50Pct: number | null;

  recentCandles: FuturesCandle[];

  volume: number | null;
  averageVolume: number | null;
  volumeRatio: number | null;

  bestBid: number | null;
  bestAsk: number | null;
  spreadPct: number | null;
  bidVolume: number | null;
  askVolume: number | null;
  orderBookImbalance: number | null;

  markPrice: number | null;
  fundingRate: number | null;
  indexPrice: number | null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractRows(data: unknown): any[] {
  if (Array.isArray(data)) {
    return data;
  }

  if (data && typeof data === "object") {
    const obj = data as any;

    if (Array.isArray(obj.data)) {
      return obj.data;
    }

    if (Array.isArray(obj.list)) {
      return obj.list;
    }
  }

  return [];
}

function parseCandles(data: unknown): FuturesCandle[] {
  return extractRows(data)
    .map((row) => {
      if (!Array.isArray(row)) {
        return null;
      }

      const timestamp = toNumber(row[0]);
      const open = toNumber(row[1]);
      const high = toNumber(row[2]);
      const low = toNumber(row[3]);
      const close = toNumber(row[4]);
      const volume = toNumber(row[5]);

      if (
        timestamp === null ||
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        volume === null
      ) {
        return null;
      }

      return {
        timestamp,
        open,
        high,
        low,
        close,
        volume,
      };
    })
    .filter((c): c is FuturesCandle => c !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }

  const mean = average(values);

  if (mean === null) {
    return null;
  }

  const variance =
    values.reduce(
      (sum, value) => sum + Math.pow(value - mean, 2),
      0,
    ) / values.length;

  return Math.sqrt(variance);
}

function calculateSma(
  candles: FuturesCandle[],
  period: number,
): number | null {
  if (candles.length < period) {
    return null;
  }

  const closes = candles
    .slice(-period)
    .map((candle) => candle.close);

  return average(closes);
}

function calculateRsi(
  candles: FuturesCandle[],
  period = 14,
): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const recent = candles.slice(-(period + 1));

  let gains = 0;
  let losses = 0;

  for (let i = 1; i < recent.length; i += 1) {
    const change = recent[i].close - recent[i - 1].close;

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  const relativeStrength = averageGain / averageLoss;

  return 100 - 100 / (1 + relativeStrength);
}

function calculateAtr(
  candles: FuturesCandle[],
  period = 14,
): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const recent = candles.slice(-(period + 1));
  const trueRanges: number[] = [];

  for (let i = 1; i < recent.length; i += 1) {
    const current = recent[i];
    const previous = recent[i - 1];

    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );

    trueRanges.push(trueRange);
  }

  return average(trueRanges);
}

function calculateVolatilityPct(
  candles: FuturesCandle[],
  period = 20,
): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const recent = candles.slice(-(period + 1));
  const returns: number[] = [];

  for (let i = 1; i < recent.length; i += 1) {
    const previousClose = recent[i - 1].close;
    const currentClose = recent[i].close;

    if (previousClose > 0) {
      returns.push(
        ((currentClose - previousClose) / previousClose) * 100,
      );
    }
  }

  return standardDeviation(returns);
}

function calculateMomentum(
  candles: FuturesCandle[],
  period = 5,
): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const current = candles[candles.length - 1].close;
  const previous = candles[candles.length - 1 - period].close;

  if (previous === 0) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function parseOrderBook(data: unknown): {
  bestBid: number | null;
  bestAsk: number | null;
  bidVolume: number | null;
  askVolume: number | null;
  spreadPct: number | null;
  imbalance: number | null;
} {
  const obj =
    data && typeof data === "object"
      ? (data as any)
      : {};

  const bids = Array.isArray(obj.bids) ? obj.bids : [];
  const asks = Array.isArray(obj.asks) ? obj.asks : [];

  const validBids = bids
    .filter((row: unknown) => Array.isArray(row))
    .map((row: any[]) => ({
      price: toNumber(row[0]),
      volume: toNumber(row[1]),
    }))
    .filter(
      (
        row: {
          price: number | null;
          volume: number | null;
        },
      ) => row.price !== null && row.volume !== null,
    );

  const validAsks = asks
    .filter((row: unknown) => Array.isArray(row))
    .map((row: any[]) => ({
      price: toNumber(row[0]),
      volume: toNumber(row[1]),
    }))
    .filter(
      (
        row: {
          price: number | null;
          volume: number | null;
        },
      ) => row.price !== null && row.volume !== null,
    );

  const bestBid =
    validBids.length > 0 ? validBids[0].price : null;

  const bestAsk =
    validAsks.length > 0 ? validAsks[0].price : null;

  const bidVolume =
    validBids.length > 0
      ? validBids.reduce(
          (
            sum: number,
            row: {
              price: number | null;
              volume: number | null;
            },
          ) => sum + row.volume!,
          0,
        )
      : null;

  const askVolume =
    validAsks.length > 0
      ? validAsks.reduce(
          (
            sum: number,
            row: {
              price: number | null;
              volume: number | null;
            },
          ) => sum + row.volume!,
          0,
        )
      : null;

  const spreadPct =
    bestBid !== null &&
    bestAsk !== null &&
    (bestBid + bestAsk) / 2 > 0
      ? ((bestAsk - bestBid) /
          ((bestBid + bestAsk) / 2)) *
        100
      : null;

  const imbalance =
    bidVolume !== null &&
    askVolume !== null &&
    bidVolume + askVolume > 0
      ? (bidVolume - askVolume) /
        (bidVolume + askVolume)
      : null;

  return {
    bestBid,
    bestAsk,
    bidVolume,
    askVolume,
    spreadPct,
    imbalance,
  };
}

export async function fetchFuturesMarketState(
  ctx: FuturesRuntimeContext,
): Promise<FuturesMarketState> {
  const marketTool = ctx.tools.find(
    (tool) => tool.name === "market",
  );

  if (!marketTool) {
    throw new Error(
      "`market` tool not present in this config's tool surface.",
    );
  }

  const baseArgs = {
    category: ctx.instrument.category,
    symbol: ctx.instrument.symbol,
  };

  const [
    tickerResult,
    candlesResult,
    orderBookResult,
  ] = await Promise.all([
    safeInvoke(
      marketTool,
      {
        action: "tickers",
        ...baseArgs,
      },
      {
        config: ctx.config,
        client: ctx.client,
      },
    ),

    safeInvoke(
      marketTool,
      {
        action: "candles",
        ...baseArgs,
        interval: "5m",
        limit: "50",
      },
      {
        config: ctx.config,
        client: ctx.client,
      },
    ),

    safeInvoke(
      marketTool,
      {
        action: "orderbook",
        ...baseArgs,
        limit: "20",
      },
      {
        config: ctx.config,
        client: ctx.client,
      },
    ),
  ]);

  if (!tickerResult.ok) {
    throw new Error(
      `futures market.tickers failed: ${JSON.stringify(
        tickerResult.error,
      )}`,
    );
  }

  const tickerRows = extractRows(tickerResult.data);
  const row = tickerRows[0] ?? tickerResult.data;

  const lastPrice = toNumber(
    row?.lastPrice ??
      row?.lastPr ??
      row?.last ??
      row?.close,
  );

  if (lastPrice === null) {
    throw new Error(
      "Bitget futures ticker returned no valid last price.",
    );
  }

  const candles = candlesResult.ok
    ? parseCandles(candlesResult.data)
    : [];

  const orderBook = orderBookResult.ok
    ? parseOrderBook(orderBookResult.data)
    : {
        bestBid: null,
        bestAsk: null,
        bidVolume: null,
        askVolume: null,
        spreadPct: null,
        imbalance: null,
      };

  const previousPrice =
    candles.length >= 2
      ? candles[candles.length - 2].close
      : null;

  const priceChangePct =
    previousPrice !== null && previousPrice !== 0
      ? ((lastPrice - previousPrice) /
          previousPrice) *
        100
      : null;

  const momentum = calculateMomentum(candles, 5);
  const volatilityPct = calculateVolatilityPct(candles, 20);
  const atr = calculateAtr(candles, 14);
  const rsi = calculateRsi(candles, 14);

  const sma20 = calculateSma(candles, 20);
  const sma50 = calculateSma(candles, 50);

  const distanceFromSma20Pct =
    sma20 !== null && sma20 !== 0
      ? ((lastPrice - sma20) / sma20) * 100
      : null;

  const distanceFromSma50Pct =
    sma50 !== null && sma50 !== 0
      ? ((lastPrice - sma50) / sma50) * 100
      : null;

  const recentCandles = candles.slice(-10);

  const candleVolumes = candles
    .slice(-20)
    .map((candle) => candle.volume);

  const averageVolume = average(candleVolumes);

  const latestCandleVolume =
    candles.length > 0
      ? candles[candles.length - 1].volume
      : null;

  const volume =
    latestCandleVolume ??
    toNumber(row?.baseVolume) ??
    toNumber(row?.volume) ??
    null;

  const volumeRatio =
    volume !== null &&
    averageVolume !== null &&
    averageVolume > 0
      ? volume / averageVolume
      : null;

  const markPrice = toNumber(
    row?.markPrice ?? row?.markPr,
  );

  const fundingRate = toNumber(
    row?.fundingRate ?? row?.capitalRate,
  );

  const indexPrice = toNumber(
    row?.indexPrice ?? row?.indexPr,
  );

  return {
    timestamp: new Date().toISOString(),
    category: ctx.instrument.category,
    symbol: ctx.instrument.symbol,

    raw: {
      ticker: tickerResult.data,
      candles: candlesResult.ok
        ? candlesResult.data
        : null,
      orderbook: orderBookResult.ok
        ? orderBookResult.data
        : null,
      candleError: candlesResult.ok
        ? null
        : candlesResult.error,
      orderBookError: orderBookResult.ok
        ? null
        : orderBookResult.error,
    },

    lastPrice,
    previousPrice,
    priceChangePct,

    momentum,
    volatilityPct,
    atr,
    rsi,

    sma20,
    sma50,
    distanceFromSma20Pct,
    distanceFromSma50Pct,

    recentCandles,

    volume,
    averageVolume,
    volumeRatio,

    bestBid: orderBook.bestBid,
    bestAsk: orderBook.bestAsk,
    spreadPct: orderBook.spreadPct,
    bidVolume: orderBook.bidVolume,
    askVolume: orderBook.askVolume,
    orderBookImbalance: orderBook.imbalance,

    markPrice,
    fundingRate,
    indexPrice,
  };
}