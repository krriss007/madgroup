/**
 * TradePilot — market data routes.
 *
 * GET /api/v1/market/instruments        → canonical instrument registry
 * GET /api/v1/market/symbols            → broker specifications (live: from MT5)
 * GET /api/v1/market/quotes             → current bid/ask (never fabricated)
 * GET /api/v1/market/candles            → OHLC history
 * GET /api/v1/market/status             → data availability + MT5 heartbeat
 * GET /api/v1/market/sessions           → trading sessions / market phase
 * GET /api/v1/market/summary/:symbol    → instrument panel payload
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_WATCHLIST,
  INSTRUMENTS,
  activeSessions,
  atr,
  canonicalize,
  currentSessionLabel,
  isLondonNewYorkOverlap,
  isWeekendClosed,
  round,
  type Timeframe,
} from '@tradepilot/shared';
import type { AppContext } from '../http/context';
import { requireUser, resolveMode } from '../http/plugins';

const timeframeSchema = z.enum(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']);

export function registerMarketRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/market/instruments', async () => ({
    instruments: INSTRUMENTS,
    defaultWatchlist: DEFAULT_WATCHLIST,
    primarySymbol: 'XAUUSD',
  }));

  app.get('/market/symbols', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const device = mode === 'LIVE' ? await context.devices.connectionForUser(user.id) : null;
    const symbols = await context.market.listSymbols(mode, user.id, device?.deviceId ?? null);
    return { mode, symbols, count: symbols.length };
  });

  app.get('/market/quotes', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const query = z
      .object({ symbols: z.string().optional() })
      .parse(request.query ?? {});
    const symbols = (query.symbols ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const device = mode === 'LIVE' ? await context.devices.connectionForUser(user.id) : null;
    const quotes = await context.market.getQuotes(mode, user.id, symbols, device?.deviceId ?? null);
    const online = mode === 'DEMO' ? true : context.devices.isOnline(device);
    return {
      mode,
      online,
      source: mode === 'DEMO' ? 'DEMO_SIMULATED' : 'MT5',
      message: !online ? 'MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE' : null,
      quotes,
      serverTime: new Date().toISOString(),
    };
  });

  app.get('/market/candles', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const query = z
      .object({
        symbol: z.string().min(1),
        timeframe: timeframeSchema.default('M15'),
        count: z.coerce.number().int().min(10).max(1000).default(300),
      })
      .parse(request.query ?? {});

    const candles = await context.orders.candles(
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      query.symbol,
      query.timeframe as Timeframe,
      query.count,
    );
    const atrValues = atr(candles, 14);
    const atrValue = [...atrValues].reverse().find((v) => v != null) ?? null;

    return {
      mode,
      source: mode === 'DEMO' ? 'DEMO_SIMULATED' : 'MT5',
      symbol: query.symbol,
      canonical: canonicalize(query.symbol),
      timeframe: query.timeframe,
      candles,
      atr: atrValue != null ? round(atrValue, 5) : null,
      count: candles.length,
    };
  });

  app.get('/market/status', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const device = mode === 'LIVE' ? await context.devices.connectionForUser(user.id) : null;
    const online = mode === 'DEMO' ? true : context.devices.isOnline(device);
    const age = context.devices.heartbeatAgeSeconds(device);
    const symbolCount = mode === 'LIVE' ? context.market.liveSymbolsFor(user.id, device?.deviceId ?? '').length : context.market.demoSymbols().length;

    return {
      mode,
      online,
      message: online ? null : 'MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE',
      symbolCount,
      mt5: context.devices.toDomain(device),
      lastHeartbeatAgeSeconds: age,
      latencyMs: device?.latencyMs ?? null,
      terminalConnected: device?.terminalConnected ?? false,
      tradeAllowed: device?.tradeAllowed ?? false,
      eaTradeAllowed: device?.eaTradeAllowed ?? false,
      algoTradingEnabled: device?.algoTradingEnabled ?? false,
      serverTime: new Date().toISOString(),
    };
  });

  app.get('/market/sessions', async () => ({
    now: new Date().toISOString(),
    activeSessions: activeSessions(),
    label: currentSessionLabel(),
    weekendClosed: isWeekendClosed(),
    londonNewYorkOverlap: isLondonNewYorkOverlap(),
  }));

  app.get('/market/summary/:symbol', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const params = z.object({ symbol: z.string().min(1) }).parse(request.params);
    const device = mode === 'LIVE' ? await context.devices.connectionForUser(user.id) : null;
    const symbol = await context.market.getSymbolSpec(mode, user.id, params.symbol, device?.deviceId ?? null);
    const quotes = await context.market.getQuotes(mode, user.id, [symbol.symbol], device?.deviceId ?? null);
    const quote = quotes[0] ?? null;
    const candles = await context.orders.candles(
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: null },
      symbol.symbol,
      'M15',
      120,
    );
    const atrValues = atr(candles, 14);
    const atrValue = [...atrValues].reverse().find((v) => v != null) ?? null;
    const dayStats = mode === 'DEMO' ? context.market.dayStatsFor(symbol.canonical) : null;

    return {
      mode,
      source: symbol.source,
      symbol: symbol.symbol,
      canonical: symbol.canonical,
      spec: symbol,
      quote,
      dayStats,
      atr: atrValue != null ? round(atrValue, 5) : null,
      session: { label: currentSessionLabel(), active: activeSessions(), weekendClosed: isWeekendClosed() },
      marketOpen: Boolean(quote) && symbol.tradeAllowed && symbol.tradeMode !== 0,
      disclosures:
        mode === 'DEMO'
          ? ['Prices on this screen are generated by the TradePilot demo simulator and are not live market prices.']
          : [],
    };
  });
}
