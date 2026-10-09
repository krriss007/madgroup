/**
 * TradePilot — application context.
 *
 * Single place where every service is constructed and wired together. Routes
 * receive this object, which keeps dependency wiring explicit and makes it
 * trivial to build an isolated context in tests.
 */

import { loadEnv, type Env } from '../config/env';
import { createLogger, type Logger } from '../lib/logger';
import { createStore, type Store } from '../db';
import { MarketSimulator } from '../services/demo/market-simulator';
import { MarketService } from '../services/market.service';
import { AccountService } from '../services/account.service';
import { RiskService } from '../services/risk.service';
import { AuditService } from '../services/audit.service';
import { NotificationService } from '../services/notification.service';
import { PortfolioService } from '../services/portfolio.service';
import { AlertsService } from '../services/alerts.service';
import { JournalService } from '../services/journal.service';
import { HistoryService } from '../services/history.service';
import { AnalyticsService } from '../services/analytics.service';
import { DeviceService } from '../services/bridge/device.service';
import { CommandQueueService } from '../services/bridge/command-queue.service';
import { BrokerRegistry } from '../services/broker/registry';
import { OrderService } from '../services/execution/order.service';
import { DemoEngine } from '../services/demo/demo-engine';
import { DemoBroker } from '../services/demo/demo-broker';
import { MT5BrokerBridge } from '../services/broker/mt5-broker-bridge';
import { LiveSyncService } from '../services/sync/live-sync.service';
import { AuthService } from '../services/auth.service';
import { RealtimeService } from '../services/realtime.service';
import { StrategyService } from '../services/strategy.service';
import { WsHub } from '../ws/hub';
import { NullPublisher, type RealtimePublisher } from '../ws/publisher';
import type { Server } from 'node:http';

export interface AppContext {
  env: Env;
  logger: Logger;
  store: Store;
  /** true when the store fell back to memory because PostgreSQL was unreachable */
  storeFellBack: boolean;
  storeDetail: string;
  simulator: MarketSimulator;
  market: MarketService;
  accounts: AccountService;
  risk: RiskService;
  audit: AuditService;
  notifications: NotificationService;
  portfolio: PortfolioService;
  alerts: AlertsService;
  journal: JournalService;
  history: HistoryService;
  analytics: AnalyticsService;
  devices: DeviceService;
  queue: CommandQueueService;
  brokers: BrokerRegistry;
  orders: OrderService;
  demoEngine: DemoEngine;
  liveSync: LiveSyncService;
  auth: AuthService;
  realtime: RealtimeService;
  strategies: StrategyService;
  publisher: RealtimePublisher;
  hub: WsHub | null;
  services: {
    /** attach the WebSocket hub (called once the HTTP server exists) */
    attachHub(server: Server): WsHub;
    startBackgroundJobs(): void;
    stopBackgroundJobs(): Promise<void>;
  };
}

export interface CreateContextOptions {
  env?: Env;
  logger?: Logger;
  /** disable the demo tick loop / background jobs (unit tests) */
  disableBackground?: boolean;
  store?: Store;
  publisher?: RealtimePublisher;
}

export async function createContext(options: CreateContextOptions = {}): Promise<AppContext> {
  const env = options.env ?? loadEnv();
  const logger = options.logger ?? createLogger(env.LOG_LEVEL, { service: 'tradepilot-backend' });

  const storeResult = options.store
    ? { store: options.store, fellBack: false, detail: 'injected' }
    : await createStore(env, logger);

  const simulator = new MarketSimulator({
    seed: env.DEMO_SEED,
    tickIntervalMs: env.DEMO_TICK_INTERVAL_MS,
    autoStart: false,
  });

  /**
   * Realtime fan-out indirection.
   *
   * Services, routes and background jobs are constructed before the HTTP server
   * exists, but the WebSocket hub (the real publisher) can only be attached once
   * it does. They therefore all receive ONE stable delegate whose methods look
   * up the current target at call time; `attachHub()` then swaps the target from
   * the placeholder to the hub. Without this, every quote tick, notification and
   * execution event after page load would be published into the void and the
   * dashboard would only ever update on a full snapshot.
   */
  let publisherTarget: RealtimePublisher = options.publisher ?? new NullPublisher();
  const publisher: RealtimePublisher = {
    toUser: (userId, message) => publisherTarget.toUser(userId, message),
    quotes: (quotes) => publisherTarget.quotes(quotes),
    clientCount: () => publisherTarget.clientCount(),
  };
  const market = new MarketService(storeResult.store, simulator, logger);
  const accounts = new AccountService(storeResult.store, env, logger);
  const risk = new RiskService(storeResult.store, logger);
  const audit = new AuditService(storeResult.store, logger);
  const notifications = new NotificationService(storeResult.store);
  const portfolio = new PortfolioService(storeResult.store, 15);
  const alerts = new AlertsService(storeResult.store, notifications);
  const journal = new JournalService(storeResult.store);
  const history = new HistoryService(storeResult.store);
  const analytics = new AnalyticsService(storeResult.store);
  const devices = new DeviceService(storeResult.store, env, logger);
  const queue = new CommandQueueService(storeResult.store, devices, env, logger);

  const brokers = new BrokerRegistry({
    store: storeResult.store,
    env,
    logger,
    accounts,
    devices,
    queue,
    market,
    simulator,
  });

  const orders = new OrderService({
    store: storeResult.store,
    env,
    logger,
    accounts,
    risk,
    market,
    audit,
    notifications,
    brokers,
    devices,
  });

  const demoEngine = new DemoEngine({
    store: storeResult.store,
    simulator,
    publisher,
    portfolio,
    alerts,
    risk,
    logger,
    env,
    brokerFactory: (account) =>
      new DemoBroker({
        store: storeResult.store,
        simulator,
        context: { userId: account.userId, accountId: account.id, mode: 'DEMO' },
        account,
      }),
  });

  const liveSync = new LiveSyncService({
    store: storeResult.store,
    devices,
    logger,
    publisher,
    portfolio,
    notifications,
    audit,
    bridgeFactory: (userId, account, connection) =>
      new MT5BrokerBridge({
        store: storeResult.store,
        devices,
        queue,
        market,
        logger,
        context: { userId, accountId: account.id, mode: 'LIVE' },
        connection,
      }),
  });

  const auth = new AuthService(storeResult.store, env, logger, accounts);
  const realtime = new RealtimeService({ store: storeResult.store, accounts, risk, market, devices });
  const strategies = new StrategyService({ store: storeResult.store, logger, orders, risk, market, accounts, audit, notifications });

  const context: AppContext = {
    env,
    logger,
    store: storeResult.store,
    storeFellBack: storeResult.fellBack,
    storeDetail: storeResult.detail,
    simulator,
    market,
    accounts,
    risk,
    audit,
    notifications,
    portfolio,
    alerts,
    journal,
    history,
    analytics,
    devices,
    queue,
    brokers,
    orders,
    demoEngine,
    liveSync,
    auth,
    realtime,
    strategies,
    publisher,
    hub: null,
    services: {
      attachHub(server: Server): WsHub {
        const hub = new WsHub({
          server,
          path: '/ws',
          env,
          logger,
          snapshots: realtime,
          authenticate: async (request) => {
            const cookies = parseCookieHeader(request.headers.cookie);
            const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
            const token = cookies.tp_session ?? bearer;
            if (!token) return null;
            const session = await auth.verifySession(token);
            return session ? { userId: session.id } : null;
          },
        });
        context.hub = hub;
        // From here on realtime events reach browsers instead of the placeholder.
        publisherTarget = hub;
        logger.info({ path: '/ws' }, 'websocket hub attached — realtime fan-out live');
        return hub;
      },
      startBackgroundJobs(): void {
        if (options.disableBackground) return;
        demoEngine.start();
        liveSync.start();
        strategies.start('DEMO', 30_000);
        strategies.start('LIVE', 30_000);
        devices.startWatchdog(2_000);
        logger.info(
          {
            demoEngine: 'started',
            liveSync: 'started',
            store: storeResult.store.kind,
            liveTrading: 'disabled until explicitly enabled by each user',
          },
          'background jobs started',
        );
      },
      async stopBackgroundJobs(): Promise<void> {
        demoEngine.stop();
        liveSync.stop();
        strategies.stop();
        devices.stopWatchdog();
        if (context.hub) await context.hub.close();
        await storeResult.store.close();
      },
    },
  };

  // Live market data reaching the hub ------------------------------------
  market.on('live-quotes', ({ quotes }: { quotes: never[] }) => publisher.quotes(quotes));
  market.on('demo-quotes', (quotes: never[]) => publisher.quotes(quotes));
  notifications.on('created', ({ userId, notification }: { userId: string; notification: never }) => {
    publisher.toUser(userId, { type: 'notification', notification });
  });
  alerts.on('triggered', (alert: { id: string; symbol: string; canonical: string; price: number; condition: 'ABOVE' | 'BELOW' }) => {
    void (async () => {
      const rows = await storeResult.store.priceAlerts.findById(alert.id);
      if (rows) {
        publisher.toUser(rows.userId, {
          type: 'alert',
          alertId: alert.id,
          symbol: alert.canonical,
          price: alert.price,
          condition: alert.condition,
          message: `${alert.canonical} reached ${alert.price}`,
        });
      }
    })();
  });

  devices.on('offline', ({ connection }: { connection: { userId: string } }) => {
    publisher.toUser(connection.userId, {
      type: 'connection',
      mt5: null,
      status: 'OFFLINE',
      lastHeartbeatAgeSeconds: null,
      message: 'MT5 heartbeat lost — LIVE trading disabled until the terminal reconnects.',
    });
  });

  return context;
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}
