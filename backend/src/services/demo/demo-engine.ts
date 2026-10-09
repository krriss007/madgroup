/**
 * TradePilot — demo trading engine.
 *
 * Wires the simulated market to the DemoBroker for every demo account:
 * mark-to-market, SL/TP execution, pending-order triggering, balance updates,
 * portfolio snapshots, price alerts and realtime broadcasts.
 *
 * Everything this engine produces is labelled `DEMO_SIMULATED`. It cannot place
 * a live order: it only ever talks to DemoBroker and to the demo accounts.
 */

import { ErrorCode, round, type Position, type PendingOrder, type Quote } from '@tradepilot/shared';
import type { Store } from '../../db/types';
import type { BrokerAccountRow } from '../../db/types';
import type { Logger } from '../../lib/logger';
import type { RealtimePublisher } from '../../ws/publisher';
import type { DemoBroker } from './demo-broker';
import { MarketSimulator, type SimulatedQuote } from './market-simulator';
import { simulatedQuoteToQuote } from '../market/converters';
import type { PortfolioService } from '../portfolio.service';
import type { AlertsService } from '../alerts.service';
import type { Env } from '../../config/env';
import type { RiskService } from '../risk.service';

export interface DemoEngineDeps {
  store: Store;
  simulator: MarketSimulator;
  publisher: RealtimePublisher;
  portfolio: PortfolioService;
  alerts: AlertsService;
  risk: RiskService;
  logger: Logger;
  env: Env;
  /** Factory so the engine can build a broker bound to a demo account. */
  brokerFactory: (account: BrokerAccountRow) => DemoBroker;
}

export class DemoEngine {
  private processing = false;
  private tickCount = 0;
  private lastTickAt = Date.now();

  constructor(private readonly deps: DemoEngineDeps) {
    this.deps.simulator.on('tick', (quotes: SimulatedQuote[]) => {
      void this.onTick(quotes);
    });
  }

  start(): void {
    this.deps.simulator.start();
    this.deps.logger.info(
      { intervalMs: this.deps.env.DEMO_TICK_INTERVAL_MS, symbols: this.deps.simulator.listSymbols().length },
      'demo market simulator started (all prices are simulated and labelled as such)',
    );
  }

  stop(): void {
    this.deps.simulator.stop();
  }

  stats(): { running: boolean; ticks: number; lastTickAgoMs: number } {
    return {
      running: this.deps.simulator.isRunning(),
      ticks: this.tickCount,
      lastTickAgoMs: Date.now() - this.lastTickAt,
    };
  }

  private async onTick(quotes: SimulatedQuote[]): Promise<void> {
    if (this.processing) return; // never overlap: prices would be applied twice
    this.processing = true;
    this.lastTickAt = Date.now();
    this.tickCount += 1;

    try {
      const domainQuotes: Quote[] = quotes.map(simulatedQuoteToQuote);
      // 1. Market data for subscribed clients
      this.deps.publisher.quotes(domainQuotes);
      // 2. Price alerts (never auto-trade)
      await this.deps.alerts.evaluate(domainQuotes);

      // 3. Position management for every demo account
      const accounts = await this.deps.store.brokerAccounts.findMany({ mode: { eq: 'DEMO' } });
      for (const account of accounts) {
        const broker = this.deps.brokerFactory(account);
        const result = await broker.processTick(quotes);

        if (result.closed.length) {
          for (const closed of result.closed) {
            this.deps.publisher.toUser(account.userId, {
              type: 'trade',
              trade: closed.trade,
            });
            this.deps.publisher.toUser(account.userId, {
              type: 'notification',
              notification: {
                id: `ntf_${closed.trade.id}`,
                userId: account.userId,
                level: closed.trade.netProfit >= 0 ? 'success' : 'warning',
                title: `${closed.reason} hit on ${closed.row.canonical}`,
                message: `Ticket ${closed.row.ticket} closed at ${
                  closed.trade.exitPrice
                } • net P/L ${round(closed.trade.netProfit, 2)} USD (simulated).`,
                read: false,
                createdAt: new Date().toISOString(),
              },
            });
          }
        }
        if (result.filled.length) {
          for (const fill of result.filled) {
            this.deps.publisher.toUser(account.userId, {
              type: 'notification',
              notification: {
                id: `ntf_fill_${fill.position.id}`,
                userId: account.userId,
                level: 'info',
                title: `Pending ${fill.order.type} filled on ${fill.order.canonical}`,
                message: `${fill.order.side} ${fill.position.volume} lots at ${fill.position.openPrice} (simulated).`,
                read: false,
                createdAt: new Date().toISOString(),
              },
            });
          }
        }

        // 4. Account snapshot + realtime update
        const snapshot = await broker.getAccount();
        await this.deps.store.brokerAccounts.update(account.id, {
          balance: snapshot.balance,
          equity: snapshot.equity,
          margin: snapshot.margin,
          freeMargin: snapshot.freeMargin,
          marginLevel: snapshot.marginLevel,
          profit: snapshot.profit,
          lastUpdate: snapshot.lastUpdate,
        });

        const positions = await this.deps.store.positions.findMany({ accountId: { eq: account.id } });
        const orders = await this.deps.store.orders.findMany({ accountId: { eq: account.id }, status: { eq: 'PENDING' } });
        const user = await this.deps.store.users.findById(account.userId);
        const risk = user
          ? await this.deps.risk.computeStatus(account.userId, account, {
              liveTradingEnabled: user.liveTradingEnabled,
              brokerOnline: true,
              killSwitchEngaged: user.killSwitchEngaged,
            })
          : null;

        this.deps.publisher.toUser(account.userId, {
          type: 'positions',
          mode: 'DEMO',
          positions: positions.map((row) => toDomainPosition(row)),
        });
        this.deps.publisher.toUser(account.userId, {
          type: 'orders',
          mode: 'DEMO',
          orders: orders.map((row) => toDomainOrder(row, account.login)),
        });
        this.deps.publisher.toUser(account.userId, {
          type: 'account',
          account: {
            id: account.id,
            userId: account.userId,
            mode: 'DEMO',
            login: account.login,
            server: account.server,
            currency: account.currency,
            leverage: account.leverage,
            balance: snapshot.balance,
            equity: snapshot.equity,
            margin: snapshot.margin,
            freeMargin: snapshot.freeMargin,
            marginLevel: snapshot.marginLevel,
            profit: snapshot.profit,
            lastUpdate: snapshot.lastUpdate,
            isAuthorized: true,
          },
          risk: risk ?? {
            tradingEnabled: true,
            liveTradingEnabled: false,
            locked: false,
            lockReasons: [],
            dailyLossLimitAmount: 0,
            dailyRealizedLoss: 0,
            dailyRealizedProfit: 0,
            dailyNetPl: 0,
            dailyTradesCount: 0,
            openPositionsCount: positions.length,
            totalExposureLots: round(
              positions.reduce((acc, p) => acc + p.volume, 0),
              2,
            ),
            consecutiveLosses: 0,
            remainingRiskToday: 0,
            day: new Date().toISOString().slice(0, 10),
          },
        });

        // 5. Portfolio snapshot (throttled inside the service)
        await this.deps.portfolio.record({
          userId: account.userId,
          accountId: account.id,
          mode: 'DEMO',
          balance: snapshot.balance,
          equity: snapshot.equity,
          margin: snapshot.margin,
          freeMargin: snapshot.freeMargin,
          openPl: round(snapshot.equity - snapshot.balance, 2),
        });
      }
    } catch (error) {
      this.deps.logger.error({ error: (error as Error).message }, 'demo engine tick failed');
      if (error instanceof Error && error.message.includes(ErrorCode.INTERNAL)) {
        // keep the loop alive; a single bad account must not stop the market
      }
    } finally {
      this.processing = false;
    }
  }
}

function toDomainPosition(row: {
  id: string;
  accountId: string;
  mode: 'DEMO' | 'LIVE';
  ticket: string;
  symbol: string;
  canonical: string;
  side: 'BUY' | 'SELL';
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  swap: number;
  commission: number;
  profit: number;
  profitPercent: number;
  magic: number;
  comment: string | null;
  openTime: string;
  updatedAt: string;
  origin: 'MANUAL' | 'STRATEGY';
  strategyId: string | null;
  accountLogin: string;
  source: 'MT5' | 'DEMO_SIMULATED';
}): Position {
  return {
    id: row.id,
    accountId: row.accountId,
    mode: row.mode,
    ticket: row.ticket,
    symbol: row.symbol,
    canonical: row.canonical,
    side: row.side,
    volume: row.volume,
    openPrice: row.openPrice,
    currentPrice: row.currentPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    swap: row.swap,
    commission: row.commission,
    profit: row.profit,
    profitPercent: row.profitPercent,
    magic: row.magic,
    comment: row.comment,
    openTime: row.openTime,
    updatedAt: row.updatedAt,
    origin: row.origin,
    strategyId: row.strategyId,
    accountLogin: row.accountLogin,
    source: row.source,
  };
}

function toDomainOrder(
  row: {
    id: string;
    accountId: string;
    mode: 'DEMO' | 'LIVE';
    ticket: string;
    symbol: string;
    canonical: string;
    type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
    side: 'BUY' | 'SELL';
    volume: number;
    price: number;
    stopLimitPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    expiration: string | null;
    status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
    placedAt: string;
    comment: string | null;
    magic: number;
    source: 'MT5' | 'DEMO_SIMULATED';
  },
  accountLogin: string,
): PendingOrder {
  return {
    id: row.id,
    accountId: row.accountId,
    mode: row.mode,
    ticket: row.ticket,
    symbol: row.symbol,
    canonical: row.canonical,
    type: row.type,
    side: row.side,
    volume: row.volume,
    price: row.price,
    stopLimitPrice: row.stopLimitPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    expiration: row.expiration,
    status: row.status,
    placedAt: row.placedAt,
    comment: row.comment,
    magic: row.magic,
    accountLogin,
    source: row.source,
  };
}
