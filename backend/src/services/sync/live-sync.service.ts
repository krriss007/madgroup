/**
 * TradePilot — LIVE account synchronisation.
 *
 * The MT5 terminal is the source of truth for live accounts. This service asks
 * the EA for the account, positions, pending orders and deal history, then
 * mirrors that state into the database so the terminal UI, risk engine,
 * analytics and journal can work from one place — without ever becoming an
 * authority over the broker.
 *
 * Rule: mirrored data is always labelled `source: 'MT5'`. Nothing is created
 * that the broker did not report.
 */

import { round, type Position, type PendingOrder, type TradingMode } from '@tradepilot/shared';
import type { Store } from '../../db/types';
import type { BrokerAccountRow, Mt5ConnectionRow, PositionRow, TradeRow } from '../../db/types';
import type { Logger } from '../../lib/logger';
import type { RealtimePublisher } from '../../ws/publisher';
import type { DeviceService } from '../bridge/device.service';
import type { MT5BrokerBridge } from '../broker/mt5-broker-bridge';
import type { PortfolioService } from '../portfolio.service';
import type { NotificationService } from '../notification.service';
import type { AuditService } from '../audit.service';
import { newId } from '../../lib/ids';

export interface LiveSyncDeps {
  store: Store;
  devices: DeviceService;
  logger: Logger;
  publisher: RealtimePublisher;
  portfolio: PortfolioService;
  notifications: NotificationService;
  audit: AuditService;
  /** Build the bridge for an account (provided by the broker registry). */
  bridgeFactory: (userId: string, account: BrokerAccountRow, connection: Mt5ConnectionRow) => MT5BrokerBridge;
  intervalMs?: number;
}

export class LiveSyncService {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private readonly locking = new Set<string>();

  constructor(private readonly deps: LiveSyncDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 5_000;
    this.timer = setInterval(() => void this.syncAll(), interval);
    this.timer.unref?.();
    this.deps.logger.info({ interval }, 'live account sync started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async syncAll(): Promise<void> {
    const accounts = await this.deps.store.brokerAccounts.findMany({ mode: { eq: 'LIVE' } });
    for (const account of accounts) {
      const connection = await this.deps.devices.connectionForAccount(account.id);
      if (!connection || !this.deps.devices.isOnline(connection)) continue;
      await this.syncAccount(account.userId, account, connection);
    }
  }

  /** Sync one live account. Errors are logged, never thrown at the caller. */
  async syncAccount(userId: string, account: BrokerAccountRow, connection: Mt5ConnectionRow): Promise<void> {
    if (this.inFlight.has(account.id)) return;
    if (!this.deps.devices.isOnline(connection)) return;
    this.inFlight.add(account.id);
    try {
      const broker = this.deps.bridgeFactory(userId, account, connection);

      // 1. Account ---------------------------------------------------------
      const snapshot = await broker.getAccount();
      await this.deps.store.brokerAccounts.update(account.id, {
        login: snapshot.login,
        server: snapshot.server,
        currency: snapshot.currency,
        leverage: snapshot.leverage,
        balance: snapshot.balance,
        equity: snapshot.equity,
        margin: snapshot.margin,
        freeMargin: snapshot.freeMargin,
        marginLevel: snapshot.marginLevel,
        profit: snapshot.profit,
        lastUpdate: snapshot.lastUpdate,
      });
      this.deps.publisher.toUser(userId, {
        type: 'account',
        account: snapshot,
        risk: await this.riskFor(userId, { ...account, ...snapshot }),
      });
      await this.deps.portfolio.record({
        userId,
        accountId: account.id,
        mode: 'LIVE',
        balance: snapshot.balance,
        equity: snapshot.equity,
        margin: snapshot.margin,
        freeMargin: snapshot.freeMargin,
        openPl: round(snapshot.equity - snapshot.balance, 2),
      });

      // 2. Positions -------------------------------------------------------
      const positions = await broker.getPositions();
      await this.mirrorPositions(userId, account, positions);
      this.deps.publisher.toUser(userId, { type: 'positions', mode: 'LIVE', positions });

      // 3. Pending orders --------------------------------------------------
      const orders = await broker.getOrders();
      await this.mirrorOrders(userId, account, orders);
      this.deps.publisher.toUser(userId, { type: 'orders', mode: 'LIVE', orders });

      // 4. Closed trades ---------------------------------------------------
      const from = new Date(Date.now() - 7 * 86_400_000);
      const trades = await broker.getHistory(from, new Date());
      await this.mirrorTrades(userId, account, trades);
    } catch (error) {
      this.deps.logger.warn(
        { accountId: account.id, error: (error as Error).message },
        'live sync failed for this cycle (will retry)',
      );
    } finally {
      this.inFlight.delete(account.id);
    }
  }

  private async riskFor(userId: string, account: BrokerAccountRow) {
    const user = await this.deps.store.users.findById(userId);
    // Lazy import avoids a circular dependency with the risk service.
    const { RiskService } = await import('../risk.service');
    const risk = new RiskService(this.deps.store, this.deps.logger);
    const connection = await this.deps.devices.connectionForAccount(account.id);
    return risk.computeStatus(userId, account, {
      liveTradingEnabled: Boolean(user?.liveTradingEnabled),
      brokerOnline: this.deps.devices.isOnline(connection),
      killSwitchEngaged: Boolean(user?.killSwitchEngaged),
    });
  }

  private async mirrorPositions(userId: string, account: BrokerAccountRow, positions: Position[]): Promise<void> {
    const existing = await this.deps.store.positions.findMany({ accountId: { eq: account.id } });
    const seen = new Set<string>();
    for (const position of positions) {
      seen.add(position.ticket);
      const row: PositionRow = {
        id: `mt5_${position.ticket}`,
        userId,
        accountId: account.id,
        mode: 'LIVE',
        ticket: position.ticket,
        brokerTicket: position.ticket,
        symbol: position.symbol,
        canonical: position.canonical,
        side: position.side,
        volume: position.volume,
        openPrice: position.openPrice,
        currentPrice: position.currentPrice,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        swap: position.swap,
        commission: position.commission,
        profit: position.profit,
        profitPercent: this.profitPercentFor(account, position),
        magic: position.magic,
        comment: position.comment,
        origin: 'MANUAL',
        strategyId: null,
        riskAmount: 0,
        accountLogin: account.login,
        openTime: position.openTime,
        updatedAt: new Date().toISOString(),
        source: 'MT5',
        meta: null,
      };
      const previous = existing.find((p) => p.ticket === position.ticket);
      await this.deps.store.positions.upsert(previous ? { ...row, id: previous.id } : row);
    }
    for (const row of existing) {
      if (!seen.has(row.ticket)) await this.deps.store.positions.delete(row.id);
    }
  }

  private profitPercentFor(account: BrokerAccountRow, position: Position): number {
    const marginBase =
      account.leverage > 0 ? (position.volume * position.openPrice) / account.leverage : position.openPrice * position.volume;
    if (!marginBase) return 0;
    return round((position.profit / marginBase) * 100, 2);
  }

  private async mirrorOrders(userId: string, account: BrokerAccountRow, orders: PendingOrder[]): Promise<void> {
    const existing = await this.deps.store.orders.findMany({ accountId: { eq: account.id }, status: { eq: 'PENDING' } });
    const seen = new Set<string>();
    for (const order of orders) {
      seen.add(order.ticket);
      const previous = existing.find((o) => o.ticket === order.ticket);
      await this.deps.store.orders.upsert({
        id: previous?.id ?? `mt5_order_${order.ticket}`,
        userId,
        accountId: account.id,
        mode: 'LIVE',
        ticket: order.ticket,
        brokerTicket: order.ticket,
        symbol: order.symbol,
        canonical: order.canonical,
        side: order.side,
        type: order.type,
        volume: order.volume,
        price: order.price,
        stopLimitPrice: order.stopLimitPrice,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        expiration: order.expiration,
        status: 'PENDING',
        comment: order.comment,
        magic: order.magic,
        origin: 'MANUAL',
        strategyId: null,
        clientRequestId: null,
        commandId: null,
        placedAt: order.placedAt,
        updatedAt: new Date().toISOString(),
        closedAt: null,
        source: 'MT5',
      });
    }
    for (const row of existing) {
      if (!seen.has(row.ticket)) {
        await this.deps.store.orders.update(row.id, {
          status: 'CANCELLED',
          closedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async mirrorTrades(userId: string, account: BrokerAccountRow, trades: Awaited<ReturnType<MT5BrokerBridge['getHistory']>>): Promise<void> {
    const existing = await this.deps.store.trades.findMany({ accountId: { eq: account.id } });
    const knownDeals = new Set(existing.map((t) => t.dealTicket ?? t.ticket));

    for (const trade of trades) {
      const key = trade.dealTicket ?? trade.ticket;
      if (knownDeals.has(key)) continue;

      const row: TradeRow = {
        id: newId('trd'),
        userId,
        accountId: account.id,
        mode: 'LIVE',
        ticket: trade.ticket,
        dealTicket: trade.dealTicket,
        symbol: trade.symbol,
        canonical: trade.canonical,
        side: trade.side,
        volume: trade.volume,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        commission: trade.commission,
        swap: trade.swap,
        grossProfit: trade.grossProfit,
        netProfit: trade.netProfit,
        openTime: trade.openTime,
        closeTime: trade.closeTime,
        durationSeconds: trade.durationSeconds,
        magic: trade.magic,
        comment: trade.comment,
        origin: 'MANUAL',
        strategyId: null,
        accountLogin: account.login,
        source: 'MT5',
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.trades.insert(row);

      this.deps.publisher.toUser(userId, { type: 'trade', trade: { ...trade, id: row.id, accountLogin: account.login } });
      await this.deps.notifications.create(userId, {
        level: trade.netProfit >= 0 ? 'success' : 'warning',
        title: `${trade.side} ${trade.canonical} closed`,
        message: `Ticket ${trade.ticket} closed at ${trade.exitPrice} • net P/L ${round(trade.netProfit, 2)} ${account.currency}.`,
        meta: { ticket: trade.ticket, mode: 'LIVE' },
      });
      await this.deps.audit.record({
        userId,
        mode: 'LIVE',
        action: 'LIVE_TRADE_CLOSED',
        symbol: trade.symbol,
        volume: trade.volume,
        price: trade.exitPrice,
        brokerTicket: trade.ticket,
        result: 'SUCCESS',
        detail: { netProfit: trade.netProfit, entryPrice: trade.entryPrice, closeTime: trade.closeTime, imported: true },
      });
    }
  }
}

export type { TradingMode };
