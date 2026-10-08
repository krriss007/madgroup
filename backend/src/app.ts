/**
 * TradePilot — Fastify application factory.
 *
 * Plugins: cookies, CORS (credentials enabled for the SPA), Helmet, rate
 * limiting. Routes are versioned under /api/v1. The WebSocket hub shares the
 * same HTTP server so the SPA can use a single origin.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ErrorCode } from '@tradepilot/shared';
import { corsOrigins } from './config/env';
import { createContext, type AppContext } from './http/context';
import { registerHttpPlugins } from './http/plugins';
import { registerAuthRoutes } from './routes/auth.routes';
import { registerSystemRoutes } from './routes/system.routes';
import { registerMarketRoutes } from './routes/market.routes';
import { registerAccountRoutes } from './routes/account.routes';
import { registerTradingRoutes } from './routes/trading.routes';
import { registerDataRoutes } from './routes/data.routes';
import { registerSettingsRoutes } from './routes/settings.routes';
import { registerBridgeRoutes } from './routes/bridge.routes';
declare module 'fastify' {
  interface FastifyInstance {
    context: AppContext;
    requireUser(request: import('fastify').FastifyRequest): Promise<import('./db/types').UserRow>;
    identity(request: import('fastify').FastifyRequest, mode?: import('@tradepilot/shared').TradingMode): import('./http/plugins').RequestIdentity;
    requireCsrf(request: import('fastify').FastifyRequest): Promise<void>;
  }
}

export interface BuildAppOptions {
  context?: AppContext;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<{ app: FastifyInstance; context: AppContext }> {
  const context = options.context ?? (await createContext());

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1_048_576,
    disableRequestLogging: true,
    genReqId: () => Math.random().toString(36).slice(2, 12),
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: corsOrigins(context.env),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-tradepilot-device', 'x-tradepilot-token', 'authorization'],
    maxAge: 3_600,
  });
  await app.register(helmet, {
    contentSecurityPolicy: false, // the SPA is served by Next.js, not by this API
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: [],
    errorResponseBuilder: () => ({
      error: { code: ErrorCode.RATE_LIMITED, message: 'Too many requests. Please slow down.' },
    }),
  });

  registerHttpPlugins(app, context);

  await app.register(
    async (scope) => {
      registerSystemRoutes(scope, context);
      registerAuthRoutes(scope, context);
      registerMarketRoutes(scope, context);
      registerAccountRoutes(scope, context);
      registerTradingRoutes(scope, context);
      registerDataRoutes(scope, context);
      registerSettingsRoutes(scope, context);
      registerBridgeRoutes(scope, context);
    },
    { prefix: '/api/v1' },
  );

  app.get('/', async () => ({
    name: 'TradePilot API',
    version: '1.0.0',
    docs: '/api/v1/system/config',
    websocket: '/ws',
    health: '/api/v1/system/health',
  }));

  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    if (status >= 500) {
      context.logger.error({ method: request.method, url: request.url, status, durationMs: reply.elapsedTime }, 'http error response');
    } else if (status >= 400) {
      context.logger.debug({ method: request.method, url: request.url, status, durationMs: reply.elapsedTime }, 'http rejected');
    }
  });

  return { app, context };
}

