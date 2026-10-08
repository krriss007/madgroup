/**
 * TradePilot — trade history & filtering.
 *
 * Reads from the `trades` table, which is written by the demo engine (simulated
 * fills) and by the live bridge sync (broker deals). The service never invents
 * a trade: an empty result means the account really has no closed trades yet.
 */

import { round, type TradeRecord, type TradingMode, type OrderSide } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { TradeRow } from '../db/types';

export type HistoryRange = 'today' | 'yesterday' | '7d' | '30d' | 'custom' | 'all';

export interface HistoryFilter {
  range?: HistoryRange;
  from?: string | null;
  to?: string | null;
  symbol?: string | null;
  side?: OrderSide | null;
  limit?: number;
  offset?: number;
}

export interface HistoryPage {
  trades: TradeRecord[];
  total: number;
  limit: number;
  offset: number;
  range: { from: string | null; to: string | null; label: HistoryRange };
  summary: {
    trades: number;
    grossProfit: number;
    netProfit: number;
    commission: number;
    swap: number;
    wins: number;
    losses: number;
    volume: number;
    winRate: number | null;
  };
}

export class HistoryService {
  constructor(private readonly store: Store) {}

  resolveRange(filter: HistoryFilter, now: Date = new Date()): { from: Date | null; to: Date | null; label: HistoryRange } {
    const startOfDay = (date: Date): Date => {
      const copy = new Date(date);
      copy.setUTCHours(0, 0, 0, 0);
      return copy;
    };

    switch (filter.range) {
      case 'today':
        return { from: startOfDay(now), to: null, label: 'today' };
      case 'yesterday': {
        const from = startOfDay(new Date(now.getTime() - 86_400_000));
        const to = startOfDay(now);
        return { from, to, label: 'yesterday' };
      }
      case '7d':
        return { from: new Date(now.getTime() - 7 * 86_400_000), to: null, label: '7d' };
      case '30d':
        return { from: new Date(now.getTime() - 30 * 86_400_000), to: null, label: '30d' };
      case 'custom':
        return {
          from: filter.from ? new Date(filter.from) : null,
          to: filter.to ? new Date(filter.to) : null,
          label: 'custom',
        };
      default:
        return { from: null, to: null, label: 'all' };
    }
  }

  async page(userId: string, accountId: string, filter: HistoryFilter = {}): Promise<HistoryPage> {
    const { from, to, label } = this.resolveRange(filter);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const rows = await this.store.trades.findMany(
      {
        userId: { eq: userId },
        accountId: { eq: accountId },
        ...(from ? { closeTime: { gte: from.toISOString(), ...(to ? { lt: to.toISOString() } : {}) } } : to ? { closeTime: { lt: to.toISOString() } } : {}),
        ...(filter.symbol ? { canonical: { eq: filter.symbol.toUpperCase() } } : {}),
        ...(filter.side ? { side: { eq: filter.side } } : {}),
      },
      { orderBy: [{ field: 'closeTime', direction: 'desc' }], limit, offset },
    );

    const all = await this.store.trades.findMany({
      userId: { eq: userId },
      accountId: { eq: accountId },
      ...(from ? { closeTime: { gte: from.toISOString() } } : {}),
      ...(filter.symbol ? { canonical: { eq: filter.symbol.toUpperCase() } } : {}),
      ...(filter.side ? { side: { eq: filter.side } } : {}),
    });

    const wins = all.filter((t) => t.netProfit > 0).length;
    const losses = all.filter((t) => t.netProfit < 0).length;

    return {
      trades: rows.map((row) => this.toDomain(row)),
      total: all.length,
      limit,
      offset,
      range: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, label },
      summary: {
        trades: all.length,
        grossProfit: round(all.reduce((acc, t) => acc + t.grossProfit, 0), 2),
        netProfit: round(all.reduce((acc, t) => acc + t.netProfit, 0), 2),
        commission: round(all.reduce((acc, t) => acc + t.commission, 0), 2),
        swap: round(all.reduce((acc, t) => acc + t.swap, 0), 2),
        wins,
        losses,
        volume: round(all.reduce((acc, t) => acc + t.volume, 0), 2),
        winRate: all.length ? round((wins / all.length) * 100, 2) : null,
      },
    };
  }

  async recent(userId: string, accountId: string, limit = 20): Promise<TradeRecord[]> {
    const rows = await this.store.trades.findMany(
      { userId: { eq: userId }, accountId: { eq: accountId } },
      { orderBy: [{ field: 'closeTime', direction: 'desc' }], limit },
    );
    return rows.map((row) => this.toDomain(row));
  }

  async all(userId: string, accountId: string, mode?: TradingMode): Promise<TradeRecord[]> {
    const rows = await this.store.trades.findMany({
      userId: { eq: userId },
      accountId: { eq: accountId },
      ...(mode ? { mode: { eq: mode } } : {}),
    });
    return rows.map((row) => this.toDomain(row));
  }

  async exportCsv(userId: string, accountId: string, filter: HistoryFilter = {}): Promise<string> {
    const page = await this.page(userId, accountId, { ...filter, limit: 500, offset: 0 });
    const header = [
      'ticket',
      'symbol',
      'direction',
      'volume',
      'entry',
      'exit',
      'sl',
      'tp',
      'commission',
      'swap',
      'gross_profit',
      'net_profit',
      'open_time',
      'close_time',
      'duration_seconds',
      'mode',
      'source',
    ];
    const lines = page.trades.map((t) =>
      [
        t.ticket,
        t.canonical,
        t.side,
        t.volume,
        t.entryPrice,
        t.exitPrice,
        t.stopLoss ?? '',
        t.takeProfit ?? '',
        t.commission,
        t.swap,
        t.grossProfit,
        t.netProfit,
        t.openTime,
        t.closeTime,
        t.durationSeconds,
        t.mode,
        t.source,
      ].join(','),
    );
    return [header.join(','), ...lines].join('\n');
  }

  toDomain(row: TradeRow): TradeRecord {
    return {
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
    };
  }
}
