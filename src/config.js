// ---------------------------------------------------------------------------
// Server-side configuration. Read ONCE from environment variables.
// Nothing in this module is ever exposed to the browser (see README).
// ---------------------------------------------------------------------------
import './dotenv-support.js';

function envInt(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be an integer`);
  return Math.min(max, Math.max(min, n));
}

function envStr(name, def, allowed) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  if (allowed && !allowed.includes(raw)) {
    throw new Error(`Env var ${name} must be one of: ${allowed.join(', ')}`);
  }
  return raw;
}

export const serverConfig = Object.freeze({
  port: envInt('PORT', 3000, 1, 65535),
  host: envStr('HOST', '0.0.0.0'),
  // auto = try OKX public market data, fall back to clearly-labelled samples
  dataSource: envStr('DATA_SOURCE', 'auto', ['auto', 'okx', 'sample']),
  okxBaseUrl: envStr('OKX_BASE_URL', 'https://www.okx.com'),
  okxTimeoutMs: envInt('OKX_TIMEOUT_MS', 4000, 500, 15000),
  dataDir: envStr('DATA_DIR', './data'),
});

// Default ENGINE configuration. Users can tune most of these from the UI
// (POST /api/config); values are validated and clamped there.
export const defaultEngineConfig = Object.freeze({
  startBalance: 10000,        // simulated USDT - fake money, clearly labelled
  positionSizePct: 10,        // % of current equity used per position
  maxOpenPositions: 3,        // hard cap on simultaneous simulated positions
  dailyLossLimitPct: 5,       // halt new entries after this % day loss (0 = off)
  cooldownSec: 300,           // no new entries N seconds after a losing trade
  feeBps: 10,                 // estimated taker fee, basis points per side
  slippageBps: 5,             // estimated slippage, basis points per fill
  fastEma: 12,                // strategy: fast EMA period
  slowEma: 26,                // strategy: slow EMA period
  rsiPeriod: 14,              // strategy: RSI period
  rsiOverbought: 70,          // strategy: momentum filter upper bound
  atrPeriod: 14,              // strategy: ATR period for stop/target sizing
  atrMultSL: 1.5,             // stop-loss   = entry - atrMultSL * ATR
  atrMultTP: 2.0,             // take-profit = entry + atrMultTP * ATR
  allowShorts: false,         // v1 default: long-only (explainable, simpler)
});

// Clamping rules used by the API validation layer. Keep in one place so the
// UI hints and server enforcement can never drift apart.
export const configLimits = Object.freeze({
  positionSizePct: { min: 0.5, max: 100, step: 0.5 },
  maxOpenPositions: { min: 1, max: 20, step: 1, int: true },
  dailyLossLimitPct: { min: 0, max: 50, step: 0.5 },
  cooldownSec: { min: 0, max: 3600, step: 10, int: true },
  feeBps: { min: 0, max: 200, step: 1, int: true },
  slippageBps: { min: 0, max: 200, step: 1, int: true },
  fastEma: { min: 2, max: 200, step: 1, int: true },
  slowEma: { min: 3, max: 400, step: 1, int: true },
  rsiPeriod: { min: 2, max: 100, step: 1, int: true },
  rsiOverbought: { min: 55, max: 95, step: 1, int: true },
  atrPeriod: { min: 2, max: 100, step: 1, int: true },
  atrMultSL: { min: 0.2, max: 10, step: 0.1 },
  atrMultTP: { min: 0.2, max: 20, step: 0.1 },
});
