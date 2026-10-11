import type { Bar, StrategyId } from '../../shared/types';
import { atr, ema, rsi } from './indicators';

export type Direction = 'buy' | 'sell' | 'hold';

export interface Signal {
  direction: Direction;
  reason: string;
  /** ATR(14) at the last closed bar. Used for stop/target distances. */
  atr: number;
  close: number;
}

export const MIN_BARS = 40;

/** Trend-following: EMA(9) crossing EMA(21). */
export function emaCross(bars: Bar[]): { direction: Direction; reason: string } {
  const closes = bars.map((b) => b.c);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const i = bars.length - 1;
  if (fast[i - 1]! <= slow[i - 1]! && fast[i]! > slow[i]!) return { direction: 'buy', reason: 'EMA9 crossed above EMA21' };
  if (fast[i - 1]! >= slow[i - 1]! && fast[i]! < slow[i]!) return { direction: 'sell', reason: 'EMA9 crossed below EMA21' };
  return { direction: 'hold', reason: 'No EMA crossover' };
}

/** Mean-reversion: RSI(14) leaving oversold / overbought territory. */
export function rsiReversion(bars: Bar[]): { direction: Direction; reason: string } {
  const r = rsi(bars.map((b) => b.c), 14);
  const i = bars.length - 1;
  const prev = r[i - 1]!;
  const cur = r[i]!;
  if (prev < 30 && cur >= 30) return { direction: 'buy', reason: `RSI recovered from oversold (${cur.toFixed(1)})` };
  if (prev > 70 && cur <= 70) return { direction: 'sell', reason: `RSI fell from overbought (${cur.toFixed(1)})` };
  return { direction: 'hold', reason: `RSI ${cur.toFixed(1)}, no extreme reversal` };
}

/** Breakout: close beyond the 20-bar high/low of the bars before it. */
export function breakout(bars: Bar[], lookback = 20): { direction: Direction; reason: string } {
  const i = bars.length - 1;
  const window = bars.slice(i - lookback, i);
  const hi = Math.max(...window.map((b) => b.h));
  const lo = Math.min(...window.map((b) => b.l));
  const close = bars[i]!.c;
  if (close > hi) return { direction: 'buy', reason: `Closed above ${lookback}-bar high` };
  if (close < lo) return { direction: 'sell', reason: `Closed below ${lookback}-bar low` };
  return { direction: 'hold', reason: `Inside ${lookback}-bar range` };
}

/** Majority vote of the three strategies (needs 2 agreeing and none opposing). */
export function consensus(bars: Bar[]): { direction: Direction; reason: string } {
  const votes = [
    { name: 'EMA cross', ...emaCross(bars) },
    { name: 'RSI', ...rsiReversion(bars) },
    { name: 'Breakout', ...breakout(bars) },
  ];
  const buys = votes.filter((v) => v.direction === 'buy');
  const sells = votes.filter((v) => v.direction === 'sell');
  if (buys.length >= 2 && sells.length === 0) {
    return { direction: 'buy', reason: `Consensus buy: ${buys.map((v) => v.name).join(' + ')}` };
  }
  if (sells.length >= 2 && buys.length === 0) {
    return { direction: 'sell', reason: `Consensus sell: ${sells.map((v) => v.name).join(' + ')}` };
  }
  return { direction: 'hold', reason: `No consensus (${votes.map((v) => `${v.name}: ${v.direction}`).join(', ')})` };
}

/**
 * Evaluate a strategy on CLOSED bars only (the forming bar must be excluded by the caller).
 */
export function computeSignal(strategy: StrategyId, closedBars: Bar[]): Signal | null {
  if (closedBars.length < MIN_BARS) return null;
  const strategies: Record<StrategyId, (b: Bar[]) => { direction: Direction; reason: string }> = {
    ema_cross: emaCross,
    rsi_reversion: rsiReversion,
    breakout,
    consensus,
  };
  const result = strategies[strategy](closedBars);
  const a = atr(closedBars, 14);
  const last = closedBars[closedBars.length - 1]!;
  return { ...result, atr: a[a.length - 1]!, close: last.c };
}
