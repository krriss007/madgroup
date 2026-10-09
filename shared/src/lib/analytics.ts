/**
 * TradePilot — portfolio analytics.
 *
 * Everything here is derived from actual recorded trades and account snapshots.
 * When there is no data the UI is told `hasData: false` instead of being shown
 * invented statistics, and every payload carries a disclaimer.
 */

import { round, sum } from './math';
import { dayKey, monthKey } from './time';
import type { AnalyticsSummary, PortfolioSnapshot, TradeRecord, TradingMode } from '../types/domain';

export const ANALYTICS_DISCLAIMER =
  'Statistics are calculated only from trades recorded by this account. Past performance does not indicate future results.';

export interface DrawdownResult {
  maxDrawdown: number;
  maxDrawdownPercent: number;
  peak: number;
  trough: number;
}

/** Max peak-to-trough decline of a balance/equity curve. */
export function computeMaxDrawdown(curve: number[]): DrawdownResult {
  if (!curve.length) return { maxDrawdown: 0, maxDrawdownPercent: 0, peak: 0, trough: 0 };
  let peak = curve[0];
  let trough = curve[0];
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  for (const value of curve) {
    if (value > peak) peak = value;
    const drawdown = peak - value;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
      trough = value;
    }
  }
  return {
    maxDrawdown: round(maxDrawdown, 2),
    maxDrawdownPercent: round(maxDrawdownPercent, 2),
    peak: round(peak, 2),
    trough: round(trough, 2),
  };
}

export function computeProfitFactor(grossProfit: number, grossLoss: number): number | null {
  if (grossLoss <= 0) return grossProfit > 0 ? null : 0; // null = infinite (no losing trades yet)
  return round(grossProfit / grossLoss, 2);
}

export interface AnalyticsInput {
  mode: TradingMode;
  trades: TradeRecord[];
  snapshots?: PortfolioSnapshot[];
  startingBalance?: number;
  currentBalance?: number;
  currentEquity?: number;
}

const BUCKET_EDGES = [
  { label: '< -$500', min: -Infinity, max: -500 },
  { label: '-$500..-$101', min: -500, max: -100.000001 },
  { label: '-$100..-$1', min: -100, max: -1 },
  { label: '-$1..$1', min: -1, max: 1 },
  { label: '$1..$100', min: 1, max: 100 },
  { label: '$100..$500', min: 100, max: 500 },
  { label: '> $500', min: 500, max: Infinity },
];

export function buildAnalytics(input: AnalyticsInput): AnalyticsSummary {
  const trades = [...input.trades].sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
  const empty: AnalyticsSummary = {
    mode: input.mode,
    hasData: trades.length > 0 || (input.snapshots?.length ?? 0) > 0,
    totalTrades: trades.length,
    wins: 0,
    losses: 0,
    breakEven: 0,
    winRate: null,
    grossProfit: 0,
    grossLoss: 0,
    netProfit: 0,
    averageWin: null,
    averageLoss: null,
    profitFactor: null,
    expectancy: null,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    largestWin: null,
    largestLoss: null,
    totalCommission: 0,
    totalSwap: 0,
    averageDurationSeconds: null,
    equityCurve: [],
    dailyPl: [],
    monthlyPl: [],
    distribution: {
      buckets: BUCKET_EDGES.map((b) => ({ label: b.label, count: 0 })),
      winLoss: { wins: 0, losses: 0, breakEven: 0 },
    },
    bySymbol: [],
    disclaimer: ANALYTICS_DISCLAIMER,
  };

  if (!trades.length) {
    // Still expose the snapshot-derived equity curve when trades have not been
    // recorded yet (e.g. a freshly connected live account).
    empty.equityCurve = (input.snapshots ?? []).map((s) => ({ time: s.time, balance: s.balance, equity: s.equity }));
    if (empty.equityCurve.length) {
      const dd = computeMaxDrawdown(empty.equityCurve.map((p) => p.equity));
      empty.maxDrawdown = dd.maxDrawdown;
      empty.maxDrawdownPercent = dd.maxDrawdownPercent;
    }
    return empty;
  }

  const wins = trades.filter((t) => t.netProfit > 0);
  const losses = trades.filter((t) => t.netProfit < 0);
  const breakEven = trades.filter((t) => t.netProfit === 0);

  const grossProfit = round(sum(wins.map((t) => t.netProfit)), 2);
  const grossLossAbs = round(Math.abs(sum(losses.map((t) => t.netProfit))), 2);
  const netProfit = round(sum(trades.map((t) => t.netProfit)), 2);

  const startBalance = input.startingBalance ?? (input.currentBalance != null ? input.currentBalance - netProfit : 0);
  let running = startBalance;
  const equityCurve: AnalyticsSummary['equityCurve'] = [{ time: trades[0].openTime, balance: round(running, 2), equity: round(running, 2) }];
  for (const trade of trades) {
    running = round(running + trade.netProfit, 2);
    equityCurve.push({ time: trade.closeTime, balance: round(running, 2), equity: round(running, 2) });
  }
  if (input.snapshots?.length) {
    const lastTradeTime = Date.parse(trades[trades.length - 1].closeTime);
    const recent = input.snapshots.filter((s) => Date.parse(s.time) > lastTradeTime);
    for (const snapshot of recent.slice(-500)) {
      equityCurve.push({ time: snapshot.time, balance: snapshot.balance, equity: snapshot.equity });
    }
  }

  const drawdown = computeMaxDrawdown(equityCurve.map((p) => p.equity));

  const dailyMap = new Map<string, { pl: number; trades: number }>();
  const monthlyMap = new Map<string, { pl: number; trades: number }>();
  for (const trade of trades) {
    const date = new Date(trade.closeTime);
    const dk = dayKey(date);
    const mk = monthKey(date);
    const day = dailyMap.get(dk) ?? { pl: 0, trades: 0 };
    day.pl = round(day.pl + trade.netProfit, 2);
    day.trades += 1;
    dailyMap.set(dk, day);
    const month = monthlyMap.get(mk) ?? { pl: 0, trades: 0 };
    month.pl = round(month.pl + trade.netProfit, 2);
    month.trades += 1;
    monthlyMap.set(mk, month);
  }

  const buckets = BUCKET_EDGES.map((bucket) => ({
    label: bucket.label,
    count: trades.filter((t) => t.netProfit >= bucket.min && t.netProfit < bucket.max).length,
  }));

  const symbolMap = new Map<string, { trades: number; netProfit: number; wins: number }>();
  for (const trade of trades) {
    const entry = symbolMap.get(trade.canonical) ?? { trades: 0, netProfit: 0, wins: 0 };
    entry.trades += 1;
    entry.netProfit = round(entry.netProfit + trade.netProfit, 2);
    if (trade.netProfit > 0) entry.wins += 1;
    symbolMap.set(trade.canonical, entry);
  }

  return {
    ...empty,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakEven: breakEven.length,
    winRate: trades.length ? round((wins.length / trades.length) * 100, 2) : null,
    grossProfit,
    grossLoss: grossLossAbs,
    netProfit,
    averageWin: wins.length ? round(grossProfit / wins.length, 2) : null,
    averageLoss: losses.length ? round(grossLossAbs / losses.length, 2) : null,
    profitFactor: computeProfitFactor(grossProfit, grossLossAbs),
    expectancy: round(netProfit / trades.length, 2),
    maxDrawdown: drawdown.maxDrawdown,
    maxDrawdownPercent: drawdown.maxDrawdownPercent,
    largestWin: wins.length ? round(Math.max(...wins.map((t) => t.netProfit)), 2) : null,
    largestLoss: losses.length ? round(Math.min(...losses.map((t) => t.netProfit)), 2) : null,
    totalCommission: round(sum(trades.map((t) => t.commission)), 2),
    totalSwap: round(sum(trades.map((t) => t.swap)), 2),
    averageDurationSeconds: round(sum(trades.map((t) => t.durationSeconds)) / trades.length, 0),
    equityCurve,
    dailyPl: [...dailyMap.entries()].map(([date, v]) => ({ date, pl: v.pl, trades: v.trades })).sort((a, b) => a.date.localeCompare(b.date)),
    monthlyPl: [...monthlyMap.entries()].map(([month, v]) => ({ month, pl: v.pl, trades: v.trades })).sort((a, b) => a.month.localeCompare(b.month)),
    distribution: {
      buckets,
      winLoss: { wins: wins.length, losses: losses.length, breakEven: breakEven.length },
    },
    bySymbol: [...symbolMap.entries()]
      .map(([symbol, v]) => ({
        symbol,
        trades: v.trades,
        netProfit: v.netProfit,
        winRate: v.trades ? round((v.wins / v.trades) * 100, 2) : null,
      }))
      .sort((a, b) => b.netProfit - a.netProfit),
  };
}
