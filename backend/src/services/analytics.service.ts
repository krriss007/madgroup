/**
 * TradePilot — portfolio analytics.
 *
 * Aggregates recorded trades and account snapshots into the metrics shown on
 * the Analytics page. Nothing is simulated: with no trades the response carries
 * `hasData: false` and the UI prints "no data recorded yet" instead of numbers.
 */

import { buildAnalytics, round, type AnalyticsSummary, type TradingMode } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { PortfolioSnapshotRow, TradeRow } from '../db/types';

export interface AnalyticsOptions {
  mode: TradingMode;
  accountId: string;
  userId: string;
  startingBalance: number;
  currentBalance: number;
  currentEquity: number;
  from?: Date | null;
  to?: Date | null;
}

export class AnalyticsService {
  constructor(private readonly store: Store) {}

  async summary(options: AnalyticsOptions): Promise<AnalyticsSummary> {
    const trades = await this.store.trades.findMany({
      userId: { eq: options.userId },
      accountId: { eq: options.accountId },
      ...(options.from ? { closeTime: { gte: options.from.toISOString() } } : {}),
      ...(options.to ? { closeTime: { lte: options.to.toISOString() } } : {}),
    });

    const snapshots = await this.store.portfolioSnapshots.findMany(
      { accountId: { eq: options.accountId } },
      { orderBy: [{ field: 'time', direction: 'asc' }], limit: 5_000 },
    );

    return buildAnalytics({
      mode: options.mode,
      trades: trades.map((row: TradeRow) => ({
        id: row.id,
        accountId: row.accountId,
        mode: row.mode,
        ticket: row.ticket,
        dealTicket: row.dealTicket,
        symbol: row.symbol,
        canonical: row.canonical,
        side: row.side,
        volume: row.volume,
        entryPrice: row.entryPrice,
        exitPrice: row.exitPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        commission: row.commission,
        swap: row.swap,
        grossProfit: row.grossProfit,
        netProfit: row.netProfit,
        openTime: row.openTime,
        closeTime: row.closeTime,
        durationSeconds: row.durationSeconds,
        magic: row.magic,
        comment: row.comment,
        origin: row.origin,
        strategyId: row.strategyId,
        accountLogin: row.accountLogin,
        source: row.source,
      })),
      snapshots: snapshots.map((row: PortfolioSnapshotRow) => ({
        id: row.id,
        accountId: row.accountId,
        mode: row.mode,
        balance: row.balance,
        equity: row.equity,
        margin: row.margin,
        freeMargin: row.freeMargin,
        openPl: row.openPl,
        time: row.time,
      })),
      startingBalance: options.startingBalance,
      currentBalance: options.currentBalance,
      currentEquity: options.currentEquity,
    });
  }

  /** Compact live figures for the dashboard header cards. */
  async headline(userId: string, accountId: string, balance: number, equity: number): Promise<{
    balance: number;
    equity: number;
    openPl: number;
    dayPl: number;
    weekPl: number;
    monthPl: number;
    totalPl: number;
    totalTrades: number;
    winRate: number | null;
    profitFactor: number | null;
  }> {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setUTCHours(0, 0, 0, 0);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

    const trades = await this.store.trades.findMany({ userId: { eq: userId }, accountId: { eq: accountId } });
    const sum = (rows: TradeRow[]): number => round(rows.reduce((acc, t) => acc + t.netProfit, 0), 2);
    const wins = trades.filter((t) => t.netProfit > 0);
    const grossProfit = round(wins.reduce((acc, t) => acc + t.netProfit, 0), 2);
    const grossLoss = round(Math.abs(trades.filter((t) => t.netProfit < 0).reduce((acc, t) => acc + t.netProfit, 0)), 2);

    return {
      balance: round(balance, 2),
      equity: round(equity, 2),
      openPl: round(equity - balance, 2),
      dayPl: sum(trades.filter((t) => Date.parse(t.closeTime) >= startOfToday.getTime())),
      weekPl: sum(trades.filter((t) => Date.parse(t.closeTime) >= weekAgo.getTime())),
      monthPl: sum(trades.filter((t) => Date.parse(t.closeTime) >= monthAgo.getTime())),
      totalPl: sum(trades),
      totalTrades: trades.length,
      winRate: trades.length ? round((wins.length / trades.length) * 100, 2) : null,
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : null,
    };
  }
}
