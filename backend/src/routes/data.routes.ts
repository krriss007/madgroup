/**
 * TradePilot — journal, alerts, notifications and watchlists routes.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_WATCHLIST, ErrorCode, TradePilotError, canonicalize } from '@tradepilot/shared';
import type { AppContext } from '../http/context';
import { assertCsrf, requireUser } from '../http/plugins';

const journalSchema = z.object({
  tradeId: z.string().max(80).nullable().optional(),
  ticket: z.string().max(40).nullable().optional(),
  symbol: z.string().max(40).nullable().optional(),
  setup: z.string().max(8000).nullable().optional(),
  reasonForEntry: z.string().max(8000).nullable().optional(),
  marketConditions: z.string().max(8000).nullable().optional(),
  emotion: z.string().max(8000).nullable().optional(),
  mistakes: z.string().max(8000).nullable().optional(),
  lesson: z.string().max(8000).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  rating: z.number().min(1).max(5).nullable().optional(),
  screenshotUrl: z.string().url().max(2000).nullable().optional(),
});

export function registerDataRoutes(app: FastifyInstance, context: AppContext): void {
  /* ------------------------------- journal ------------------------------- */

  app.get('/journal', async (request) => {
    const user = await requireUser(context, request);
    const query = z
      .object({
        ticket: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(300).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query ?? {});
    const entries = await context.journal.list(user.id, query);
    return { entries };
  });

  app.post('/journal', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = journalSchema.parse(request.body ?? {});
    const entry = await context.journal.create(user.id, body);
    return { entry };
  });

  app.patch('/journal/:id', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = journalSchema.partial().parse(request.body ?? {});
    const entry = await context.journal.update(user.id, params.id, body);
    return { entry };
  });

  app.delete('/journal/:id', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const removed = await context.journal.remove(user.id, params.id);
    if (!removed) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Journal entry not found.', 404);
    return { ok: true };
  });

  /* -------------------------------- alerts ------------------------------- */

  app.get('/alerts', async (request) => {
    const user = await requireUser(context, request);
    return { alerts: await context.alerts.list(user.id) };
  });

  app.post('/alerts', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = z
      .object({
        symbol: z.string().min(1).max(40),
        condition: z.enum(['ABOVE', 'BELOW']),
        price: z.number().positive(),
        note: z.string().max(200).nullable().optional(),
      })
      .parse(request.body ?? {});
    const alert = await context.alerts.create(user.id, body);
    return { alert };
  });

  app.delete('/alerts/:id', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const removed = await context.alerts.remove(user.id, params.id);
    if (!removed) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Alert not found.', 404);
    return { ok: true };
  });

  /* ----------------------------- notifications --------------------------- */

  app.get('/notifications', async (request) => {
    const user = await requireUser(context, request);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query ?? {});
    const [notifications, unread] = await Promise.all([
      context.notifications.list(user.id, query.limit),
      context.notifications.unreadCount(user.id),
    ]);
    return { notifications, unread };
  });

  app.post('/notifications/:id/read', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    await context.notifications.markRead(user.id, params.id);
    return { ok: true, unread: await context.notifications.unreadCount(user.id) };
  });

  app.post('/notifications/read-all', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const updated = await context.notifications.markAllRead(user.id);
    return { ok: true, updated };
  });

  /* ------------------------------ watchlists ----------------------------- */

  app.get('/watchlists', async (request) => {
    const user = await requireUser(context, request);
    const mode = (request.query as { mode?: string }).mode?.toUpperCase() === 'LIVE' ? 'LIVE' : 'DEMO';
    const device = mode === 'LIVE' ? await context.devices.connectionForUser(user.id) : null;

    let list = await context.store.watchlists.findOne({ userId: { eq: user.id }, isDefault: { eq: true } });
    if (!list) {
      await context.accounts.ensureDefaultWatchlist(user.id);
      list = await context.store.watchlists.findOne({ userId: { eq: user.id }, isDefault: { eq: true } });
    }
    if (!list) throw new TradePilotError(ErrorCode.INTERNAL, 'Default watchlist is unavailable.', 500);

    const items = await context.store.watchlistItems.findMany(
      { watchlistId: { eq: list.id } },
      { orderBy: [{ field: 'position', direction: 'asc' }] },
    );
    const symbols = items.map((item) => item.symbol);
    const quotes = await context.market.getQuotes(mode, user.id, symbols, device?.deviceId ?? null);
    const specs = await context.market.listSymbols(mode, user.id, device?.deviceId ?? null);
    const resolved = items.map((item) => {
      const spec = specs.find((s) => s.canonical === item.canonical || s.symbol === item.symbol);
      return {
        ...item,
        brokerSymbol: spec?.symbol ?? null,
        available: Boolean(spec),
      };
    });

    return {
      mode,
      watchlist: { id: list.id, name: list.name, isDefault: list.isDefault, createdAt: list.createdAt },
      items: resolved,
      quotes,
      online: mode === 'DEMO' ? true : context.devices.isOnline(device),
      message: mode === 'LIVE' && !context.devices.isOnline(device) ? 'MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE' : null,
      defaults: DEFAULT_WATCHLIST,
    };
  });

  app.post('/watchlists/:id/items', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ symbol: z.string().min(1).max(40) }).parse(request.body ?? {});

    const list = await context.store.watchlists.findById(params.id);
    if (!list || list.userId !== user.id) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Watchlist not found.', 404);

    const mode = (request.body as { mode?: string })?.mode?.toUpperCase() === 'LIVE' ? 'LIVE' : 'DEMO';
    const device = mode === 'LIVE' ? await context.devices.connectionForUser(user.id) : null;
    const spec = await context.market
      .getSymbolSpec(mode, user.id, body.symbol, device?.deviceId ?? null)
      .catch(() => null);

    const items = await context.store.watchlistItems.findMany({ watchlistId: { eq: list.id } });
    if (items.some((item) => item.canonical === canonicalize(body.symbol))) {
      throw new TradePilotError(ErrorCode.CONFLICT, `${body.symbol} is already in this watchlist.`, 409);
    }
    if (items.length >= 50) throw new TradePilotError(ErrorCode.CONFLICT, 'A watchlist can hold at most 50 instruments.', 409);

    const item = {
      id: `wli_${list.id}_${canonicalize(body.symbol)}`.replace(/[^A-Za-z0-9_.-]/g, '_'),
      watchlistId: list.id,
      userId: user.id,
      symbol: spec?.symbol ?? body.symbol,
      canonical: canonicalize(body.symbol),
      position: items.length,
      createdAt: new Date().toISOString(),
    };
    await context.store.watchlistItems.insert(item);
    return { item, resolved: Boolean(spec), warning: spec ? null : 'Symbol not reported by your broker yet.' };
  });

  app.delete('/watchlists/:id/items/:canonical', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1), canonical: z.string().min(1) }).parse(request.params);
    const list = await context.store.watchlists.findById(params.id);
    if (!list || list.userId !== user.id) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Watchlist not found.', 404);
    const items = await context.store.watchlistItems.findMany({ watchlistId: { eq: list.id } });
    const target = items.find((item) => item.canonical === canonicalize(params.canonical));
    if (!target) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Symbol is not in this watchlist.', 404);
    if (items.length <= 1) throw new TradePilotError(ErrorCode.CONFLICT, 'A watchlist must contain at least one instrument.', 409);
    await context.store.watchlistItems.delete(target.id);
    return { ok: true };
  });
}
