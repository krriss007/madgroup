/**
 * TradePilot — account service.
 *
 * Owns the two account kinds the platform supports:
 *
 *   DEMO — provisioned automatically with a virtual starting balance. The
 *          balance only moves because the demo engine filled/closed simulated
 *          trades. It is never presented as real money.
 *   LIVE — created and kept in sync from the user's own MT5 account through the
 *          EA (login/server/balance/equity/margin). No credentials are stored.
 */

import { ErrorCode, TradePilotError, round, type BrokerAccount, type TradingMode } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { BrokerAccountRow } from '../db/types';
import type { Env } from '../config/env';
import type { Logger } from '../lib/logger';
import { newId } from '../lib/ids';
import { DEFAULT_WATCHLIST } from '@tradepilot/shared';

export interface LiveAccountUpdate {
  login: string;
  server: string;
  currency: string;
  leverage: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  profit: number;
}

export class AccountService {
  constructor(
    private readonly store: Store,
    private readonly env: Env,
    private readonly logger: Logger,
  ) {}

  /** Create the demo account (idempotent) and its default watchlist. */
  async ensureDemoAccount(userId: string): Promise<BrokerAccountRow> {
    const existing = await this.store.brokerAccounts.findOne({ userId: { eq: userId }, mode: { eq: 'DEMO' } });
    if (existing) return existing;

    const now = new Date().toISOString();
    const row: BrokerAccountRow = {
      id: newId('acc'),
      userId,
      mode: 'DEMO',
      login: `DEMO-${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      server: 'TradePilot Demo Server',
      currency: 'USD',
      leverage: this.env.DEMO_LEVERAGE,
      balance: this.env.DEMO_STARTING_BALANCE,
      equity: this.env.DEMO_STARTING_BALANCE,
      margin: 0,
      freeMargin: this.env.DEMO_STARTING_BALANCE,
      marginLevel: null,
      profit: 0,
      startingBalance: this.env.DEMO_STARTING_BALANCE,
      isAuthorized: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      lastUpdate: now,
    };
    await this.store.brokerAccounts.insert(row);
    await this.ensureDefaultWatchlist(userId);
    this.logger.info({ userId, login: row.login }, 'demo account provisioned');
    return row;
  }

  async ensureDefaultWatchlist(userId: string): Promise<void> {
    const existing = await this.store.watchlists.findOne({ userId: { eq: userId }, isDefault: { eq: true } });
    if (existing) return;
    const now = new Date().toISOString();
    const watchlist = {
      id: newId('wl'),
      userId,
      name: 'Default watchlist',
      isDefault: true,
      createdAt: now,
    };
    await this.store.watchlists.insert(watchlist);
    let position = 0;
    for (const symbol of DEFAULT_WATCHLIST) {
      await this.store.watchlistItems.insert({
        id: newId('wli'),
        watchlistId: watchlist.id,
        userId,
        symbol,
        canonical: symbol,
        position: position++,
        createdAt: now,
      });
    }
  }

  /** Create or refresh the LIVE account row from EA-reported data. */
  async upsertLiveAccount(userId: string, update: LiveAccountUpdate): Promise<BrokerAccountRow> {
    const existing = await this.store.brokerAccounts.findOne({
      userId: { eq: userId },
      mode: { eq: 'LIVE' },
      login: { eq: update.login },
    });
    const now = new Date().toISOString();

    if (existing) {
      const updated = await this.store.brokerAccounts.update(existing.id, {
        server: update.server,
        currency: update.currency,
        leverage: update.leverage,
        balance: update.balance,
        equity: update.equity,
        margin: update.margin,
        freeMargin: update.freeMargin,
        marginLevel: update.marginLevel,
        profit: update.profit,
        lastUpdate: now,
        updatedAt: now,
      });
      return updated ?? existing;
    }

    const row: BrokerAccountRow = {
      id: newId('acc'),
      userId,
      mode: 'LIVE',
      login: update.login,
      server: update.server,
      currency: update.currency,
      leverage: update.leverage,
      balance: update.balance,
      equity: update.equity,
      margin: update.margin,
      freeMargin: update.freeMargin,
      marginLevel: update.marginLevel,
      profit: update.profit,
      startingBalance: update.balance,
      // A live account only becomes authorized once the EA has proven ownership
      // by reporting it (the device token lives inside the user's terminal).
      isAuthorized: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      lastUpdate: now,
    };
    await this.store.brokerAccounts.insert(row);
    this.logger.info({ userId, login: update.login, server: update.server }, 'live MT5 account linked');
    return row;
  }

  async getAccount(userId: string, mode: TradingMode): Promise<BrokerAccountRow | null> {
    return this.store.brokerAccounts.findOne({ userId: { eq: userId }, mode: { eq: mode } });
  }

  async getAccountById(userId: string, accountId: string): Promise<BrokerAccountRow | null> {
    const row = await this.store.brokerAccounts.findById(accountId);
    if (!row || row.userId !== userId) return null;
    return row;
  }

  async listAccounts(userId: string): Promise<BrokerAccountRow[]> {
    return this.store.brokerAccounts.findMany({ userId: { eq: userId } }, { orderBy: [{ field: 'createdAt', direction: 'asc' }] });
  }

  async requireAccount(userId: string, accountId: string): Promise<BrokerAccountRow> {
    const row = await this.getAccountById(userId, accountId);
    if (!row) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Account not found.', 404);
    return row;
  }

  async requireActiveAccount(userId: string, mode: TradingMode): Promise<BrokerAccountRow> {
    const row = await this.getAccount(userId, mode);
    if (!row) {
      if (mode === 'DEMO') return this.ensureDemoAccount(userId);
      throw new TradePilotError(
        ErrorCode.MT5_NOT_AUTHORIZED,
        'No authorized live MT5 account is linked yet. Connect the TradePilotBridge EA in Settings → MT5 Connection.',
        409,
      );
    }
    return row;
  }

  /** Demo engine bookkeeping: persist the recomputed account snapshot. */
  async updateSnapshot(
    accountId: string,
    patch: Partial<Pick<BrokerAccountRow, 'balance' | 'equity' | 'margin' | 'freeMargin' | 'marginLevel' | 'profit'>>,
  ): Promise<void> {
    await this.store.brokerAccounts.update(accountId, { ...patch, lastUpdate: new Date().toISOString() });
  }

  toDomain(row: BrokerAccountRow): BrokerAccount {
    return {
      id: row.id,
      userId: row.userId,
      mode: row.mode,
      login: row.login,
      server: row.server,
      currency: row.currency,
      leverage: row.leverage,
      balance: round(row.balance, 2),
      equity: round(row.equity, 2),
      margin: round(row.margin, 2),
      freeMargin: round(row.freeMargin, 2),
      marginLevel: row.marginLevel,
      profit: round(row.profit, 2),
      lastUpdate: row.lastUpdate,
      isAuthorized: row.isAuthorized,
    };
  }
}
