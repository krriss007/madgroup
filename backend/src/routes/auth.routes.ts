/**
 * TradePilot — authentication routes.
 * POST /api/v1/auth/register | /login | /logout | /change-password
 * GET  /api/v1/auth/session
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, TradePilotError } from '@tradepilot/shared';
import type { AppContext } from '../http/context';
import { requireUser } from '../http/plugins';
import { demoAutoLoginEnabled } from '../config/env';
import { CSRF_COOKIE, SESSION_COOKIE } from '../services/auth.service';

const registerSchema = z.object({
  email: z.string().email().max(160),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(60).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(160),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

/**
 * Session transport.
 *
 * Cookies are the primary transport: httpOnly, SameSite-controlled, revocable.
 * Some embedding environments (cross-site iframes, sandboxed frames with an
 * opaque origin, hardened browsers, mobile WebViews) refuse to store third-party
 * cookies *and* web storage, which would leave the user signed in for exactly
 * one request.
 *
 * Every auth response therefore carries the same session as a bearer token in
 * the response body, in addition to the cookie. The client keeps the cookie path
 * when it works, and falls back to `Authorization: Bearer …` when it does not.
 * Both are the same signed session with the same TTL and the same server-side
 * revocation (token_version), and returning it to the client that just proved
 * its credentials is exactly what an OAuth token endpoint does — no secret is
 * exposed that the caller did not already possess.
 */
type SessionTokenBody = { session: { token: string; csrfToken: string; expiresAt: string } };

function sessionBody(session: { token: string; csrfToken: string; expiresAt: Date }): SessionTokenBody {
  return {
    session: {
      token: session.token,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    },
  };
}

function usesBearerTransport(request: FastifyRequest): boolean {
  return /^Bearer\s+/i.test(request.headers.authorization ?? '');
}

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const setSessionCookies = (reply: FastifyReply, token: string, csrfToken: string, expiresAt: Date): void => {
    const options = context.auth.cookieOptions();
    void reply.setCookie(SESSION_COOKIE, token, options);
    void reply.setCookie(CSRF_COOKIE, csrfToken, {
      ...options,
      httpOnly: false, // readable by the SPA for the double-submit header
      maxAge: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    });
  };

  app.post('/auth/register', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = registerSchema.parse(request.body ?? {});
    const { user, session } = await context.auth.register(body);
    setSessionCookies(reply, session.token, session.csrfToken, session.expiresAt);
    const account = await context.accounts.ensureDemoAccount(user.id);
    return {
      user: context.auth.toProfile(user),
      account: context.accounts.toDomain(account),
      mode: 'DEMO',
      csrfToken: session.csrfToken,
      ...sessionBody(session),
    };
  });

  app.post('/auth/login', { config: { rateLimit: { max: 12, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body ?? {});
    const { user, session } = await context.auth.login(body.email, body.password, request.ip ?? null);
    setSessionCookies(reply, session.token, session.csrfToken, session.expiresAt);
    const account = await context.accounts.ensureDemoAccount(user.id);
    context.logger.info({ userId: user.id, ip: request.ip }, 'user signed in');
    return {
      user: context.auth.toProfile(user),
      account: context.accounts.toDomain(account),
      mode: 'DEMO',
      csrfToken: session.csrfToken,
      ...sessionBody(session),
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    try {
      const user = await requireUser(context, request);
      await context.auth.revokeSessions(user.id);
    } catch (error) {
      if (!(error instanceof TradePilotError)) throw error;
    }
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    void reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });

  /**
   * Password-less entry into the shared DEMO account.
   *
   * Enabled by DEMO_AUTO_LOGIN (default: on outside production when the demo
   * user is seeded). It creates the demo user if it is missing, then issues an
   * ordinary session for it — nothing more. It can never mint a LIVE session:
   * live trading still needs an authorized MT5 bridge, the user's live-trading
   * opt-in and the risk acknowledgement, all of which stay switched off.
   */
  // Embedded/sandboxed frames cannot persist a session across page loads, so a
  // reload legitimately re-enters. The limit allows that without opening a
  // brute-force surface (it needs no credentials at all).
  app.post('/auth/demo-session', { config: { rateLimit: { max: 240, timeWindow: '5 minutes' } } }, async (request, reply) => {
    if (!demoAutoLoginEnabled(context.env)) {
      throw new TradePilotError(
        ErrorCode.FORBIDDEN,
        'Demo auto-entry is disabled on this instance (DEMO_AUTO_LOGIN). Sign in normally, or enable it in the backend environment.',
        403,
      );
    }

    const email = context.env.DEMO_USER_EMAIL.trim().toLowerCase();
    let user = await context.store.users.findOne({ email: { eq: email } });
    let created = false;
    if (!user) {
      const registered = await context.auth.register({
        email,
        password: context.env.DEMO_USER_PASSWORD,
        displayName: 'Demo Trader',
      });
      user = registered.user;
      created = true;
      context.logger.warn({ userId: user.id }, 'demo user created by demo auto-entry — change this password before any real deployment');
    }

    const session = await context.auth.issueSession(user);
    const account = await context.accounts.ensureDemoAccount(user.id);
    setSessionCookies(reply, session.token, session.csrfToken, session.expiresAt);
    await context.audit.record({
      userId: user.id,
      mode: 'DEMO',
      action: 'DEMO_SESSION_ISSUED',
      result: 'SUCCESS',
      ip: request.ip ?? null,
      userAgent: (request.headers['user-agent'] as string) ?? null,
      detail: { created, autoLogin: true },
    });
    context.logger.info({ userId: user.id, ip: request.ip, created }, 'demo session issued without password (DEMO_AUTO_LOGIN)');

    return {
      user: context.auth.toProfile(user),
      account: context.accounts.toDomain(account),
      mode: 'DEMO' as const,
      liveTradingEnabled: user.liveTradingEnabled,
      csrfToken: session.csrfToken,
      autoLogin: true,
      created,
      ...sessionBody(session),
    };
  });

  app.get('/auth/demo-session', async () => ({
    // Lets the UI show or hide the "Continue in DEMO mode" affordance honestly.
    available: demoAutoLoginEnabled(context.env),
    email: context.env.DEMO_USER_EMAIL,
  }));

  app.get('/auth/session', async (request) => {
    const user = await requireUser(context, request);
    const accounts = await context.accounts.listAccounts(user.id);
    const demo = accounts.find((a) => a.mode === 'DEMO') ?? (await context.accounts.ensureDemoAccount(user.id));
    const live = accounts.find((a) => a.mode === 'LIVE') ?? null;

    const bearer = usesBearerTransport(request);
    const refreshed = bearer ? await context.auth.issueSession(user) : null;
    return {
      user: context.auth.toProfile(user),
      accounts: accounts.map((account) => context.accounts.toDomain(account)),
      activeAccount: context.accounts.toDomain(demo),
      liveAccount: live ? context.accounts.toDomain(live) : null,
      mode: 'DEMO' as const,
      liveTradingEnabled: user.liveTradingEnabled,
      killSwitchEngaged: user.killSwitchEngaged,
      /** How this session was authenticated — the client mirrors it. */
      transport: bearer ? ('bearer' as const) : ('cookie' as const),
      // A bearer client gets a sliding token: every successful session read
      // extends the session, so an active terminal is never signed out.
      ...(refreshed ? sessionBody(refreshed) : {}),
    };
  });

  app.post('/auth/change-password', async (request, reply) => {
    const user = await requireUser(context, request);
    const body = changePasswordSchema.parse(request.body ?? {});
    const session = await context.auth.changePassword(user.id, body.currentPassword, body.newPassword);
    setSessionCookies(reply, session.token, session.csrfToken, session.expiresAt);
    await context.audit.record({
      userId: user.id,
      mode: 'DEMO',
      action: 'PASSWORD_CHANGED',
      result: 'SUCCESS',
      ip: request.ip ?? null,
      userAgent: (request.headers['user-agent'] as string) ?? null,
    });
    return {
      ok: true,
      message: 'Password updated. All other sessions were signed out.',
      csrfToken: session.csrfToken,
      ...sessionBody(session),
    };
  });

  app.get('/auth/csrf', async (request, reply) => {
    // Issues a fresh CSRF cookie for clients that lost it (e.g. after a reload
    // with cookies disabled for JS) without needing a full login.
    const user = await requireUser(context, request);
    const session = await context.auth.issueSession(user);
    const options = context.auth.cookieOptions();
    void reply.setCookie(SESSION_COOKIE, session.token, options);
    void reply.setCookie(CSRF_COOKIE, session.csrfToken, { ...options, httpOnly: false });
    if (context.env.NODE_ENV === 'production' && !context.env.COOKIE_SECURE) {
      context.logger.debug({}, 'csrf token refreshed in non-secure cookie mode');
    }
    return { csrfToken: session.csrfToken };
  });

  app.get('/auth/me', async (request) => {
    const user = await requireUser(context, request);
    if (!user) throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Sign in to continue.', 401);
    return { user: context.auth.toProfile(user) };
  });
}
