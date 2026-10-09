/**
 * Minimal structured logger. Uses pino-compatible shape without pulling in
 * another dependency; Fastify gets the same instance through `loggerInstance`.
 */

import type { Env } from '../config/env';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_WEIGHT: Record<Level, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

export interface Logger {
  fatal(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  trace(obj: Record<string, unknown> | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Keys whose values must never reach the logs. */
const REDACTED = /(password|secret|token|authorization|cookie|signature|apikey|api_key)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED.test(key) ? '[redacted]' : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(level: Level = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const emit = (lvl: Level, obj: Record<string, unknown> | string, msg?: string): void => {
    if (LEVEL_WEIGHT[lvl] > threshold) return;
    const payload = typeof obj === 'string' ? { msg: obj } : { msg: msg ?? '', ...(redact(obj) as Record<string, unknown>) };
    const line = { level: lvl, time: new Date().toISOString(), ...bindings, ...payload };
    const text = JSON.stringify(line);
    if (lvl === 'error' || lvl === 'fatal') process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
  };

  const logger: Logger = {
    fatal: (obj, msg) => emit('fatal', obj as Record<string, unknown> | string, msg),
    error: (obj, msg) => emit('error', obj as Record<string, unknown> | string, msg),
    warn: (obj, msg) => emit('warn', obj as Record<string, unknown> | string, msg),
    info: (obj, msg) => emit('info', obj as Record<string, unknown> | string, msg),
    debug: (obj, msg) => emit('debug', obj as Record<string, unknown> | string, msg),
    trace: (obj, msg) => emit('trace', obj as Record<string, unknown> | string, msg),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
  return logger;
}

export function loggerFromEnv(env: Env): Logger {
  return createLogger(env.LOG_LEVEL, { service: 'tradepilot-backend' });
}
