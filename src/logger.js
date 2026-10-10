// ---------------------------------------------------------------------------
// Structured event log: every signal, simulated order, and risk-limit
// decision goes through here. Kept in a bounded in-memory ring buffer and
// mirrored to the server console. Client fetches via GET /api/logs.
//
// SECURITY: never log credentials or headers. `redact()` is provided for any
// future code that might handle secrets.
// ---------------------------------------------------------------------------

const MAX_EVENTS = 1000;

let nextId = 1;
const events = []; // oldest -> newest

const CONSOLE_COLORS = {
  SIGNAL: '\x1b[36m', // cyan
  ORDER: '\x1b[33m',  // yellow
  RISK: '\x1b[35m',   // magenta
  SYSTEM: '\x1b[90m', // grey
  ERROR: '\x1b[31m',  // red
};
const RESET = '\x1b[0m';

export function logEvent(type, message, detail = {}) {
  const event = {
    id: nextId++,
    ts: Date.now(),
    type, // SIGNAL | ORDER | RISK | SYSTEM | ERROR
    message,
    detail,
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  const color = CONSOLE_COLORS[type] || '';
  const tag = `${color}[${type}]${RESET}`;
  const extra = Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '';
  // Console mirror - detail is plain market/simulation data only.
  console.log(`${tag} ${new Date(event.ts).toISOString()} ${message}${extra}`);
  return event;
}

export function getEvents({ after = 0, limit = 200, type } = {}) {
  let list = events;
  if (after > 0) list = list.filter((e) => e.id > after);
  if (type) list = list.filter((e) => e.type === type);
  return list.slice(-Math.min(Math.max(limit, 1), 500));
}

export function lastEventId() {
  return events.length ? events[events.length - 1].id : 0;
}

// Convenience wrappers with stable types.
export const logSignal = (message, detail) => logEvent('SIGNAL', message, detail);
export const logOrder = (message, detail) => logEvent('ORDER', message, detail);
export const logRisk = (message, detail) => logEvent('RISK', message, detail);
export const logSystem = (message, detail) => logEvent('SYSTEM', message, detail);
export const logError = (message, detail) => logEvent('ERROR', message, detail);

// Strip anything that looks like a secret before it can reach a log line.
export function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (/key|secret|passphrase|token|credential|password/i.test(k)) out[k] = '***redacted***';
    else if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}
