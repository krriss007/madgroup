/**
 * TradePilot — HTTP middleware: authentication, CSRF, error mapping.
 *
 * Security posture (see docs/SECURITY.md):
 *   • Session cookie is httpOnly + SameSite=Lax + Secure in production.
 *   • Mutating requests require the double-submit CSRF token.
 *   • Every error is converted into a stable JSON shape with a machine-readable
 *     code so the UI can show the exact reason required by the spec.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ErrorCode, TradePilotError, type TradingMode } from '@tradepilot/shared';
import type { AppContext } from './context';
import { parseCookieHeader } from './context';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../services/auth.service';
import type { UserRow } from '../db/types';

declare module 'fastify' {
  interface FastifyRequest {
    tpUser?: UserRow;
    tpMode?: TradingMode;
  }
}

export interface RequestIdentity {
  user: UserRow;
  userId: string;
  mode: TradingMode;
  ip: string | null;
  userAgent: string | null;
}

/** Attach the session verification hook and request helpers. */
export function registerHttpPlugins(app: FastifyInstance, context: AppContext): void {
  app.decorateRequest('tpUser', undefined);
  app.decorateRequest('tpMode', undefined);

  app.decorate('context', context);
  app.decorate('requireUser', async function resolveCurrentUser(request: FastifyRequest): Promise<UserRow> {
    return requireUser(context, request);
  });
  app.decorate('identity', function identity(request: FastifyRequest, mode?: TradingMode): RequestIdentity {
    const user = request.tpUser!;
    return {
      user,
      userId: user.id,
      mode: mode ?? resolveMode(request),
      ip: request.ip ?? null,
      userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    };
  });
  app.decorate('requireCsrf', async function requireCsrf(request: FastifyRequest): Promise<void> {
    assertCsrf(request);
  });

  app.setErrorHandler((error, request, reply) => {
    // Request payload validation problems are the client's fault, not a server
    // fault: surface them as VALIDATION_FAILED with per-field details so the UI
    // can show exactly what is wrong.
    const tpError =
      error instanceof TradePilotError
        ? error
        : error instanceof ZodError
          ? new TradePilotError(ErrorCode.VALIDATION_FAILED, 'The request payload is invalid.', 400, {
              details: Object.fromEntries(
                error.issues.map((issue) => [issue.path.join('.') || '(root)', issue.message]),
              ),
            })
          : new TradePilotError(ErrorCode.INTERNAL, error.message || 'Unexpected server error.', (error as { statusCode?: number }).statusCode ?? 500);

    if (tpError.statusCode >= 500) {
      context.logger.error(
        { code: tpError.code, message: tpError.message, path: request.url, stack: (error as Error).stack },
        'request failed',
      );
    } else {
      // Thin transport diagnostics: when a caller is rejected because it has no
      // session, knowing whether it sent *neither* credential or a stale one
      // saves a lot of guesswork (and no secret values are logged).
      // Names deliberately avoid the logger's redaction list so the booleans and
      // key names survive (the values are never logged, only their presence).
      const transport: Record<string, unknown> = {};
      if (tpError.statusCode === 401 || tpError.statusCode === 403) {
        transport.sawAuthHeader = Boolean(request.headers.authorization);
        transport.sawSessionJar = Boolean(request.headers.cookie);
        transport.jarKeys = Object.keys(parseCookieHeader(request.headers.cookie));
        transport.requestOrigin = request.headers.origin ?? null;
        transport.agent = request.headers['user-agent'] ?? null;
      }
      context.logger.warn(
        { code: tpError.code, message: tpError.message, path: request.url, transport },
        'request rejected',
      );
    }

    void reply.status(tpError.statusCode).send(tpError.toJSON());
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: ErrorCode.NOT_FOUND, message: `No route for ${request.method} ${request.url}` },
    });
  });
}

/** Read the session cookie / bearer token and load the user. */
export async function requireUser(context: AppContext, request: FastifyRequest): Promise<UserRow> {
  if (request.tpUser) return request.tpUser;
  const cookies = parseCookieHeader(request.headers.cookie);
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
  // An explicit Authorization header wins over the cookie jar: it is the
  // credential the caller deliberately attached to *this* request, which lets a
  // client (or the frontend proxy) recover from a stale cookie without waiting
  // for it to expire. Both are the same signed, revocable session.
  const token = bearer ?? cookies[SESSION_COOKIE];
  if (!token) {
    throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Sign in to continue.', 401);
  }
  const session = await context.auth.verifySession(token);
  if (!session) {
    throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Your session has expired. Sign in again.', 401);
  }
  const user = await context.store.users.findById(session.id);
  if (!user) throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Session user not found.', 401);
  request.tpUser = user;
  return user;
}

/** Trading mode resolution: explicit query/body wins, default DEMO. */
export function resolveMode(request: FastifyRequest): TradingMode {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  const raw = (query.mode ?? body.mode) as string | undefined;
  return raw?.toUpperCase() === 'LIVE' ? 'LIVE' : 'DEMO';
}

/** Double-submit CSRF check for state-changing requests. */
export function assertCsrf(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
  const cookies = parseCookieHeader(request.headers.cookie);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = (request.headers[CSRF_HEADER] as string | undefined) ?? (request.headers['x-xsrf-token'] as string | undefined);
  // Bearer-token clients (scripts, tests) bypass the cookie CSRF flow: they are
  // not vulnerable to cookie-based cross-site requests.
  const usesBearer = Boolean(request.headers.authorization);
  if (usesBearer) return;
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw new TradePilotError(
      ErrorCode.CSRF_INVALID,
      'CSRF validation failed. Refresh the page and try again.',
      403,
    );
  }
}

export function requireLiveAcknowledged(request: FastifyRequest): void {
  if (request.tpUser && !request.tpUser.liveRiskAcknowledgedAt) {
    throw new TradePilotError(
      ErrorCode.LIVE_TRADING_DISABLED,
      'Acknowledge the live trading risk warning before using live features.',
      403,
    );
  }
}

export type { FastifyReply, FastifyRequest };
