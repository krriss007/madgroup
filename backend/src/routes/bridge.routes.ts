/**
 * TradePilot — MT5 bridge endpoints (consumed by TradePilotBridge.mq5).
 *
 * Authentication: `x-tradepilot-device` + `x-tradepilot-token` headers, or the
 * same values inside the JSON envelope. These endpoints never accept broker
 * credentials — the terminal already holds the broker session.
 *
 *   POST /api/v1/bridge/heartbeat   EA heartbeat (every 2–5 s)
 *   POST /api/v1/bridge/market      symbol specifications + live ticks
 *   POST /api/v1/bridge/account     account snapshot
 *   POST /api/v1/bridge/positions   open positions
 *   POST /api/v1/bridge/orders      pending orders
 *   POST /api/v1/bridge/deals       closed-deal history
 *   GET  /api/v1/bridge/commands    command polling
 *   POST /api/v1/bridge/result      execution report
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ErrorCode,
  TradePilotError,
  round,
  type EaAccountPayload,
  type EaDealPayload,
  type EaExecutionResult,
  type EaHeartbeat,
  type EaOrderPayload,
  type EaPositionPayload,
  type EaSymbolPayload,
  type EaTickPayload,
} from '@tradepilot/shared';
import type { AppContext } from '../http/context';
import { requireUser } from '../http/plugins';
import type { Mt5ConnectionRow } from '../db/types';
import { newId } from '../lib/ids';

const envelopeBase = z.object({
  device_id: z.string().min(1).max(64).optional(),
  device_token: z.string().min(1).max(200).optional(),
  protocol_version: z.string().optional(),
  sent_at: z.string().optional(),
  sequence: z.coerce.number().int().nonnegative().optional(),
});

export function registerBridgeRoutes(app: FastifyInstance, context: AppContext): void {
  /** Authenticate an EA request from headers or the JSON envelope. */
  const authenticate = async (request: FastifyRequest): Promise<{ connection: Mt5ConnectionRow; secret: string; sequence: number }> => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const deviceId = (request.headers['x-tradepilot-device'] as string | undefined) ?? (body.device_id as string | undefined);
    const token = (request.headers['x-tradepilot-token'] as string | undefined) ?? (body.device_token as string | undefined);
    const sequence = Number((body.sequence as number | undefined) ?? 0);
    if (!deviceId || !token) {
      throw new TradePilotError(
        ErrorCode.UNAUTHENTICATED,
        'Missing MT5 credentials: send x-tradepilot-device and x-tradepilot-token headers (or device_id/device_token in the envelope).',
        401,
      );
    }
    const auth = await context.devices.authenticate(deviceId, token);
    return { connection: auth.connection, secret: auth.secret, sequence };
  };

  /* ------------------------------ heartbeat ------------------------------ */

  app.post('/bridge/heartbeat', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request) => {
    const started = Date.now();
    const { connection, sequence } = await authenticate(request);
    const body = envelopeBase.extend({ payload: z.record(z.unknown()) }).parse(request.body ?? {});
    const payload = body.payload as unknown as EaHeartbeat;
    const heartbeat: EaHeartbeat = {
      ...payload,
      device_id: payload.device_id ?? connection.deviceId,
      sequence: payload.sequence ?? sequence,
    } as EaHeartbeat & { sequence: number };

    const updated = await context.devices.heartbeat(heartbeat, Date.now() - started);
    const online = context.devices.isOnline(updated);

    context.publisher.toUser(connection.userId, {
      type: 'connection',
      mt5: context.devices.toDomain(updated),
      status: online ? 'CONNECTED' : 'OFFLINE',
      lastHeartbeatAgeSeconds: context.devices.heartbeatAgeSeconds(updated),
      message: online ? null : 'MT5 offline — LIVE trading disabled.',
    });

    return {
      ok: true,
      status: online ? 'CONNECTED' : 'OFFLINE',
      server_time: new Date().toISOString(),
      next_poll_ms: 1_500,
      heartbeat_timeout_ms: context.env.HEARTBEAT_TIMEOUT_MS,
    };
  });

  /* -------------------------------- market ------------------------------- */

  app.post('/bridge/market', async (request) => {
    const { connection } = await authenticate(request);
    const body = envelopeBase
      .extend({
        payload: z.object({
          symbols: z.array(z.record(z.unknown())).max(500).optional(),
          ticks: z.array(z.record(z.unknown())).max(500).optional(),
        }),
      })
      .parse(request.body ?? {});

    let symbolsStored = 0;
    if (body.payload.symbols?.length) {
      symbolsStored = await context.market.ingestSymbols(
        connection.userId,
        connection.deviceId,
        connection.id,
        body.payload.symbols as unknown as EaSymbolPayload[],
      );
    }
    const quotes = body.payload.ticks?.length
      ? context.market.ingestTicks(connection.userId, connection.deviceId, body.payload.ticks as unknown as EaTickPayload[])
      : [];

    if (quotes.length) {
      context.publisher.quotes(quotes);
      void context.alerts.evaluate(quotes);
    }

    return { ok: true, symbols: symbolsStored, ticks: quotes.length, server_time: new Date().toISOString() };
  });

  /* ------------------------------- account ------------------------------- */

  app.post('/bridge/account', async (request) => {
    const { connection } = await authenticate(request);
    const body = envelopeBase.extend({ payload: z.record(z.unknown()) }).parse(request.body ?? {});
    const payload = body.payload as unknown as EaAccountPayload;
    if (!payload?.login) {
      throw new TradePilotError(ErrorCode.VALIDATION_FAILED, 'Account payload must contain the MT5 login.', 400);
    }

    const account = await context.accounts.upsertLiveAccount(connection.userId, {
      login: String(payload.login),
      server: payload.server,
      currency: payload.currency,
      leverage: payload.leverage,
      balance: payload.balance,
      equity: payload.equity,
      margin: payload.margin,
      freeMargin: payload.free_margin,
      marginLevel: payload.margin_level ?? null,
      profit: payload.profit,
    });
    await context.devices.linkAccount(connection, account.id, String(payload.login), payload.server);

    const user = await context.store.users.findById(connection.userId);
    const risk = await context.risk.computeStatus(connection.userId, account, {
      liveTradingEnabled: Boolean(user?.liveTradingEnabled),
      brokerOnline: true,
      killSwitchEngaged: Boolean(user?.killSwitchEngaged),
    });

    context.publisher.toUser(connection.userId, {
      type: 'account',
      account: context.accounts.toDomain(account),
      risk,
    });
    await context.portfolio.record({
      userId: connection.userId,
      accountId: account.id,
      mode: 'LIVE',
      balance: account.balance,
      equity: account.equity,
      margin: account.margin,
      freeMargin: account.freeMargin,
      openPl: round(account.equity - account.balance, 2),
    });

    return {
      ok: true,
      account_id: account.id,
      authorized: account.isAuthorized,
      trade_allowed: payload.trade_allowed,
      server_time: new Date().toISOString(),
    };
  });

  /* ------------------------------ positions ------------------------------ */

  app.post('/bridge/positions', async (request) => {
    const { connection } = await authenticate(request);
    const body = envelopeBase
      .extend({ payload: z.object({ positions: z.array(z.record(z.unknown())).max(500) }) })
      .parse(request.body ?? {});
    const positions = body.payload.positions as unknown as EaPositionPayload[];

    const account = connection.accountId
      ? await context.store.brokerAccounts.findById(connection.accountId)
      : await context.accounts.getAccount(connection.userId, 'LIVE');
    if (!account) throw new TradePilotError(ErrorCode.CONFLICT, 'Account is not linked yet — send the account snapshot first.', 409);

    const existing = await context.store.positions.findMany({ accountId: { eq: account.id } });
    const seen = new Set<string>();
    for (const position of positions) {
      seen.add(String(position.ticket));
      const previous = existing.find((row) => row.ticket === String(position.ticket));
      await context.store.positions.upsert({
        id: previous?.id ?? newId('pos'),
        userId: connection.userId,
        accountId: account.id,
        mode: 'LIVE',
        ticket: String(position.ticket),
        brokerTicket: String(position.ticket),
        symbol: position.symbol,
        canonical: canonicalOf(context, connection, position.symbol),
        side: position.type === 0 ? 'BUY' : 'SELL',
        volume: position.volume,
        openPrice: position.open_price,
        currentPrice: position.current_price,
        stopLoss: position.stop_loss || null,
        takeProfit: position.take_profit || null,
        swap: position.swap,
        commission: position.commission,
        profit: position.profit,
        profitPercent: 0,
        magic: position.magic,
        comment: position.comment,
        origin: 'MANUAL',
        strategyId: null,
        riskAmount: 0,
        accountLogin: account.login,
        openTime: position.open_time,
        updatedAt: new Date().toISOString(),
        source: 'MT5',
        meta: null,
      });
    }
    for (const row of existing) {
      if (!seen.has(row.ticket)) await context.store.positions.delete(row.id);
    }

    const rows = await context.store.positions.findMany({ accountId: { eq: account.id } });
    context.publisher.toUser(connection.userId, {
      type: 'positions',
      mode: 'LIVE',
      positions: rows.map((row) => ({
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
      })),
    });

    return { ok: true, stored: positions.length, server_time: new Date().toISOString() };
  });

  /* -------------------------------- orders ------------------------------- */

  app.post('/bridge/orders', async (request) => {
    const { connection } = await authenticate(request);
    const body = envelopeBase
      .extend({ payload: z.object({ orders: z.array(z.record(z.unknown())).max(500) }) })
      .parse(request.body ?? {});
    const orders = body.payload.orders as unknown as EaOrderPayload[];

    const account = connection.accountId
      ? await context.store.brokerAccounts.findById(connection.accountId)
      : await context.accounts.getAccount(connection.userId, 'LIVE');
    if (!account) throw new TradePilotError(ErrorCode.CONFLICT, 'Account is not linked yet.', 409);

    for (const order of orders) {
      const previous = await context.store.orders.findOne({ accountId: { eq: account.id }, ticket: { eq: String(order.ticket) } });
      await context.store.orders.upsert({
        id: previous?.id ?? newId('ord'),
        userId: connection.userId,
        accountId: account.id,
        mode: 'LIVE',
        ticket: String(order.ticket),
        brokerTicket: String(order.ticket),
        symbol: order.symbol,
        canonical: canonicalOf(context, connection, order.symbol),
        side: [2, 4, 6].includes(order.type) ? 'BUY' : 'SELL',
        type: order.type === 2 || order.type === 3 ? 'LIMIT' : order.type === 6 || order.type === 7 ? 'STOP_LIMIT' : 'STOP',
        volume: order.volume,
        price: order.price,
        stopLimitPrice: order.stop_limit_price || null,
        stopLoss: order.stop_loss || null,
        takeProfit: order.take_profit || null,
        expiration: order.expiration || null,
        status: 'PENDING',
        comment: order.comment,
        magic: order.magic,
        origin: 'MANUAL',
        strategyId: null,
        clientRequestId: previous?.clientRequestId ?? null,
        commandId: previous?.commandId ?? null,
        placedAt: order.setup_time,
        updatedAt: new Date().toISOString(),
        closedAt: null,
        source: 'MT5',
      });
    }

    return { ok: true, stored: orders.length, server_time: new Date().toISOString() };
  });

  /* --------------------------------- deals ------------------------------- */

  app.post('/bridge/deals', async (request) => {
    const { connection } = await authenticate(request);
    const body = envelopeBase
      .extend({ payload: z.object({ deals: z.array(z.record(z.unknown())).max(2000) }) })
      .parse(request.body ?? {});
    const deals = body.payload.deals as unknown as EaDealPayload[];

    const account = connection.accountId
      ? await context.store.brokerAccounts.findById(connection.accountId)
      : await context.accounts.getAccount(connection.userId, 'LIVE');
    if (!account) throw new TradePilotError(ErrorCode.CONFLICT, 'Account is not linked yet.', 409);

    const { aggregateDeals } = await import('../services/broker/mt5-broker-bridge');
    const trades = aggregateDeals(deals, { userId: connection.userId, accountId: account.id, mode: 'LIVE' });
    const existing = await context.store.trades.findMany({ accountId: { eq: account.id } });
    const known = new Set(existing.map((row) => row.dealTicket ?? row.ticket));

    let inserted = 0;
    for (const trade of trades) {
      const key = trade.dealTicket ?? trade.ticket;
      if (known.has(key)) continue;
      await context.store.trades.insert({
        id: newId('trd'),
        userId: connection.userId,
        accountId: account.id,
        mode: 'LIVE',
        ticket: trade.ticket,
        dealTicket: trade.dealTicket,
        symbol: trade.symbol,
        canonical: canonicalOf(context, connection, trade.symbol),
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
      });
      inserted += 1;

      context.publisher.toUser(connection.userId, { type: 'trade', trade: { ...trade, accountLogin: account.login } });
      await context.audit.record({
        userId: connection.userId,
        mode: 'LIVE',
        action: 'LIVE_TRADE_CLOSED',
        symbol: trade.symbol,
        volume: trade.volume,
        price: trade.exitPrice,
        brokerTicket: trade.ticket,
        result: 'SUCCESS',
        deviceId: connection.deviceId,
        detail: { netProfit: trade.netProfit, source: 'EA push' },
      });
    }

    return { ok: true, imported: inserted, total_received: deals.length, server_time: new Date().toISOString() };
  });

  /* ------------------------------- commands ------------------------------ */

  app.get('/bridge/commands', async (request) => {
    const deviceId = (request.headers['x-tradepilot-device'] as string | undefined) ?? (request.query as { device_id?: string }).device_id;
    const token = (request.headers['x-tradepilot-token'] as string | undefined) ?? (request.query as { device_token?: string }).device_token;
    if (!deviceId || !token) {
      throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Device credentials are required to poll commands.', 401);
    }
    const auth = await context.devices.authenticate(deviceId, token);
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 10) || 10, 25);
    const commands = await context.queue.takeQueued(auth.connection, limit);

    return {
      commands,
      server_time: new Date().toISOString(),
      protocol_version: '1.0.0',
      heartbeat_interval_ms: 3_000,
    };
  });

  app.post('/bridge/result', async (request) => {
    const { connection } = await authenticate(request);
    const body = envelopeBase.extend({ payload: z.record(z.unknown()) }).parse(request.body ?? {});
    const result = body.payload as unknown as EaExecutionResult;
    if (!result?.command_id) {
      throw new TradePilotError(ErrorCode.VALIDATION_FAILED, 'Execution result must contain command_id.', 400);
    }

    const stored = await context.queue.submitResult(connection, result);
    const payload = context.queue.toResultPayload(stored);

    await context.audit.record({
      userId: connection.userId,
      mode: 'LIVE',
      action: `EA_RESULT:${stored.action}`,
      symbol: stored.symbol || null,
      volume: payload.volume,
      price: payload.executionPrice,
      brokerTicket: payload.brokerTicket != null ? String(payload.brokerTicket) : null,
      result: payload.success ? 'SUCCESS' : 'FAILURE',
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
      deviceId: connection.deviceId,
      commandId: stored.commandId,
      detail: { retcode: payload.retcode, state: payload.state },
    });

    return { ok: true, command_id: stored.commandId, status: stored.status, server_time: new Date().toISOString() };
  });

  /* ------------------------------- utilities ----------------------------- */

  app.get('/bridge/history', async (request) => {
    const user = await requireUser(context, request);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query ?? {});
    const devices = await context.devices.listDevices(user.id);
    const stats = await context.queue.status(user.id);
    return {
      devices: devices.map((d) => d.deviceId),
      commandStats: stats,
      recentCommands: (
        await context.store.bridgeCommands.findMany(
          { userId: { eq: user.id } },
          { orderBy: [{ field: 'createdAt', direction: 'desc' }], limit: query.limit },
        )
      ).map((row) => ({
        commandId: row.commandId,
        action: row.action,
        symbol: row.symbol,
        status: row.status,
        attempts: row.attempts,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
      })),
    };
  });
}

function canonicalOf(context: AppContext, connection: Mt5ConnectionRow, symbol: string): string {
  const spec = context.market.liveSymbolsFor(connection.userId, connection.deviceId).find((s) => s.symbol === symbol);
  return spec?.canonical ?? symbol;
}
