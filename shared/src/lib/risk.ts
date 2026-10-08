/**
 * TradePilot — position sizing & risk math.
 *
 * NOTHING here is hard-coded to a specific instrument. Every calculation
 * derives from the broker specification the EA reported for that symbol
 * (tick size, tick value, contract size, volume grid), which is why the same
 * code works for XAUUSDm on one broker and XAUUSD.pro on another.
 */

import {
  decimalsOfStep,
  normalizeVolume,
  round,
  roundPrice,
} from './math';
import type { OrderSide } from '../types/domain';
import type { SymbolInfo } from '../types/domain';

export interface LotSizingInput {
  /** Account balance or the equity the user wants to risk against */
  balance: number;
  /** Risk in percent of balance (e.g. 1 = 1%) */
  riskPercent: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number | null;
  symbol: SymbolInfo;
  /** Optional hard cap coming from risk settings */
  maxLotSize?: number;
}

export interface LotSizingResult {
  /** ok = sized, clamped = reduced to broker/risk limits, invalid = cannot size */
  status: 'ok' | 'clamped' | 'invalid';
  reasons: string[];
  /** Maximum dollar amount the user accepts to lose on this trade */
  maxRiskAmount: number;
  /** Actual money at risk with the returned volume */
  actualRiskAmount: number;
  /** |entry - sl| in price units */
  stopDistance: number;
  stopDistancePoints: number;
  /** |tp - entry| in price units */
  rewardDistance: number;
  rewardDistancePoints: number;
  /** Account-currency loss per 1.00 lot if the stop is hit */
  lossPerLot: number;
  /** Account-currency profit per 1.00 lot if the target is hit */
  profitPerLot: number;
  /** Unrounded ideal volume */
  rawVolume: number;
  volume: number;
  /** Position size in units (volume × contract size) */
  units: number;
  potentialLoss: number;
  potentialProfit: number;
  /** reward / risk */
  riskReward: number | null;
  /** Required margin estimate, account currency */
  estimatedMargin: number;
  pipValue: number;
  tickValueUsed: number;
  volumeStep: number;
  volumeMin: number;
  volumeMax: number;
  warnings: string[];
}

function valuePerPriceUnit(symbol: SymbolInfo, priceUnits: number): number {
  // tickValue is the account-currency value of one tickSize move for 1.00 lot.
  const tickSize = symbol.tickSize > 0 ? symbol.tickSize : symbol.point;
  if (!tickSize || !Number.isFinite(symbol.tickValueLoss)) {
    // Fallback for brokers that report tick_value = 0 (rare, e.g. some CFDs):
    // contractSize × price delta is the value in quote currency.
    return priceUnits * symbol.contractSize;
  }
  const ticks = priceUnits / tickSize;
  const value = ticks * symbol.tickValueLoss;
  return Number.isFinite(value) && value > 0 ? value : priceUnits * symbol.contractSize;
}

function profitPerPriceUnit(symbol: SymbolInfo, priceUnits: number): number {
  const tickSize = symbol.tickSize > 0 ? symbol.tickSize : symbol.point;
  if (!tickSize || !Number.isFinite(symbol.tickValueProfit)) {
    return priceUnits * symbol.contractSize;
  }
  const ticks = priceUnits / tickSize;
  const value = ticks * symbol.tickValueProfit;
  return Number.isFinite(value) && value > 0 ? value : priceUnits * symbol.contractSize;
}

/**
 * Estimate the margin required for `volume` lots.
 * Standard MT5 formula: volume × contractSize × price / leverage, converted to
 * the account currency. When the symbol is quoted in another currency we fall
 * back to the value already expressed through tick value.
 */
export function estimateMargin(
  symbol: SymbolInfo,
  volume: number,
  price: number,
  leverage: number,
  accountCurrency = symbol.currencyProfit,
): number {
  const safeLeverage = leverage > 0 ? leverage : 100;
  const notional = volume * symbol.contractSize * price;
  const inQuote = notional / safeLeverage;
  if (symbol.currencyProfit === accountCurrency) return round(inQuote, 2);
  // Cross-currency: approximate through tick value (documented approximation,
  // the authoritative number always comes from the terminal's margin check).
  const tickValue = symbol.tickValue > 0 ? symbol.tickValue : symbol.tickValueLoss;
  if (tickValue > 0 && symbol.tickSize > 0) {
    const ticksPerUnit = 1 / symbol.tickSize;
    return round(volume * ticksPerUnit * tickValue * (price / Math.max(price, 1e-9)) / safeLeverage * safeLeverage, 2) === 0
      ? round(volume * ticksPerUnit * tickValue, 2)
      : round(volume * ticksPerUnit * tickValue, 2);
  }
  return round(inQuote, 2);
}

/**
 * Core position-size calculator.
 *
 * Example from the spec: balance $10,000, risk 1%, entry 4010, SL 4000 →
 * max risk $100. With XAUUSD reporting tickSize 0.01 / tickValueLoss $1 the
 * stop is 1000 ticks → $1000 loss per lot → 0.10 lots.
 */
export function calculateLotSize(input: LotSizingInput): LotSizingResult {
  const { symbol } = input;
  const warnings: string[] = [];
  const reasons: string[] = [];

  const balance = Number(input.balance);
  const riskPercent = Number(input.riskPercent);
  const entryPrice = Number(input.entryPrice);
  const stopLoss = Number(input.stopLoss);
  const takeProfit = input.takeProfit == null ? null : Number(input.takeProfit);

  const maxRiskAmount = round((balance * riskPercent) / 100, 2);
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const rewardDistance = takeProfit != null && Number.isFinite(takeProfit) ? Math.abs(takeProfit - entryPrice) : 0;

  const base: LotSizingResult = {
    status: 'invalid',
    reasons,
    maxRiskAmount,
    actualRiskAmount: 0,
    stopDistance: round(stopDistance, symbol.digits),
    stopDistancePoints: symbol.point > 0 ? round(stopDistance / symbol.point, 1) : 0,
    rewardDistance: round(rewardDistance, symbol.digits),
    rewardDistancePoints: symbol.point > 0 ? round(rewardDistance / symbol.point, 1) : 0,
    lossPerLot: 0,
    profitPerLot: 0,
    rawVolume: 0,
    volume: 0,
    units: 0,
    potentialLoss: 0,
    potentialProfit: 0,
    riskReward: null,
    estimatedMargin: 0,
    pipValue: 0,
    tickValueUsed: symbol.tickValueLoss,
    volumeStep: symbol.volumeStep,
    volumeMin: symbol.volumeMin,
    volumeMax: symbol.volumeMax,
    warnings,
  };

  if (!Number.isFinite(balance) || balance <= 0) {
    reasons.push('Account balance must be greater than zero.');
    return base;
  }
  if (!Number.isFinite(riskPercent) || riskPercent <= 0) {
    reasons.push('Risk % must be greater than zero.');
    return base;
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    reasons.push('Entry price is invalid.');
    return base;
  }
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    reasons.push('Stop Loss is required to calculate position size.');
    return base;
  }
  if (stopDistance <= 0) {
    reasons.push('Stop Loss must be different from the entry price.');
    return base;
  }

  const step = symbol.volumeStep > 0 ? symbol.volumeStep : 0.01;
  const volumeMin = symbol.volumeMin > 0 ? symbol.volumeMin : step;
  const volumeMax = symbol.volumeMax > 0 ? symbol.volumeMax : 100;

  const lossPerLot = valuePerPriceUnit(symbol, stopDistance);
  const profitPerLot = takeProfit != null ? profitPerPriceUnit(symbol, rewardDistance) : 0;

  base.lossPerLot = round(lossPerLot, 2);
  base.profitPerLot = round(profitPerLot, 2);
  base.pipValue = round(lossPerLot / Math.max(stopDistance / (symbol.point || 0.0001), 1e-9), 2);

  if (!Number.isFinite(lossPerLot) || lossPerLot <= 0) {
    reasons.push('Broker symbol specification does not provide a usable tick value.');
    return base;
  }

  const rawVolume = maxRiskAmount / lossPerLot;
  base.rawVolume = round(rawVolume, decimalsOfStep(step) + 2);

  let volume = normalizeVolume(rawVolume, step);
  let status: LotSizingResult['status'] = 'ok';

  if (volume < volumeMin) {
    // Refuse to silently over-risk: if even the minimum lot risks more than the
    // user's limit, report it and let the UI decide (default = refuse).
    const minRisk = volumeMin * lossPerLot;
    if (minRisk > maxRiskAmount) {
      base.volume = volumeMin;
      base.actualRiskAmount = round(minRisk, 2);
      base.units = round(volumeMin * symbol.contractSize, 2);
      base.status = 'invalid';
      reasons.push(
        `Minimum volume ${volumeMin} risks ${round(minRisk, 2)} which exceeds the ${round(maxRiskAmount, 2)} risk limit. Reduce risk % or widen the stop distance.`,
      );
      return base;
    }
    volume = volumeMin;
    status = 'clamped';
    warnings.push(`Volume raised to the broker minimum of ${volumeMin}.`);
  }

  const riskCapLots = input.maxLotSize && input.maxLotSize > 0 ? input.maxLotSize : volumeMax;
  const effectiveMax = Math.min(volumeMax, riskCapLots);
  if (volume > effectiveMax) {
    volume = normalizeVolume(effectiveMax, step);
    status = 'clamped';
    warnings.push(`Volume limited to ${volume} lots by the configured maximum lot size (${effectiveMax}).`);
  }

  const potentialLoss = volume * lossPerLot;
  const potentialProfit = takeProfit != null ? volume * profitPerLot : 0;

  base.status = status;
  base.volume = volume;
  base.units = round(volume * symbol.contractSize, 2);
  base.actualRiskAmount = round(potentialLoss, 2);
  base.potentialLoss = round(potentialLoss, 2);
  base.potentialProfit = round(potentialProfit, 2);
  base.riskReward = takeProfit != null && potentialLoss > 0 ? round(potentialProfit / potentialLoss, 2) : null;
  base.estimatedMargin = estimateMargin(symbol, volume, entryPrice, 100);
  return base;
}

/** Risk % actually taken if `volume` is used with this stop distance. */
export function riskPercentForVolume(
  volume: number,
  entryPrice: number,
  stopLoss: number,
  symbol: SymbolInfo,
  balance: number,
): number {
  if (balance <= 0) return 0;
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance <= 0) return 0;
  const loss = volume * valuePerPriceUnit(symbol, stopDistance);
  return round((loss / balance) * 100, 3);
}

/** Maximum volume that keeps the risk within `maxRiskPercent`. */
export function maxVolumeForRisk(
  balance: number,
  maxRiskPercent: number,
  entryPrice: number,
  stopLoss: number,
  symbol: SymbolInfo,
): number {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance <= 0 || balance <= 0) return 0;
  const lossPerLot = valuePerPriceUnit(symbol, stopDistance);
  if (lossPerLot <= 0) return 0;
  const step = symbol.volumeStep > 0 ? symbol.volumeStep : 0.01;
  return normalizeVolume((balance * maxRiskPercent) / 100 / lossPerLot, step);
}

/**
 * Profit/loss of an open position, computed the MT5 way.
 * BUY:  (current - open) / tickSize × tickValue × volume
 * SELL: (open - current) / tickSize × tickValue × volume
 * For an exact match with the terminal we prefer the broker-reported `profit`
 * when it is available (see the demo engine, which computes it itself).
 */
export function calculatePositionPl(
  side: OrderSide,
  openPrice: number,
  currentPrice: number,
  volume: number,
  symbol: SymbolInfo,
): number {
  const delta = side === 'BUY' ? currentPrice - openPrice : openPrice - currentPrice;
  const tickSize = symbol.tickSize > 0 ? symbol.tickSize : symbol.point;
  if (tickSize <= 0) return 0;
  const ticks = delta / tickSize;
  const tickValue = side === 'BUY' ? symbol.tickValueProfit : symbol.tickValueLoss;
  const effectiveTickValue = Number.isFinite(tickValue) && tickValue > 0 ? tickValue : symbol.tickValue;
  return round(ticks * (effectiveTickValue || 0) * volume, 2);
}

export function calculateRiskReward(
  entry: number,
  stopLoss: number,
  takeProfit: number,
): { riskDistance: number; rewardDistance: number; ratio: number | null } {
  const riskDistance = Math.abs(entry - stopLoss);
  const rewardDistance = Math.abs(takeProfit - entry);
  return {
    riskDistance: round(riskDistance, 8),
    rewardDistance: round(rewardDistance, 8),
    ratio: riskDistance > 0 ? round(rewardDistance / riskDistance, 2) : null,
  };
}

/** Breakeven price after costs, useful in the position panel tooltip. */
export function breakevenPrice(
  side: OrderSide,
  openPrice: number,
  volume: number,
  costs: number,
  symbol: SymbolInfo,
): number | null {
  if (volume <= 0) return null;
  const tickSize = symbol.tickSize > 0 ? symbol.tickSize : symbol.point;
  const tickValue = symbol.tickValue > 0 ? symbol.tickValue : symbol.tickValueProfit;
  if (tickSize <= 0 || tickValue <= 0) return null;
  const ticksRequired = -costs / (tickValue * volume);
  const priceDelta = ticksRequired * tickSize;
  return roundPrice(side === 'BUY' ? openPrice + priceDelta : openPrice - priceDelta, symbol.digits);
}

export { valuePerPriceUnit as lossValuePerPriceUnit, profitPerPriceUnit as profitValuePerPriceUnit };
