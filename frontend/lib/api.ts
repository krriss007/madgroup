/**
 * TradePilot — browser API client.
 *
 * • Same-origin requests only (the dev/production server proxies /api to the
 *   backend), so no backend URL or secret ever reaches the browser bundle.
 * • Two session transports, negotiated once at sign-in:
 *     1. httpOnly cookie (default — `credentials: include`, plus the
 *        double-submit CSRF token echoed from the readable `tp_csrf` cookie);
 *     2. bearer token, used only when the browser refuses to store the cookie
 *        (cross-site iframe / hardened browser). The token is asked for with
 *        `x-tradepilot-transport: bearer`, kept in memory and, when available,
 *        `sessionStorage` so a reload does not sign the user out.
 *   The web app never receives broker credentials — this token only proves a
 *   TradePilot *session*, and it is revocable server-side at any time.
 * • Errors surface the backend's machine-readable code plus the exact human
 *   message required by the spec (e.g. "Volume must be between …").
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, string> | null;
  meta?: Record<string, unknown> | null;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, string> | null;
  readonly meta: Record<string, unknown> | null;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? null;
    this.meta = body.meta ?? null;
  }
}

const BASE = '/api/v1';

const BEARER_STORAGE_KEY = 'tp.session';
const CSRF_STORAGE_KEY = 'tp.csrf';
/**
 * Set when the user signs out explicitly, so demo auto-entry does not silently
 * sign them back in. The sign-in page clears it.
 */
const SUPPRESS_AUTO_LOGIN_KEY = 'tp.suppress-auto-login';

export type SessionTransport = 'cookie' | 'bearer';

interface StoredSession {
  token: string;
  csrfToken: string;
  expiresAt?: string;
}

/** In-memory copy of the bearer session (authoritative for this tab). */
let bearerSession: StoredSession | null = null;
let activeTransport: SessionTransport = 'cookie';

/**
 * The bearer session is ALSO mirrored on `window`. Dev servers can evaluate a
 * shared module more than once (Fast Refresh, separate chunks), and a
 * sandboxed/embedded frame may offer no usable web storage at all — the window
 * mirror keeps every copy of this module on the same session for the lifetime
 * of the page, which is what makes the fallback dependable.
 */
interface SessionWindow extends Window {
  __tradepilotSession?: StoredSession | null;
}

function windowMirror(): SessionWindow | null {
  return typeof window === 'undefined' ? null : (window as SessionWindow);
}

function readWindowSession(): StoredSession | null {
  const target = windowMirror();
  if (!target?.__tradepilotSession?.token) return null;
  const session = target.__tradepilotSession;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    target.__tradepilotSession = null;
    return null;
  }
  return session;
}

function writeWindowSession(session: StoredSession | null): void {
  const target = windowMirror();
  if (target) target.__tradepilotSession = session;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function canUseSessionStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const probe = '__tp_probe__';
    window.sessionStorage.setItem(probe, '1');
    window.sessionStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Restore a bearer session kept from an earlier navigation (if any). */
function restoreBearerSession(): StoredSession | null {
  if (bearerSession?.token) return bearerSession;

  const fromWindow = readWindowSession();
  if (fromWindow) {
    bearerSession = fromWindow;
    activeTransport = 'bearer';
    return fromWindow;
  }

  if (typeof window === 'undefined' || !canUseSessionStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(BEARER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token) return null;
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(BEARER_STORAGE_KEY);
      return null;
    }
    bearerSession = parsed;
    activeTransport = 'bearer';
    writeWindowSession(parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Adopt a bearer session returned by the backend. */
export function adoptSession(session: StoredSession): void {
  bearerSession = session;
  activeTransport = 'bearer';
  writeWindowSession(session);
  if (canUseSessionStorage()) {
    try {
      window.sessionStorage.setItem(BEARER_STORAGE_KEY, JSON.stringify(session));
      window.sessionStorage.setItem(CSRF_STORAGE_KEY, session.csrfToken);
    } catch {
      // Storage can be full or blocked — the in-memory copy still works.
    }
  }
}

/** Drop the bearer session (sign-out, or a cookie session that works again). */
export function clearSession(): void {
  bearerSession = null;
  activeTransport = 'cookie';
  writeWindowSession(null);
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(BEARER_STORAGE_KEY);
    window.sessionStorage.removeItem(CSRF_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getSessionTransport(): SessionTransport {
  if (!bearerSession) restoreBearerSession();
  return activeTransport;
}

export function getBearerToken(): string | null {
  if (!bearerSession) restoreBearerSession();
  return bearerSession?.token ?? null;
}

/** The double-submit token, from the cookie when readable, else the stored copy. */
function csrfToken(): string | null {
  const fromCookie = readCookie('tp_csrf');
  if (fromCookie) return fromCookie;
  if (bearerSession?.csrfToken) return bearerSession.csrfToken;
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(CSRF_STORAGE_KEY);
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = getBearerToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

type QueryValue = string | number | boolean | null | undefined;

function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** `false` sends no Authorization header (used to probe the cookie session). */
  auth?: boolean;
  headers?: Record<string, string>;
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.auth !== false) Object.assign(headers, authHeaders());
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const csrf = csrfToken();
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;

  const response = await fetch(withQuery(`${BASE}${path}`, options.query), {
    method,
    headers,
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 200) } };
    }
  }

  if (!response.ok) {
    const body = (payload as { error?: ApiErrorBody } | null)?.error ?? {
      code: 'UNKNOWN',
      message: `Request failed with status ${response.status}.`,
    };
    throw new ApiError(response.status, body);
  }

  return payload as T;
}

export interface LoginResponse {
  user: { id: string; email: string; displayName: string };
  account: { id: string; mode: string };
  mode: string;
  csrfToken: string;
  session?: { token: string; csrfToken: string; expiresAt?: string };
}

export interface LoginOutcome<T = LoginResponse> {
  data: T;
  transport: SessionTransport;
}

export function autoLoginSuppressed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(SUPPRESS_AUTO_LOGIN_KEY) === '1';
  } catch {
    return false;
  }
}

export function suppressAutoLogin(suppress = true): void {
  if (typeof window === 'undefined') return;
  try {
    if (suppress) window.sessionStorage.setItem(SUPPRESS_AUTO_LOGIN_KEY, '1');
    else window.sessionStorage.removeItem(SUPPRESS_AUTO_LOGIN_KEY);
  } catch {
    // ignore
  }
}

/**
 * Does the browser actually keep our session cookie?
 *
 * The response to `POST /auth/login` always *tries* to set it, so the only
 * honest test is to call the backend again and see whether the cookie came
 * back. One extra request at sign-in buys a dependable session everywhere.
 */
async function cookieSessionWorks(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/auth/session`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Sign in and negotiate the session transport. When the cookie is stored we
 * stay on the cookie path; otherwise we retry with the bearer transport so the
 * user is not signed out after a single request.
 */
export async function loginWithPassword(email: string, password: string): Promise<LoginOutcome> {
  let data = await api.post<LoginResponse>('/auth/login', { email: email.trim(), password });

  if (await cookieSessionWorks()) {
    clearSession();
    return { data, transport: 'cookie' };
  }

  // The token always comes back in the body, so this does not depend on any
  // request header surviving the environment.
  data = await api.post<LoginResponse>('/auth/login', { email: email.trim(), password });
  if (!data.session?.token) {
    throw new ApiError(401, {
      code: 'SESSION_TRANSPORT_UNAVAILABLE',
      message:
        'Signed in, but this browser stored neither the session cookie nor a session token. Enable cookies for this site and try again.',
    });
  }
  adoptSession(data.session);
  return { data, transport: 'bearer' };
}

/**
 * Enter the shared DEMO account without a password.
 *
 * The backend only honours this when DEMO_AUTO_LOGIN is enabled; the session it
 * returns is an ordinary DEMO session (LIVE trading stays locked behind the MT5
 * bridge + explicit opt-in). Used by the "Continue in DEMO mode" button and by
 * the automatic entry attempt after a 401.
 */
export async function enterDemoSession(): Promise<LoginOutcome<LoginResponse & { autoLogin?: boolean }> | null> {
  let data: LoginResponse & { autoLogin?: boolean };
  try {
    data = await api.post<LoginResponse & { autoLogin?: boolean }>('/auth/demo-session', {});
  } catch {
    return null; // disabled, rate limited or offline — the caller falls back to the form
  }

  if (await cookieSessionWorks()) {
    clearSession();
    return { data, transport: 'cookie' };
  }
  if (data.session?.token) {
    adoptSession(data.session);
    return { data, transport: 'bearer' };
  }
  // The session exists server-side but this browser kept neither credential.
  throw new ApiError(401, {
    code: 'SESSION_TRANSPORT_UNAVAILABLE',
    message: 'This browser stored neither the session cookie nor a session token. Enable cookies for this site and try again.',
  });
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', path, { body: body ?? {}, headers }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, { body: body ?? {} }),
};
