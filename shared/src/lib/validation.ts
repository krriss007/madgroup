/**
 * TradePilot — order validation.
 *
 * Pure functions so they can be unit-tested and reused by the backend, the demo
 * engine and (mirrored) by the MQL5 EA, which validates a second time before it
 * touches the broker.
 */

import { ErrorCode, TradePilotError } from './errors';
import { decimalsOfStep, isOnVolumeStep, round, roundPrice } from './math';
import type { OrderSide, OrderType, SymbolInfo, Timeframe } from '../types/domain';

export interface OrderValidationInput {
  symbol: SymbolInfo;
  side: OrderSide;
  type: OrderType;
  volume: number;
  /** market price used for distance checks (ask for BUY, bid for SELL) */
  marketPrice: number;
  /** requested entry for pending orders; null/undefined for market orders */
  price?: number | null;
  stopLimitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  expiration?: string | null;
  /** current server time, allows deterministic tests */
  now?: Date;
  /** account leverage, used for the margin estimate */
  leverage?: number;
  freeMargin?: number;
  /** configured maximum lot size (0 = broker limit only) */
  maxLotSize?: number;
}

export interface OrderValidationResult {
  valid: boolean;
  errors: { code: string; message: string; field: string }[];
  warnings: string[];
  normalizedVolume: number;
  /** stops adjusted to satisfy the broker's stops level, if we could fix them */
  adjusted: { stopLoss?: number | null; takeProfit?: number | null };
}

const TF_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
  W1: 604800,
};

export { TF_SECONDS };

export function timeframeSeconds(timeframe: Timeframe): number {
  return TF_SECONDS[timeframe];
}

/** Broker stops level expressed in price units. */
export function stopsLevelPrice(symbol: SymbolInfo): number {
  const point = symbol.point > 0 ? symbol.point : symbol.tickSize || 0.00001;
  return symbol.stopsLevel > 0 ? symbol.stopsLevel * point : 0;
}

/** Spread expressed in price units. */
export function spreadPrice(bid: number, ask: number): number {
  return round(Math.max(0, ask - bid), 8);
}

export function spreadPoints(bid: number, ask: number, point: number): number {
  if (point <= 0) return 0;
  return round(Math.abs(ask - bid) / point, 1);
}

/**
 * Symbol availability based on the spec's session strings.
 * An empty session list means "no session restriction reported" (24/5 for FX).
 * Session strings are in the broker server timezone; when the EA does not
 * report a timezone we assume the platform's UTC clock (documented).
 */
export function isSymbolTradingNow(symbol: SymbolInfo, now: Date = new Date()): boolean {
  if (symbol.sessions.length === 0) return true;
  // MT5 reports 7 days (Sunday..Saturday). Empty string means closed that day.
  const dayIndex = now.getUTCDay();
  const todaySession = symbol.sessions[dayIndex];
  if (!todaySession || todaySession.trim() === '') return false;
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  return todaySession
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => {
      const [start, end] = segment.split('-');
      if (!start || !end) return false;
      const startMinutes = toMinutes(start);
      const endMinutes = toMinutes(end);
      if (startMinutes == null || endMinutes == null) return false;
      if (endMinutes >= startMinutes) return minutesNow >= startMinutes && minutesNow <= endMinutes;
      // session crosses midnight
      return minutesNow >= startMinutes || minutesNow <= endMinutes;
    });
}

function toMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function validateOrder(input: OrderValidationInput): OrderValidationResult {
  const errors: OrderValidationResult['errors'] = [];
  const warnings: string[] = [];
  const { symbol } = input;
  const step = symbol.volumeStep > 0 ? symbol.volumeStep : 0.01;
  const volumeMin = symbol.volumeMin > 0 ? symbol.volumeMin : step;
  const volumeMax = symbol.volumeMax > 0 ? symbol.volumeMax : 100;

  /* ---------------------------- volume ---------------------------- */
  const normalizedVolume = round(Math.round(input.volume / step) * step, decimalsOfStep(step));
  if (!Number.isFinite(input.volume) || input.volume <= 0) {
    errors.push({ code: ErrorCode.INVALID_VOLUME, message: 'Volume must be greater than zero.', field: 'volume' });
  } else if (normalizedVolume < volumeMin - 1e-9 || normalizedVolume > volumeMax + 1e-9) {
    errors.push({
      code: ErrorCode.INVALID_VOLUME,
      message: `Volume must be between ${volumeMin.toFixed(decimalsOfStep(step))} and ${volumeMax.toFixed(2)} with a ${step} step.`,
      field: 'volume',
    });
  } else if (!isOnVolumeStep(normalizedVolume, step)) {
    errors.push({
      code: ErrorCode.INVALID_VOLUME,
      message: `Volume must be a multiple of the broker volume step (${step}).`,
      field: 'volume',
    });
  }
  if (input.maxLotSize && input.maxLotSize > 0 && normalizedVolume > input.maxLotSize + 1e-9) {
    errors.push({
      code: ErrorCode.MAX_LOT_EXCEEDED,
      message: `Volume ${normalizedVolume} exceeds your configured maximum lot size of ${input.maxLotSize}.`,
      field: 'volume',
    });
  }

  /* -------------------------- symbol state ------------------------ */
  if (!symbol.tradeAllowed) {
    errors.push({ code: ErrorCode.MARKET_CLOSED, message: 'Trading is not allowed for this symbol right now.', field: 'symbol' });
  }
  if (symbol.tradeMode === 0) {
    errors.push({ code: ErrorCode.MARKET_CLOSED, message: 'Market is currently closed.', field: 'symbol' });
  } else if (symbol.tradeMode === 1 && input.side === 'SELL') {
    errors.push({ code: ErrorCode.MARKET_CLOSED, message: 'Only long positions are allowed for this symbol.', field: 'side' });
  } else if (symbol.tradeMode === 2 && input.side === 'BUY') {
    errors.push({ code: ErrorCode.MARKET_CLOSED, message: 'Only short positions are allowed for this symbol.', field: 'side' });
  } else if (symbol.tradeMode === 3) {
    errors.push({ code: ErrorCode.MARKET_CLOSED, message: 'Only position closing is allowed for this symbol.', field: 'symbol' });
  }

  const now = input.now ?? new Date();
  if (!isSymbolTradingNow(symbol, now)) {
    errors.push({ code: ErrorCode.MARKET_CLOSED, message: 'Market is currently closed.', field: 'symbol' });
  }

  /* ----------------------------- price ---------------------------- */
  const marketPrice = input.marketPrice;
  let entryPrice = marketPrice;

  if (input.type === 'MARKET') {
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
      errors.push({ code: ErrorCode.NO_QUOTE, message: 'No price available for this symbol.', field: 'price' });
    }
  } else {
    const price = input.price;
    if (price == null || !Number.isFinite(price) || price <= 0) {
      errors.push({ code: ErrorCode.INVALID_PRICE, message: 'Pending order price is required.', field: 'price' });
    } else {
      entryPrice = price;
      if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
        errors.push({ code: ErrorCode.NO_QUOTE, message: 'No price available for this symbol.', field: 'price' });
      } else {
        const delta = price - marketPrice;
        const tolerance = Math.max(stopsLevelPrice(symbol), symbol.point || 0.00001);
        if (input.type === 'LIMIT') {
          if (input.side === 'BUY' && delta > -tolerance) {
            errors.push({
              code: ErrorCode.INVALID_PRICE,
              message: 'BUY LIMIT price must be below the current market price.',
              field: 'price',
            });
          }
          if (input.side === 'SELL' && delta < tolerance) {
            errors.push({
              code: ErrorCode.INVALID_PRICE,
              message: 'SELL LIMIT price must be above the current market price.',
              field: 'price',
            });
          }
        }
        if (input.type === 'STOP') {
          if (input.side === 'BUY' && delta < tolerance) {
            errors.push({
              code: ErrorCode.INVALID_PRICE,
              message: 'BUY STOP price must be above the current market price.',
              field: 'price',
            });
          }
          if (input.side === 'SELL' && delta > -tolerance) {
            errors.push({
              code: ErrorCode.INVALID_PRICE,
              message: 'SELL STOP price must be below the current market price.',
              field: 'price',
            });
          }
        }
        if (input.type === 'STOP_LIMIT') {
          const stopLimit = input.stopLimitPrice;
          if (stopLimit == null || !Number.isFinite(stopLimit) || stopLimit <= 0) {
            errors.push({
              code: ErrorCode.INVALID_PRICE,
              message: 'Stop Limit orders require a stop-limit price.',
              field: 'stopLimitPrice',
            });
          }
        }
      }
    }
  }

  /* ---------------------------- stops ----------------------------- */
  const stopsLevel = stopsLevelPrice(symbol);
  const minDistance = Math.max(stopsLevel, symbol.point || 0.00001);
  const adjusted: OrderValidationResult['adjusted'] = {};

  if (input.stopLoss != null && Number.isFinite(input.stopLoss)) {
    const sl = input.stopLoss;
    if (sl <= 0) {
      errors.push({ code: ErrorCode.INVALID_STOP_LOSS, message: 'Stop Loss must be a positive price.', field: 'stopLoss' });
    } else if (Number.isFinite(entryPrice) && entryPrice > 0) {
      const distance = Math.abs(entryPrice - sl);
      if (distance < minDistance) {
        errors.push({
          code: ErrorCode.STOPS_LEVEL_VIOLATION,
          message: `Stop Loss is too close to the entry price. Minimum distance is ${round(minDistance, symbol.digits)} (${symbol.stopsLevel} points).`,
          field: 'stopLoss',
        });
      } else if (input.side === 'BUY' && sl > entryPrice) {
        errors.push({ code: ErrorCode.INVALID_STOP_LOSS, message: 'For a BUY order the Stop Loss must be below the entry price.', field: 'stopLoss' });
      } else if (input.side === 'SELL' && sl < entryPrice) {
        errors.push({ code: ErrorCode.INVALID_STOP_LOSS, message: 'For a SELL order the Stop Loss must be above the entry price.', field: 'stopLoss' });
      } else {
        adjusted.stopLoss = roundPrice(sl, symbol.digits);
      }
    }
  } else if (input.stopLoss != null && !Number.isFinite(input.stopLoss)) {
    errors.push({ code: ErrorCode.INVALID_STOP_LOSS, message: 'Stop Loss is not a valid number.', field: 'stopLoss' });
  }

  if (input.takeProfit != null && Number.isFinite(input.takeProfit)) {
    const tp = input.takeProfit;
    if (tp <= 0) {
      errors.push({ code: ErrorCode.INVALID_TAKE_PROFIT, message: 'Take Profit must be a positive price.', field: 'takeProfit' });
    } else if (Number.isFinite(entryPrice) && entryPrice > 0) {
      const distance = Math.abs(tp - entryPrice);
      if (distance < minDistance) {
        errors.push({
          code: ErrorCode.STOPS_LEVEL_VIOLATION,
          message: `Take Profit is too close to the entry price. Minimum distance is ${round(minDistance, symbol.digits)} (${symbol.stopsLevel} points).`,
          field: 'takeProfit',
        });
      } else if (input.side === 'BUY' && tp < entryPrice) {
        errors.push({ code: ErrorCode.INVALID_TAKE_PROFIT, message: 'For a BUY order the Take Profit must be above the entry price.', field: 'takeProfit' });
      } else if (input.side === 'SELL' && tp > entryPrice) {
        errors.push({ code: ErrorCode.INVALID_TAKE_PROFIT, message: 'For a SELL order the Take Profit must be below the entry price.', field: 'takeProfit' });
      } else {
        adjusted.takeProfit = roundPrice(tp, symbol.digits);
      }
    }
  } else if (input.takeProfit != null && !Number.isFinite(input.takeProfit)) {
    errors.push({ code: ErrorCode.INVALID_TAKE_PROFIT, message: 'Take Profit is not a valid number.', field: 'takeProfit' });
  }

  if (
    input.stopLoss != null &&
    input.takeProfit != null &&
    Number.isFinite(input.stopLoss) &&
    Number.isFinite(input.takeProfit) &&
    input.stopLoss > 0 &&
    input.takeProfit > 0
  ) {
    const risk = Math.abs(entryPrice - input.stopLoss);
    const reward = Math.abs(input.takeProfit - entryPrice);
    if (reward < risk) {
      warnings.push('Take Profit is closer than the Stop Loss (risk/reward below 1:1).');
    }
  }

  /* -------------------------- expiration -------------------------- */
  if (input.expiration) {
    const ts = Date.parse(input.expiration);
    if (Number.isNaN(ts)) {
      errors.push({ code: ErrorCode.INVALID_EXPIRATION, message: 'Expiration date is not valid.', field: 'expiration' });
    } else if (ts <= now.getTime()) {
      errors.push({ code: ErrorCode.INVALID_EXPIRATION, message: 'Expiration must be in the future.', field: 'expiration' });
    }
  } else if (input.type === 'STOP_LIMIT') {
    warnings.push('Stop Limit orders without an expiration stay active until cancelled.');
  }

  /* ---------------------------- margin ---------------------------- */
  if (input.freeMargin != null && input.leverage != null && Number.isFinite(entryPrice) && entryPrice > 0) {
    const leverage = input.leverage > 0 ? input.leverage : 100;
    const notional = normalizedVolume * symbol.contractSize * entryPrice;
    const required = notional / leverage;
    if (required > input.freeMargin) {
      errors.push({
        code: ErrorCode.INSUFFICIENT_MARGIN,
        message: `Insufficient free margin. Required ≈ ${round(required, 2)} ${symbol.currencyProfit}, available ${round(input.freeMargin, 2)}.`,
        field: 'volume',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalizedVolume,
    adjusted,
  };
}

/** Throw the first validation error as a TradePilotError (for backend routes). */
export function assertOrderValid(result: OrderValidationResult): void {
  if (result.valid) return;
  const first = result.errors[0];
  const status = first.code === ErrorCode.INSUFFICIENT_MARGIN ? 409 : 400;
  throw new TradePilotError(first.code, first.message, status, {
    details: Object.fromEntries(result.errors.map((e) => [e.field, e.message])),
  });
}

/** Validate a stop-loss/take-profit modification against the current price. */
export function validateStopModification(
  symbol: SymbolInfo,
  side: OrderSide,
  currentPrice: number,
  stopLoss: number | null,
  takeProfit: number | null,
): OrderValidationResult {
  return validateOrder({
    symbol,
    side,
    type: 'MARKET',
    volume: symbol.volumeMin || symbol.volumeStep || 0.01,
    marketPrice: currentPrice,
    stopLoss,
    takeProfit,
  });
}
