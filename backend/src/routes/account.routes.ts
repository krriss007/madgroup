/**
 * TradePilot — account, risk, history and analytics routes.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RISK_PRESETS } from '../services/risk.service';
import type { AppContext } from '../http/context';
import { requireUser, resolveMode } from '../http/plugins';

export function registerAccountRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/account', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const { broker, account } = await context.brokers.forMode(user.id, mode);
    const snapshot = await broker.getAccount();
    const connection = mode === 'LIVE' ? await context.devices.connectionForAccount(account.id) : null;
    const risk = await context.risk.computeStatus(user.id, account, {
      liveTradingEnabled: user.liveTradingEnabled,
      brokerOnline: mode === 'DEMO' ? true : context.devices.isOnline(connection),
      killSwitchEngaged: user.killSwitchEngaged,
    });
    return {
      mode,
      account: snapshot,
      risk,
      liveTradingEnabled: user.liveTradingEnabled,
      killSwitchEngaged: user.killSwitchEngaged,
      startingBalance: account.startingBalance,
      mt5: context.devices.toDomain(connection),
    };
  });

  app.get('/account/risk', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const { account } = await context.brokers.forMode(user.id, mode);
    const connection = mode === 'LIVE' ? await context.devices.connectionForAccount(account.id) : null;
    const risk = await context.risk.computeStatus(user.id, account, {
      liveTradingEnabled: user.liveTradingEnabled,
      brokerOnline: mode === 'DEMO' ? true : context.devices.isOnline(connection),
      killSwitchEngaged: user.killSwitchEngaged,
    });
    const settings = await context.risk.getSettings(user.id);
    return {
      mode,
      risk,
      settings: context.risk.toDomain(settings),
      presets: RISK_PRESETS,
      lockedMessage: risk.locked ? 'DAILY LOSS LIMIT REACHED — TRADING LOCKED' : null,
    };
  });

  app.get('/account/portfolio', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const { broker, account } = await context.brokers.forMode(user.id, mode);
    const snapshot = await broker.getAccount();
    const series = await context.portfolio.series(user.id, account.id, 500);
    const headline = await context.analytics.headline(user.id, account.id, snapshot.balance, snapshot.equity);
    return { mode, account: snapshot, headline, series };
  });

  app.get('/analytics', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const query = z
      .object({ from: z.string().optional(), to: z.string().optional() })
      .parse(request.query ?? {});
    const { broker, account } = await context.brokers.forMode(user.id, mode);
    const snapshot = await broker.getAccount();
    const summary = await context.analytics.summary({
      mode,
      accountId: account.id,
      userId: user.id,
      startingBalance: account.startingBalance,
      currentBalance: snapshot.balance,
      currentEquity: snapshot.equity,
      from: query.from ? new Date(query.from) : null,
      to: query.to ? new Date(query.to) : null,
    });
    return { mode, summary };
  });

  app.get('/history', async (request) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const query = z
      .object({
        range: z.enum(['today', 'yesterday', '7d', '30d', 'custom', 'all']).default('30d'),
        from: z.string().optional(),
        to: z.string().optional(),
        symbol: z.string().optional(),
        side: z.enum(['BUY', 'SELL']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query ?? {});
    const { account } = await context.brokers.forMode(user.id, mode);
    const page = await context.history.page(user.id, account.id, {
      range: query.range,
      from: query.from ?? null,
      to: query.to ?? null,
      symbol: query.symbol ?? null,
      side: query.side ?? null,
      limit: query.limit,
      offset: query.offset,
    });
    return { mode, ...page };
  });

  app.get('/history/export.csv', async (request, reply) => {
    const user = await requireUser(context, request);
    const mode = resolveMode(request);
    const query = z.object({ range: z.enum(['today', 'yesterday', '7d', '30d', 'custom', 'all']).default('30d') }).parse(request.query ?? {});
    const { account } = await context.brokers.forMode(user.id, mode);
    const csv = await context.history.exportCsv(user.id, account.id, { range: query.range, limit: 500 });
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="tradepilot-${mode.toLowerCase()}-history.csv"`);
    return csv;
  });

  app.get('/audit', async (request) => {
    const user = await requireUser(context, request);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
        mode: z.enum(['DEMO', 'LIVE']).optional(),
      })
      .parse(request.query ?? {});
    const rows = await context.audit.list(user.id, { limit: query.limit, offset: query.offset, mode: query.mode });
    const total = await context.audit.count(user.id);
    return {
      total,
      immutable: true,
      note: 'The audit log is append-only: entries cannot be edited or deleted through the API or SQL.',
      entries: rows.map((row) => context.audit.toDomain(row)),
    };
  });
}
