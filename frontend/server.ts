/**
 * TradePilot — frontend dev/production server.
 *
 * Serves the Next.js app, the static MT5 downloads and proxies /api/* and /ws
 * to the backend so
 * the browser only ever talks to a single origin. The frontend therefore never
 * needs to know the backend's internal address at runtime, and no CORS or
 * mixed-content problems can appear.
 *
 * SESSION HANDLING — why the proxy does it
 * ----------------------------------------
 * Cookies are the primary session transport, but embedded/sandboxed frames
 * (preview panes, cross-site iframes with an opaque origin, hardened browsers)
 * refuse to store them *and* refuse web storage. In that situation the browser
 * can prove who it is to nobody: every request arrives with no cookie and no
 * Authorization header, so the terminal would bounce back to the sign-in page
 * forever.
 *
 * When the backend reports that password-less demo entry is enabled
 * (DEMO_AUTO_LOGIN, never in production by default), this server therefore keeps
 * one DEMO session of its own and attaches it to *unauthenticated* API requests
 * on their way through. Nothing is handed to the browser's storage, so a frame
 * that can hold nothing still gets a working terminal on the first paint.
 *
 * Guarantees:
 *   • Only requests that carry NO usable credential are touched. An explicit
 *     Authorization header is never overridden, and a cookie that the backend
 *     accepts is never overridden either: a cookie value is only treated as
 *     replaceable after the backend itself rejected it (stale cookie from an
 *     earlier deployment or a signed-out session).
 *   • Only DEMO. The injected session belongs to the seeded demo user; LIVE
 *     trading still requires the MT5 bridge, the user's live opt-in and the
 *     risk acknowledgement, none of which this server can grant.
 *   • Cross-site requests are never authenticated — `Sec-Fetch-Site: cross-site`
 *     and mutating requests whose Origin does not match this host get nothing,
 *     so the demo session cannot be used as a CSRF bypass.
 *   • Auth endpoints stay anonymous (login/register/logout/demo-session), so
 *     signing in with a real account and signing out both keep working.
 *   • Disable with AUTO_DEMO_SESSION=false.
 *
 * Env:
 *   BACKEND_URL          http://127.0.0.1:8080  (default)
 *   PORT                 3000                   (default)
 *   HOST                 0.0.0.0                (default; must stay bindable in Docker)
 *   AUTO_DEMO_SESSION    true                   (server-side demo session for credential-less API calls)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import httpProxy from 'http-proxy';

const port = Number(process.env.PORT ?? 3000);
// NOTE: never read process.env.HOSTNAME here — containers often set it to the
// machine name, which would stop the preview from being reachable. Use HOST.
const hostname = process.env.HOST ?? '0.0.0.0';
const backendUrl = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8080';
const autoDemoSession = (process.env.AUTO_DEMO_SESSION ?? 'true').toLowerCase() !== 'false';
const dev = process.env.NODE_ENV !== 'production';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const proxy = httpProxy.createProxyServer({
  target: backendUrl,
  changeOrigin: true,
  ws: true,
  xfwd: true,
});

/* ------------------------------------------------------------------ */
/* Server-side demo session                                            */
/* ------------------------------------------------------------------ */

interface DemoSession {
  token: string;
  expiresAt: number;
}

let demoSession: DemoSession | null = null;
let demoSessionAvailable: boolean | null = null;
/** In-flight negotiation: concurrent requests share one attempt instead of each
 *  minting its own session (and instead of a throttled request being rejected). */
let demoSessionPending: Promise<string | null> | null = null;
/** Throttle: never hammer the backend when it is down or refuses. */
let nextAttemptAt = 0;
const RETRY_AFTER_FAILURE_MS = 5_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Endpoints that must stay anonymous. Authenticating them would break signing in
 * with a real account, and injecting a session into /auth/logout would revoke the
 * shared demo session for everyone using this server.
 */
const ANONYMOUS_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/logout',
  '/api/v1/auth/demo-session',
  '/api/v1/auth/csrf',
  '/api/v1/auth/change-password',
];

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[tradepilot-proxy] ${message}`);
}

/** The tp_session value this request carries, if any. */
function sessionCookieValue(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('tp_session=')) return trimmed.slice('tp_session='.length);
  }
  return null;
}

/**
 * Cookies the backend has rejected. A browser holding one of these (an expired
 * session, or a cookie minted by a previous deployment) would otherwise be stuck
 * at 401 forever, so those requests may fall back to the server's demo session.
 * Bounded so it can never grow without limit.
 */
const deadCookies = new Set<string>();
const MAX_DEAD_COOKIES = 256;

function rememberDeadCookie(value: string): void {
  if (deadCookies.size >= MAX_DEAD_COOKIES) {
    const oldest = deadCookies.values().next().value;
    if (oldest) deadCookies.delete(oldest);
  }
  deadCookies.add(value);
}

/** A cross-site request must never receive this server's session. */
function isCrossSite(req: IncomingMessage): boolean {
  const site = (req.headers['sec-fetch-site'] as string | undefined)?.toLowerCase();
  if (site === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin) return false; // non-browser client (curl, tests, the EA)
  const host = req.headers.host;
  if (!host) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/**
 * Should this request travel with the server's demo session?
 * No when it already carries credentials the backend will honour, when it is an
 * auth endpoint, or when it comes from another site.
 */
function shouldAttachDemoSession(req: IncomingMessage, pathname: string): boolean {
  if (req.headers.authorization) return false; // the caller chose its own credential
  if (isAnonymousPath(pathname)) return false;
  const cookie = sessionCookieValue(req);
  if (cookie && !deadCookies.has(cookie)) return false; // a live cookie wins
  if (isCrossSite(req)) return false;
  return true;
}

function isAnonymousPath(pathname: string): boolean {
  return ANONYMOUS_PATHS.some((path) => pathname === path);
}

/** Ask the backend once whether password-less demo entry is enabled here. */
async function demoEntryAvailable(): Promise<boolean> {
  if (!autoDemoSession) return false;
  if (demoSessionAvailable !== null) return demoSessionAvailable;
  try {
    const response = await fetch(`${backendUrl}/api/v1/auth/demo-session`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { available?: boolean };
    demoSessionAvailable = Boolean(body.available);
    log(`password-less DEMO entry is ${demoSessionAvailable ? 'enabled' : 'disabled'} on the backend`);
    return demoSessionAvailable;
  } catch {
    // Backend not up yet — re-probe on the next request, at most every 5 s.
    nextAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
    return false;
  }
}

/**
 * The session this server attaches to unauthenticated API calls. Created once
 * and refreshed shortly before it expires; every failure is throttled so a dead
 * or refusing backend never turns into a request storm.
 */
async function ensureDemoSession(): Promise<string | null> {
  if (!autoDemoSession) return null;
  if (demoSession && demoSession.expiresAt - REFRESH_MARGIN_MS > Date.now()) return demoSession.token;
  if (demoSessionPending) return demoSessionPending;
  if (Date.now() < nextAttemptAt) return null;
  demoSessionPending = negotiateDemoSession().finally(() => {
    demoSessionPending = null;
  });
  return demoSessionPending;
}

async function negotiateDemoSession(): Promise<string | null> {
  if (!(await demoEntryAvailable())) return null;

  try {
    const response = await fetch(`${backendUrl}/api/v1/auth/demo-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      nextAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      log(`could not open a demo session (HTTP ${response.status}) — the app will show the sign-in page`);
      return demoSession?.token ?? null;
    }
    const body = (await response.json()) as { session?: { token?: string; expiresAt?: string } };
    const token = body.session?.token;
    if (!token) {
      nextAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      log('the backend did not return a demo session token');
      return null;
    }
    const expiresAt = body.session?.expiresAt ? Date.parse(body.session.expiresAt) : Date.now() + 60 * 60_000;
    demoSession = { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60_000 };
    demoSessionAvailable = true;
    nextAttemptAt = 0;
    log(`attached a DEMO session for credential-less API calls (expires ${new Date(demoSession.expiresAt).toISOString()})`);
    return demoSession.token;
  } catch (error) {
    nextAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
    log(`demo session request failed: ${(error as Error).message}`);
    return demoSession?.token ?? null;
  }
}

function invalidateDemoSession(reason: string): void {
  if (!demoSession) return;
  demoSession = null;
  // Retry on the very next request: the throttle exists for backend outages,
  // not for a session that merely expired, and the in-flight promise keeps a
  // burst of concurrent requests from stampeding.
  nextAttemptAt = 0;
  log(`dropped the DEMO session (${reason}) — the next request will negotiate a fresh one`);
}

interface ProxiedRequest extends IncomingMessage {
  tpBearer?: string;
}

/* ------------------------------------------------------------------ */
/* Proxy wiring                                                        */
/* ------------------------------------------------------------------ */

proxy.on('error', (error, _req, res) => {
  // eslint-disable-next-line no-console
  console.error(`[proxy] backend ${backendUrl} unreachable: ${error.message}`);
  const response = res as ServerResponse;
  if (response && 'writeHead' in response && !response.headersSent) {
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: `TradePilot backend is not reachable at ${backendUrl}. Start it with: npm run dev:backend`,
        },
      }),
    );
  }
});

proxy.on('proxyReq', (proxyReq, req) => {
  const token = (req as ProxiedRequest).tpBearer;
  if (token) proxyReq.setHeader('authorization', `Bearer ${token}`);
});

proxy.on('proxyReqWs', (proxyReq, req) => {
  const token = (req as ProxiedRequest).tpBearer;
  if (token) proxyReq.setHeader('authorization', `Bearer ${token}`);
});

proxy.on('proxyRes', (proxyRes, req) => {
  const rejected = proxyRes.statusCode === 401 || proxyRes.statusCode === 403;
  if (!rejected) return;

  if ((req as ProxiedRequest).tpBearer) {
    // Only the injected bearer was on the request? Then the backend really did
    // refuse *it* — drop it so the next request negotiates a fresh one instead of
    // replaying a dead credential. When the request ALSO carried a cookie the
    // rejection may be about that stale cookie, and the shared demo session must
    // not be thrown away because of one client's old jar.
    if (!sessionCookieValue(req)) {
      invalidateDemoSession(`backend answered ${proxyRes.statusCode}`);
    }
    return;
  }

  // A cookie the backend refused is remembered, so the next request from that
  // browser can recover through the demo session instead of looping at 401.
  const cookie = sessionCookieValue(req);
  if (cookie && !isAnonymousPath(parse(req.url ?? '/', false).pathname ?? '/')) {
    if (!deadCookies.has(cookie)) log('a session cookie was rejected by the backend — that browser can fall back to the DEMO session');
    rememberDeadCookie(cookie);
  }
});

// Strip hop-by-hop headers that would otherwise confuse Fastify's CORS layer.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);

function stripHopByHop(req: IncomingMessage): void {
  for (const header of Object.keys(req.headers)) {
    if (HOP_BY_HOP.has(header)) delete req.headers[header as keyof typeof req.headers];
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = parse(req.url ?? '/', false);
  const pathname = parsed.pathname ?? '/';

  // `/mt5/*` is the static Expert-Advisor download (frontend/public/mt5, kept in
  // sync from mt5/ by scripts/sync-mt5-public.mjs). It is NOT a backend route —
  // proxying it was a dead hop that 404'd the EA download links.
  if (pathname.startsWith('/api') || pathname === '/ws') {
    stripHopByHop(req);

    if (pathname.startsWith('/api/') && shouldAttachDemoSession(req, pathname)) {
      const token = await ensureDemoSession();
      if (token) (req as ProxiedRequest).tpBearer = token;
    }

    proxy.web(req, res, { target: backendUrl });
    return;
  }

  void handle(req, res, parsed as unknown as Parameters<typeof handle>[2]);
}

app.prepare().then(() => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });

  // WebSocket upgrade: browser ⇄ this server ⇄ backend hub (/ws)
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    void (async () => {
      const parsed = parse(req.url ?? '/', false);
      const pathname = parsed.pathname ?? '/';
      if (pathname === '/ws') {
        // NOTE: do not strip hop-by-hop headers here — a WebSocket handshake
        // needs `Connection: Upgrade` and `Upgrade: websocket` to survive.
        // The upgrade carries whatever the browser stored. When that is nothing
        // (or only a cookie the backend already refused) the socket gets the
        // server-side demo session, so quotes and account pushes stay live.
        if (shouldAttachDemoSession(req, pathname)) {
          const token = await ensureDemoSession();
          if (token) (req as ProxiedRequest).tpBearer = token;
        }
        proxy.ws(req, socket, head, { target: backendUrl, ws: true });
        return;
      }
      if (pathname.startsWith('/_next')) {
        // Next.js dev server handles its own HMR websocket.
        (app as unknown as { getUpgradeHandler?: () => (req: IncomingMessage, socket: unknown, head: Buffer) => void }).getUpgradeHandler?.()(req, socket, head);
        return;
      }
      socket.destroy();
    })();
  });

  server.listen(port, hostname, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[tradepilot] frontend ready on http://${hostname}:${port} (proxying /api and /ws → ${backendUrl}` +
        `${autoDemoSession ? '; server-side DEMO session for credential-less API calls' : ''})`,
    );
  });
});
