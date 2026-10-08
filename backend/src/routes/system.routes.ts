/**
 * TradePilot — system routes.
 *
 * GET /api/v1/system/health  → liveness + store/engine diagnostics
 * GET /api/v1/system/config  → public configuration for the SPA (no secrets)
 */

import type { FastifyInstance } from 'fastify';
import { INDICATOR_CATALOG, INSTRUMENTS, TRADEPILOT_NAME, TRADEPILOT_VERSION } from '@tradepilot/shared';
import type { AppContext } from '../http/context';

export function registerSystemRoutes(app: FastifyInstance, context: AppContext): void {
  const startedAt = Date.now();

  app.get('/system/health', async () => {
    const health = await context.store.healthcheck();
    const deviceCount = await context.store.mt5Connections.count({ revokedAt: { isNull: true } });
    const onlineDevices = await context.store.mt5Connections.count({ status: { eq: 'CONNECTED' } });
    return {
      status: health.ok ? 'ok' : 'degraded',
      name: TRADEPILOT_NAME,
      version: TRADEPILOT_VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      store: { kind: context.store.kind, detail: health.detail, fellBack: context.storeFellBack },
      demoEngine: context.demoEngine.stats(),
      realtime: context.hub ? context.hub.stats() : { clients: 0, users: 0 },
      mt5: { devices: deviceCount, online: onlineDevices },
      environment: context.env.NODE_ENV,
      time: new Date().toISOString(),
    };
  });

  app.get('/system/config', async () => {
    const symbols = context.market.demoSymbols().map((symbol) => symbol.canonical);
    return {
      name: TRADEPILOT_NAME,
      version: TRADEPILOT_VERSION,
      defaultMode: 'DEMO',
      modes: ['DEMO', 'LIVE'],
      primarySymbol: 'XAUUSD',
      instruments: INSTRUMENTS,
      indicators: INDICATOR_CATALOG,
      demo: {
        enabled: true,
        simulated: true,
        symbols,
        startingBalance: context.env.DEMO_STARTING_BALANCE,
        tickIntervalMs: context.env.DEMO_TICK_INTERVAL_MS,
        disclosure:
          'DEMO accounts execute against a local market simulator. All prices, fills and P/L are simulated and must never be treated as real market results.',
      },
      live: {
        available: true,
        requires: [
          'MT5 terminal running with the TradePilotBridge EA attached',
          'Algo Trading enabled in MT5',
          'A TradePilot device token pasted into the EA inputs',
          'Live trading explicitly enabled in Settings after acknowledging the risk warning',
        ],
        disclaimer:
          'LIVE orders are executed by your own broker through your MT5 terminal. TradePilot never holds your broker credentials and cannot move funds.',
      },
      serverTime: new Date().toISOString(),
      storeMode: context.store.kind,
      features: {
        strategyEngine: true,
        journal: true,
        alerts: true,
        analytics: true,
        priceAlerts: true,
      },
    };
  });
}
