/**
 * TradePilot — technical indicators.
 *
 * Implemented locally (no third-party TA dependency) so the same numbers can be
 * reproduced in tests, in the strategy engine and, if needed, inside MQL5.
 * Every function returns `null` for indices that do not have enough history,
 * and every array is aligned index-for-index with the input prices.
 */

import type { Candle } from '../types/domain';

export interface IndicatorPoint {
  /** unix seconds, aligned with the candle open time */
  time: number;
  value: number;
}

export interface LineSeries {
  id: string;
  label: string;
  color: string;
  points: IndicatorPoint[];
  /** overlay = drawn on the price pane, otherwise a separate study pane */
  overlay: boolean;
}

function nulls(length: number): (number | null)[] {
  return new Array<number | null>(length).fill(null);
}

/** Simple moving average. */
export function sma(values: number[], period: number): (number | null)[] {
  const out = nulls(values.length);
  if (period <= 0) return out;
  let running = 0;
  for (let i = 0; i < values.length; i += 1) {
    running += values[i];
    if (i >= period) running -= values[i - period];
    if (i >= period - 1) out[i] = running / period;
  }
  return out;
}

/** Exponential moving average seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): (number | null)[] {
  const out = nulls(values.length);
  if (period <= 0 || values.length < period) return out;
  const multiplier = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let previous = seed / period;
  out[period - 1] = previous;
  for (let i = period; i < values.length; i += 1) {
    previous = (values[i] - previous) * multiplier + previous;
    out[i] = previous;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out = nulls(values.length);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine = nulls(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const f = fastEma[i];
    const s = slowEma[i];
    if (f != null && s != null) macdLine[i] = f - s;
  }
  const firstDefined = macdLine.findIndex((v) => v != null);
  const signal = nulls(values.length);
  const histogram = nulls(values.length);
  if (firstDefined >= 0) {
    const compact = macdLine.slice(firstDefined).map((v) => v ?? 0);
    const signalCompact = ema(compact, signalPeriod);
    for (let i = 0; i < signalCompact.length; i += 1) {
      const value = signalCompact[i];
      const index = firstDefined + i;
      if (value != null) {
        signal[index] = value;
        histogram[index] = (macdLine[index] ?? 0) - value;
      }
    }
  }
  return { macd: macdLine, signal, histogram };
}

export interface StochasticResult {
  k: (number | null)[];
  d: (number | null)[];
}

export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3, slowing = 3): StochasticResult {
  const rawK = nulls(candles.length);
  for (let i = kPeriod - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...window.map((c) => c.high));
    const lowest = Math.min(...window.map((c) => c.low));
    const close = candles[i].close;
    rawK[i] = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
  }
  const k = nulls(candles.length);
  for (let i = 0; i < candles.length; i += 1) {
    const window = rawK.slice(Math.max(0, i - slowing + 1), i + 1).filter((v): v is number => v != null);
    if (window.length === slowing) k[i] = window.reduce((a, b) => a + b, 0) / window.length;
  }
  const dValues: number[] = [];
  const dIndex: number[] = [];
  k.forEach((value, index) => {
    if (value != null) {
      dValues.push(value);
      dIndex.push(index);
    }
  });
  const dCompact = sma(dValues, dPeriod);
  const d = nulls(candles.length);
  dCompact.forEach((value, i) => {
    if (value != null) d[dIndex[i]] = value;
  });
  return { k, d };
}

export interface BollingerResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

export function bollinger(values: number[], period = 20, deviation = 2): BollingerResult {
  const middle = sma(values, period);
  const upper = nulls(values.length);
  const lower = nulls(values.length);
  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = middle[i];
    if (mean == null) continue;
    const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = mean + deviation * std;
    lower[i] = mean - deviation * std;
  }
  return { upper, middle, lower };
}

/** Average True Range (Wilder smoothing). */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const out = nulls(candles.length);
  if (candles.length <= period) return out;
  const trs: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i += 1) {
    const previousClose = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - previousClose),
      Math.abs(candles[i].low - previousClose),
    );
    trs.push(tr);
  }
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += trs[i];
  let previous = sum / period;
  out[period - 1] = previous;
  for (let i = period; i < candles.length; i += 1) {
    previous = (previous * (period - 1) + trs[i]) / period;
    out[i] = previous;
  }
  return out;
}

export function toLineSeries(
  id: string,
  label: string,
  color: string,
  points: (number | null)[],
  candles: Candle[],
  overlay: boolean,
): LineSeries {
  const out: IndicatorPoint[] = [];
  const length = Math.min(points.length, candles.length);
  for (let i = 0; i < length; i += 1) {
    const value = points[i];
    if (value != null && Number.isFinite(value)) out.push({ time: candles[i].time, value });
  }
  return { id, label, color, points: out, overlay };
}

export const EMA_COLORS: Record<number, string> = {
  9: '#38bdf8',
  20: '#a78bfa',
  50: '#f59e0b',
  100: '#22d3ee',
  200: '#f472b6',
};

export interface IndicatorConfig {
  ema: number[];
  rsi: { enabled: boolean; period: number };
  macd: { enabled: boolean; fast: number; slow: number; signal: number };
  stochastic: { enabled: boolean; k: number; d: number };
  bollinger: { enabled: boolean; period: number; deviation: number };
  atr: { enabled: boolean; period: number };
}

export const DEFAULT_INDICATORS: IndicatorConfig = {
  ema: [],
  rsi: { enabled: false, period: 14 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
  stochastic: { enabled: false, k: 14, d: 3 },
  bollinger: { enabled: false, period: 20, deviation: 2 },
  atr: { enabled: false, period: 14 },
};

export type IndicatorId = 'EMA9' | 'EMA20' | 'EMA50' | 'EMA100' | 'EMA200' | 'RSI' | 'MACD' | 'STOCH' | 'BB' | 'ATR';

export const INDICATOR_CATALOG: { id: IndicatorId; label: string; pane: 'price' | 'separate'; description: string }[] = [
  { id: 'EMA9', label: 'EMA 9', pane: 'price', description: 'Fast exponential moving average' },
  { id: 'EMA20', label: 'EMA 20', pane: 'price', description: 'Short-term trend' },
  { id: 'EMA50', label: 'EMA 50', pane: 'price', description: 'Medium-term trend' },
  { id: 'EMA100', label: 'EMA 100', pane: 'price', description: 'Long-term trend' },
  { id: 'EMA200', label: 'EMA 200', pane: 'price', description: 'Primary trend filter' },
  { id: 'BB', label: 'Bollinger Bands', pane: 'price', description: 'Volatility envelope (20, 2σ)' },
  { id: 'RSI', label: 'RSI', pane: 'separate', description: 'Relative Strength Index (14)' },
  { id: 'MACD', label: 'MACD', pane: 'separate', description: 'MACD (12, 26, 9)' },
  { id: 'STOCH', label: 'Stochastic', pane: 'separate', description: 'Stochastic oscillator (14, 3, 3)' },
  { id: 'ATR', label: 'ATR', pane: 'separate', description: 'Average True Range (14)' },
];

export interface IndicatorComputation {
  overlays: LineSeries[];
  panes: { id: IndicatorId; label: string; lines: LineSeries[]; histogram?: LineSeries[]; referenceLines?: number[]; range?: { min: number; max: number } }[];
  atrValue: number | null;
}

/** Compute every enabled indicator for a candle series. */
export function computeIndicators(candles: Candle[], config: IndicatorConfig): IndicatorComputation {
  const closes = candles.map((c) => c.close);
  const overlays: LineSeries[] = [];
  const panes: IndicatorComputation['panes'] = [];

  for (const period of config.ema) {
    overlays.push(
      toLineSeries(`ema-${period}`, `EMA ${period}`, EMA_COLORS[period] ?? '#94a3b8', ema(closes, period), candles, true),
    );
  }

  if (config.bollinger.enabled) {
    const bb = bollinger(closes, config.bollinger.period, config.bollinger.deviation);
    overlays.push(toLineSeries('bb-upper', 'BB Upper', '#64748b', bb.upper, candles, true));
    overlays.push(toLineSeries('bb-middle', 'BB Basis', '#94a3b8', bb.middle, candles, true));
    overlays.push(toLineSeries('bb-lower', 'BB Lower', '#64748b', bb.lower, candles, true));
  }

  if (config.rsi.enabled) {
    panes.push({
      id: 'RSI',
      label: `RSI ${config.rsi.period}`,
      lines: [toLineSeries('rsi', 'RSI', '#c084fc', rsi(closes, config.rsi.period), candles, false)],
      referenceLines: [30, 50, 70],
      range: { min: 0, max: 100 },
    });
  }

  if (config.macd.enabled) {
    const result = macd(closes, config.macd.fast, config.macd.slow, config.macd.signal);
    panes.push({
      id: 'MACD',
      label: `MACD ${config.macd.fast},${config.macd.slow},${config.macd.signal}`,
      lines: [
        toLineSeries('macd-line', 'MACD', '#38bdf8', result.macd, candles, false),
        toLineSeries('macd-signal', 'Signal', '#f97316', result.signal, candles, false),
      ],
      histogram: [toLineSeries('macd-hist', 'Histogram', '#22c55e', result.histogram, candles, false)],
      referenceLines: [0],
    });
  }

  if (config.stochastic.enabled) {
    const result = stochastic(candles, config.stochastic.k, config.stochastic.d);
    panes.push({
      id: 'STOCH',
      label: `Stochastic ${config.stochastic.k},${config.stochastic.d}`,
      lines: [
        toLineSeries('stoch-k', '%K', '#38bdf8', result.k, candles, false),
        toLineSeries('stoch-d', '%D', '#f97316', result.d, candles, false),
      ],
      referenceLines: [20, 50, 80],
      range: { min: 0, max: 100 },
    });
  }

  let atrValue: number | null = null;
  if (config.atr.enabled) {
    const series = atr(candles, config.atr.period);
    panes.push({
      id: 'ATR',
      label: `ATR ${config.atr.period}`,
      lines: [toLineSeries('atr', 'ATR', '#facc15', series, candles, false)],
    });
    const last = [...series].reverse().find((v) => v != null);
    atrValue = last ?? null;
  }

  return { overlays, panes, atrValue };
}
