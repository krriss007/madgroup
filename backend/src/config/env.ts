/**
 * TradePilot — backend configuration.
 *
 * Secrets live exclusively in environment variables. Nothing in this file (or
 * anywhere else in the backend) is ever shipped to the browser: the frontend
 * only receives public configuration through /api/v1/system/config.
 */

import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().optional(),
  /** Skip PostgreSQL entirely and run on the in-memory store (demo/preview). */
  USE_IN_MEMORY_DB: booleanish.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** 32+ byte secret used to sign session cookies. MUST be set in production. */
  SESSION_SECRET: z.string().min(16).default('tradepilot-dev-session-secret-change-me'),
  /** Secret used to sign bridge commands sent to MT5 EAs. */
  BRIDGE_SECRET: z.string().min(16).default('tradepilot-dev-bridge-secret-change-me'),
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(720),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanish.optional(),
  /**
   * SameSite policy for the session/CSRF cookies. `lax` is the right default
   * for a first-party deployment. `none` (which requires `COOKIE_SECURE=true`)
   * is needed when the app is embedded in a cross-site iframe — e.g. an IDE
   * preview pane on a different registrable domain than the app itself — where
   * browsers otherwise refuse to store or send the cookies at all.
   */
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  CORS_ORIGINS: z.string().default('*'),

  /** Demo engine */
  DEMO_STARTING_BALANCE: z.coerce.number().positive().default(10_000),
  DEMO_LEVERAGE: z.coerce.number().positive().default(100),
  DEMO_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  /** Deterministic seed keeps the simulated market reproducible across restarts. */
  DEMO_SEED: z.coerce.number().int().default(20261008),

  MAINTENANCE_PRICE_FEED: booleanish.default(true),
  MAX_QUOTE_SUBSCRIPTIONS: z.coerce.number().int().positive().default(64),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  SEED_DEMO_USER: booleanish.default(true),
  /**
   * One-click / no-click entry into the shared DEMO account.
   *
   * Development convenience: when enabled, the app can sign a visitor straight
   * into the seeded demo user (DEMO_USER_EMAIL) without a password so a local
   * or preview instance is usable in one step. It is OFF by default in
   * production and it can never grant anything live — the session it issues is
   * an ordinary session for that user, and LIVE trading still requires an
   * authorized MT5 bridge plus the explicit live-trading opt-in.
   *
   * Only enable it on instances where every visitor is allowed to see the same
   * demo data, and turn it off before exposing the app to real users.
   */
  DEMO_AUTO_LOGIN: booleanish.optional(),
  DEMO_USER_EMAIL: z.string().default('demo@tradepilot.local'),
  DEMO_USER_PASSWORD: z.string().default('demo1234'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration → ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.SESSION_SECRET.includes('change-me') || env.BRIDGE_SECRET.includes('change-me')) {
      throw new Error(
        'Refusing to start in production with default development secrets. Set SESSION_SECRET and BRIDGE_SECRET to strong random values.',
      );
    }
  }
  cached = env;
  return env;
}

export function resetEnvCache(): void {
  cached = null;
}

export function corsOrigins(env: Env): string[] | boolean {
  if (env.CORS_ORIGINS.trim() === '*') return true;
  return env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

/** Is password-less demo entry allowed on this instance? */
export function demoAutoLoginEnabled(env: Env): boolean {
  if (env.DEMO_AUTO_LOGIN !== undefined) return env.DEMO_AUTO_LOGIN;
  // Default: on for local/preview runs that already seed the demo user, off in
  // production unless an operator opts in explicitly.
  return env.NODE_ENV !== 'production' && env.SEED_DEMO_USER;
}
