/**
 * TradePilot — trading routes (orders, positions, emergency controls).
 *
 * Every mutating route is authenticated + CSRF protected, and every order goes
 * through OrderService so validation, risk checks, idempotency, audit logging
 * and realtime broadcasts are applied identically for DEMO and LIVE.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCode, TradePilotError, type OrderSide, type OrderType } from '@tradepilot/shared';
import type { AppContext } from '../http/context';
import { assertCsrf, requireUser, resolveMode } from '../http/plugins';
import { CLOSE_ALL_CONFIRMATION } from '../services/execution/order.service';

const sideSchema = z.enum(['BUY', 'SELL']);
const orderTypeSchema = z.enum(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT']);

const orderSchema = z.object({
  mode: z.enum(['DEMO', 'LIVE']).optional(),
  symbol: z.string().min(1).max(40),
  side: sideSchema,
  type: orderTypeSchema.default('MARKET'),
  volume: z.number().positive().max(10_000),
  price: z.number().positive().nullable().optional(),
  stopLimitPrice: z.number().positive().nullable().optional(),
  stopLoss: z.number().positive().nullable().optional(),
  takeProfit: z.number().positive().nullable().optional(),
  expiration: z.string().nullable().optional(),
  comment: z.string().max(200).nullable().optional(),
  clientRequestId: z.string().min(6).max(80),
  confirmed: z.boolean().optional(),
  useRiskBasedSize: z.boolean().optional(),
  riskPercent: z.number().positive().max(100).nullable().optional(),
});

export function registerTradingRoutes(app: FastifyInstance, context: AppContext): void {
  /* ------------------------------------------------------------------ */
  /* pre-flight preview                                                 */
  /* ------------------------------------------------------------------ */

  app.post('/trading/preview', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = orderSchema.parse(request.body ?? {});
    const mode = body.mode ?? resolveMode(request);
    const preview = await context.orders.preview(
      {
        symbol: body.symbol,
        side: body.side as OrderSide,
        type: body.type as OrderType,
        volume: body.volume,
        price: body.price ?? null,
        stopLimitPrice: body.stopLimitPrice ?? null,
        stopLoss: body.stopLoss ?? null,
        takeProfit: body.takeProfit ?? null,
        expiration: body.expiration ?? null,
        comment: body.comment ?? null,
        clientRequestId: body.clientRequestId,
        useRiskBasedSize: body.useRiskBasedSize,
        riskPercent: body.riskPercent ?? null,
      },
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
    );
    return preview;
  });

  /* ------------------------------------------------------------------ */
  /* order placement                                                    */
  /* ------------------------------------------------------------------ */

  app.post('/trading/orders', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = orderSchema.parse(request.body ?? {});
    const mode = body.mode ?? resolveMode(request);

    const result = await context.orders.placeOrder(
      {
        symbol: body.symbol,
        side: body.side as OrderSide,
        type: body.type as OrderType,
        volume: body.volume,
        price: body.price ?? null,
        stopLimitPrice: body.stopLimitPrice ?? null,
        stopLoss: body.stopLoss ?? null,
        takeProfit: body.takeProfit ?? null,
        expiration: body.expiration ?? null,
        comment: body.comment ?? null,
        clientRequestId: body.clientRequestId,
        confirmed: body.confirmed,
        useRiskBasedSize: body.useRiskBasedSize,
        riskPercent: body.riskPercent ?? null,
      },
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
    );

    if (context.hub) {
      context.hub.toUser(user.id, {
        type: 'execution',
        commandId: result.report.commandId,
        action: body.type === 'MARKET' ? 'OPEN_MARKET_ORDER' : 'PLACE_PENDING_ORDER',
        success: result.report.success,
        ticket: result.report.ticket ?? undefined,
        price: result.report.executionPrice ?? undefined,
        volume: result.report.volume ?? undefined,
        errorCode: result.report.errorCode ?? undefined,
        errorMessage: result.report.errorMessage ?? undefined,
        mode,
        at: result.report.at,
      });
    }

    return {
      mode,
      success: result.report.success,
      ticket: result.report.ticket,
      executionPrice: result.report.executionPrice,
      volume: result.report.volume,
      at: result.report.at,
      commandId: result.report.commandId,
      position: result.position ?? null,
      order: result.order ?? null,
    };
  });

  app.get('/trading/orders', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const { account } = await context.brokers.forMode(user.id, mode);
    const rows = await context.store.orders.findMany(
      { accountId: { eq: account.id }, status: { eq: 'PENDING' } },
      { orderBy: [{ field: 'placedAt', direction: 'desc' }] },
    );
    return {
      mode,
      orders: rows.map((row) => ({
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
        accountLogin: account.login,
        source: row.source,
      })),
    };
  });

  app.patch('/trading/orders/:ticket', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ ticket: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        mode: z.enum(['DEMO', 'LIVE']).optional(),
        price: z.number().positive().nullable().optional(),
        stopLoss: z.number().positive().nullable().optional(),
        takeProfit: z.number().positive().nullable().optional(),
        expiration: z.string().nullable().optional(),
        clientRequestId: z.string().min(6).max(80),
      })
      .parse(request.body ?? {});
    const mode = body.mode ?? resolveMode(request);
    const result = await context.orders.modifyOrder(
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      {
        ticket: params.ticket,
        price: body.price ?? null,
        stopLoss: body.stopLoss ?? null,
        takeProfit: body.takeProfit ?? null,
        expiration: body.expiration ?? null,
        clientRequestId: body.clientRequestId,
      },
    );
    return { mode, success: result.report.success, order: result.order ?? null };
  });

  app.delete('/trading/orders/:ticket', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ ticket: z.string().min(1) }).parse(request.params);
    const body = z
      .object({ mode: z.enum(['DEMO', 'LIVE']).optional(), clientRequestId: z.string().min(6).max(80) })
      .parse(request.body ?? { clientRequestId: `cancel-${params.ticket}-${Date.now()}` });
    const mode = body.mode ?? resolveMode(request);
    const result = await context.orders.cancelOrder(
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      { ticket: params.ticket, clientRequestId: body.clientRequestId },
    );
    return { mode, success: result.report.success, order: result.order ?? null };
  });

  app.post('/trading/orders/cancel-all', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = z
      .object({
        mode: z.enum(['DEMO', 'LIVE']).optional(),
        clientRequestId: z.string().min(6).max(80),
        confirm: z.string().optional(),
      })
      .parse(request.body ?? {});
    const mode = body.mode ?? resolveMode(request);
    if (mode === 'LIVE' && (body.confirm ?? '').trim().toUpperCase() !== 'CANCEL ALL PENDING ORDERS') {
      throw new TradePilotError(
        ErrorCode.CONFIRMATION_MISMATCH,
        'Cancelling all live pending orders requires the confirmation text "CANCEL ALL PENDING ORDERS".',
        400,
      );
    }
    const result = await context.orders.cancelAllOrders(
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      { clientRequestId: body.clientRequestId },
    );
    return { mode, success: result.report.success, cancelled: result.report.affected ?? 0, error: result.report.errorMessage };
  });

  /* ------------------------------------------------------------------ */
  /* positions                                                          */
  /* ------------------------------------------------------------------ */

  app.get('/trading/positions', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const { account } = await context.brokers.forMode(user.id, mode);
    const rows = await context.store.positions.findMany(
      { accountId: { eq: account.id } },
      { orderBy: [{ field: 'openTime', direction: 'desc' }] },
    );
    const positions = rows.map((row) => ({
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
    }));
    const totals = {
      count: positions.length,
      volume: positions.reduce((acc, p) => acc + p.volume, 0),
      profit: positions.reduce((acc, p) => acc + p.profit, 0),
      swap: positions.reduce((acc, p) => acc + p.swap, 0),
      commission: positions.reduce((acc, p) => acc + p.commission, 0),
    };
    return { mode, positions, totals };
  });

  app.patch('/trading/positions/:ticket', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ ticket: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        mode: z.enum(['DEMO', 'LIVE']).optional(),
        stopLoss: z.number().positive().nullable().optional(),
        takeProfit: z.number().positive().nullable().optional(),
        clientRequestId: z.string().min(6).max(80),
      })
      .parse(request.body ?? {});
    const mode = body.mode ?? resolveMode(request);
    const result = await context.orders.modifyPosition(
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      {
        ticket: params.ticket,
        stopLoss: body.stopLoss,
        takeProfit: body.takeProfit,
        clientRequestId: body.clientRequestId,
      },
    );
    return { mode, success: result.report.success, position: result.position ?? null };
  });

  app.post('/trading/positions/:ticket/close', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ ticket: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        mode: z.enum(['DEMO', 'LIVE']).optional(),
        volume: z.number().positive().nullable().optional(),
        reason: z.string().max(200).nullable().optional(),
        clientRequestId: z.string().min(6).max(80),
        confirm: z.string().optional(),
      })
      .parse(request.body ?? {});
    const mode = body.mode ?? resolveMode(request);
    if (mode === 'LIVE' && (body.confirm ?? '').trim().length === 0) {
      throw new TradePilotError(
        ErrorCode.CONFIRMATION_REQUIRED,
        'Closing a live position requires explicit confirmation (type CLOSE or send confirm).',
        409,
      );
    }
    const result = await context.orders.closePosition(
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      {
        ticket: params.ticket,
        volume: body.volume ?? null,
        reason: body.reason ?? null,
        clientRequestId: body.clientRequestId,
      },
    );
    if (context.hub) {
      context.hub.toUser(user.id, {
        type: 'execution',
        commandId: result.report.commandId,
        action: 'CLOSE_POSITION',
        success: result.report.success,
        ticket: params.ticket,
        price: result.report.executionPrice ?? undefined,
        volume: result.report.volume ?? undefined,
        mode,
        at: result.report.at,
      });
    }
    return {
      mode,
      success: result.report.success,
      realizedPl: result.report.realizedPl ?? null,
      executionPrice: result.report.executionPrice ?? null,
    };
  });

  app.post('/trading/positions/close-all', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = z
      .object({
        mode: z.enum(['DEMO', 'LIVE']).optional(),
        confirm: z.string(),
        symbol: z.string().nullable().optional(),
        reason: z.string().max(200).nullable().optional(),
        clientRequestId: z.string().min(6).max(80),
      })
      .parse(request.body ?? {});

    if (body.confirm.trim().toUpperCase() !== CLOSE_ALL_CONFIRMATION) {
      throw new TradePilotError(
        ErrorCode.CONFIRMATION_MISMATCH,
        `To close every position you must type "${CLOSE_ALL_CONFIRMATION}" exactly.`,
        400,
      );
    }
    const mode = body.mode ?? resolveMode(request);
    const result = await context.orders.closeAllPositions(
      { userId: user.id, mode, ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      {
        confirm: body.confirm,
        symbol: body.symbol ?? null,
        reason: body.reason ?? null,
        clientRequestId: body.clientRequestId,
      },
    );
    return {
      mode,
      success: result.report.success,
      affected: result.report.affected ?? 0,
      realizedPl: result.report.realizedPl ?? null,
      errorMessage: result.report.errorMessage,
    };
  });

  /* ------------------------------------------------------------------ */
  /* live trading controls                                              */
  /* ------------------------------------------------------------------ */

  app.post('/trading/live/enable', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = z.object({ acknowledged: z.boolean() }).parse(request.body ?? {});
    const result = await context.orders.enableLiveTrading(
      { userId: user.id, mode: 'LIVE', ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      body.acknowledged,
    );
    return { ...result, warning: '🔴 LIVE TRADING ENABLED — orders use real money.' };
  });

  app.post('/trading/live/disable', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = z.object({ reason: z.string().max(200).optional() }).parse(request.body ?? {});
    const result = await context.orders.disableLiveTrading(
      { userId: user.id, mode: 'LIVE', ip: request.ip ?? null, userAgent: (request.headers['user-agent'] as string) ?? null },
      body.reason ?? 'Disabled by the user (emergency switch).',
    );
    return { ...result, message: 'LIVE trading disabled. New live orders will be rejected until you enable it again.' };
  });
}
