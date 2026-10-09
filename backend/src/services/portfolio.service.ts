/**
 * TradePilot — portfolio snapshots.
 *
 * A snapshot is a point-in-time copy of the account figures. Demo snapshots are
 * written by the demo engine every few seconds; live snapshots are written by
 * the bridge sync whenever the EA reports account data. Snapshots back the
 * equity curve and make long-term analysis possible without re-querying the
 * broker.
 */

import { round, type PortfolioSnapshot, type TradingMode } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { PortfolioSnapshotRow } from '../db/types';
import { newId } from '../lib/ids';

export interface SnapshotInput {
  userId: string;
  accountId: string;
  mode: TradingMode;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  openPl: number;
}

export class PortfolioService {
  constructor(
    private readonly store: Store,
    /** Minimum seconds between two snapshots for the same account. */
    private readonly minIntervalSeconds = 15,
  ) {}

  private lastSnapshotAt = new Map<string, number>();

  async record(input: SnapshotInput, now: Date = new Date()): Promise<PortfolioSnapshot | null> {
    const last = this.lastSnapshotAt.get(input.accountId) ?? 0;
    if (now.getTime() - last < this.minIntervalSeconds * 1000) return null;

    const row: PortfolioSnapshotRow = {
      id: newId('snp'),
      userId: input.userId,
      accountId: input.accountId,
      mode: input.mode,
      balance: round(input.balance, 2),
      equity: round(input.equity, 2),
      margin: round(input.margin, 2),
      freeMargin: round(input.freeMargin, 2),
      openPl: round(input.openPl, 2),
      time: now.toISOString(),
    };
    await this.store.portfolioSnapshots.insert(row);
    this.lastSnapshotAt.set(input.accountId, now.getTime());
    return this.toDomain(row);
  }

  async series(userId: string, accountId: string, limit = 1_000): Promise<PortfolioSnapshot[]> {
    const rows = await this.store.portfolioSnapshots.findMany(
      { userId: { eq: userId }, accountId: { eq: accountId } },
      { orderBy: [{ field: 'time', direction: 'asc' }], limit },
    );
    return rows.map((row) => this.toDomain(row));
  }

  async prune(accountId: string, keep = 5_000): Promise<number> {
    const rows = await this.store.portfolioSnapshots.findMany(
      { accountId: { eq: accountId } },
      { orderBy: [{ field: 'time', direction: 'desc' }] },
    );
    const excess = rows.slice(keep);
    for (const row of excess) await this.store.portfolioSnapshots.delete(row.id);
    return excess.length;
  }

  toDomain(row: PortfolioSnapshotRow): PortfolioSnapshot {
    return {
      id: row.id,
      accountId: row.accountId,
      mode: row.mode,
      balance: row.balance,
      equity: row.equity,
      margin: row.margin,
      freeMargin: row.freeMargin,
      openPl: row.openPl,
      time: row.time,
    };
  }
}
