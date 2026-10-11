import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ACCOUNT_TYPES, LEVERAGE_OPTIONS, TIMEFRAMES, type Timeframe, type ApiResult } from '../shared/types';
import { INSTRUMENTS } from './market/instruments';
import type { MarketData } from './market/marketData';
import type { TradingEngine } from './trading/engine';
import type { TradingAgent } from './agent/agent';
import { applyAgentPatch } from './agent/config';
import type { StateStore } from './persistence';
import type { MarketStatus } from '../shared/types';

export interface Services {
  market: MarketData;
  engine: TradingEngine;
  agent: TradingAgent;
  store: StateStore;
  marketStatus: () => MarketStatus;
  webDist: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: ApiResult<unknown>): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined);

function serveStatic(webDist: string, pathname: string, res: ServerResponse): void {
  const indexPath = join(webDist, 'index.html');
  if (!existsSync(indexPath)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The web UI is not built yet. Run "npm run build" in trading-platform/, or use "npm run dev".');
    return;
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = resolve(webDist, rel);
  if (!file.startsWith(resolve(webDist) + sep) && file !== resolve(webDist)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = indexPath; // SPA fallback
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': file === indexPath ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

export function createRequestHandler(s: Services) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { ok: false, error: 'Method not allowed' });
      return serveStatic(s.webDist, path, res);
    }

    try {
      const body = method === 'POST' || method === 'PUT' || method === 'DELETE' ? await readJson(req) : {};
      const data = route(s, method, path, url, body);
      if (data === undefined) throw new HttpError(404, 'Not found');
      const result = await data;
      send(res, 200, { ok: true, data: result });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.message });
      if (err instanceof RouteError) return send(res, err.status, { ok: false, error: err.message });
      console.error(err);
      send(res, 500, { ok: false, error: 'Internal server error' });
    }
  };
}

class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Returns a promise/value for the route, or undefined if no route matches. Failed trading actions throw RouteError(400). */
function route(
  s: Services,
  method: string,
  path: string,
  url: URL,
  body: Record<string, unknown>,
): unknown | Promise<unknown> | undefined {
  const { engine, market, agent } = s;
  const act = <T extends { ok: boolean; error?: string; data?: unknown }>(r: T): unknown => {
    if (!r.ok) throw new RouteError(400, r.error ?? 'Request failed');
    return r.data;
  };

  if (method === 'GET') {
    switch (path) {
      case '/api/health':
        return { time: Date.now(), market: s.marketStatus() };
      case '/api/config':
        return {
          instruments: INSTRUMENTS,
          accountTypes: ACCOUNT_TYPES,
          leverageOptions: LEVERAGE_OPTIONS,
          timeframes: TIMEFRAMES,
          market: s.marketStatus(),
        };
      case '/api/quotes':
        return engine.quotes();
      case '/api/bars': {
        const symbol = url.searchParams.get('symbol') ?? '';
        const tf = (url.searchParams.get('tf') ?? 'M15') as Timeframe;
        if (!market.has(symbol)) throw new RouteError(404, 'Unknown symbol');
        if (!TIMEFRAMES.includes(tf)) throw new RouteError(400, 'Unknown timeframe');
        const limit = Math.min(1000, Math.max(10, num(url.searchParams.get('limit')) ?? 500));
        return market.bars(symbol, tf, limit);
      }
      case '/api/account':
        return engine.full();
      case '/api/agent':
        return agent.status();
      case '/api/agent/logs':
        return agent.recentLogs(150);
      case '/api/agent/chat':
        return agent.chatHistory();
      default:
        return undefined;
    }
  }

  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const orderMatch = path.match(/^\/api\/orders\/(\d+)$/);
    if (method === 'DELETE' && orderMatch) return act(engine.cancelOrder(Number(orderMatch[1])));

    const posMatch = path.match(/^\/api\/positions\/(\d+)\/(close|modify)$/);
    if (method === 'POST' && posMatch) {
      const id = Number(posMatch[1]);
      if (posMatch[2] === 'close') {
        return act(engine.closePosition(id, { volume: num(body.volume), reason: 'manual' }));
      }
      const patch: { sl?: number | null; tp?: number | null } = {};
      if ('sl' in body) patch.sl = body.sl === null || body.sl === '' ? null : num(body.sl) ?? null;
      if ('tp' in body) patch.tp = body.tp === null || body.tp === '' ? null : num(body.tp) ?? null;
      return act(engine.modifyPosition(id, patch));
    }

    switch (path) {
      case '/api/orders': {
        if (method !== 'POST') return undefined;
        return act(
          engine.placeOrder({
            symbol: String(body.symbol ?? ''),
            side: body.side as 'buy' | 'sell',
            type: (body.type ?? 'market') as 'market' | 'limit' | 'stop',
            volume: num(body.volume) ?? NaN,
            price: num(body.price) ?? null,
            sl: num(body.sl) ?? null,
            tp: num(body.tp) ?? null,
            comment: typeof body.comment === 'string' ? body.comment.slice(0, 120) : '',
          }, 'manual'),
        );
      }
      case '/api/positions/close-all':
        return act(engine.closeAll({}, 'close_all'));
      case '/api/account/deposit':
        return act(engine.deposit(num(body.amount) ?? NaN));
      case '/api/account/withdraw':
        return act(engine.withdraw(num(body.amount) ?? NaN));
      case '/api/account/reset':
        return act(engine.reset());
      case '/api/account/settings':
        if (method !== 'PUT') return undefined;
        return act(
          engine.setSettings({
            accountType: body.accountType as never,
            leverage: num(body.leverage),
          }),
        );
      case '/api/agent': {
        if (method !== 'PUT') return undefined;
        const res = applyAgentPatch(agent.config, body, market.symbols());
        if (!res.ok) throw new RouteError(400, res.error);
        agent.setConfig(res.config);
        return agent.status();
      }
      case '/api/agent/chat': {
        if (method !== 'POST') return undefined;
        const message = typeof body.message === 'string' ? body.message : '';
        if (!message.trim()) throw new RouteError(400, 'Message is empty');
        return agent.chat(message);
      }
      default:
        return undefined;
    }
  }
  return undefined;
}

export { HttpError };
