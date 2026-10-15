// ---------------------------------------------------------------------------
// Sample market data generator.
//
// Produces DETERMINISTIC, clearly-SIMULATED candle series. Prices come from
// a seeded random walk with drift regimes - they are not real market prices
// and are always labelled "SAMPLE DATA" by the API and the UI. The series is
// anchored to a fixed epoch so it is reproducible across server restarts
// (same seed -> same candles), which also keeps the paper engine consistent.
// ---------------------------------------------------------------------------
import { logSystem } from '../logger.js';

export const SAMPLE_ANCHOR = Date.UTC(2026, 0, 1); // fixed series epoch

// Plausible starting levels (fake, round numbers - obviously not live quotes).
export const SAMPLE_BASE_PRICES = Object.freeze({
  'BTC-USDT': 65000, 'ETH-USDT': 3200, 'SOL-USDT': 150, 'XRP-USDT': 0.6,
  'ADA-USDT': 0.45, 'DOGE-USDT': 0.12, 'AVAX-USDT': 28, 'LINK-USDT': 14,
  'DOT-USDT': 6.5, 'LTC-USDT': 85, 'ATOM-USDT': 8, 'NEAR-USDT': 5,
  'BTC-USD': 64000, 'ETH-USD': 3150,
  'EUR-USD': 1.085, 'GBP-USD': 1.27, 'USD-JPY': 150.2, 'AUD-USD': 0.657,
  'USD-CAD': 1.36, 'XAU-USD': 2350, 'XAG-USD': 28.4,
});

// FNV-1a 32-bit string hash -> integer seed.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Mulberry32 PRNG - small, fast, serialisable state.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundPrice(p) {
  if (p >= 1000) return Math.round(p * 100) / 100;
  if (p >= 1) return Math.round(p * 10000) / 10000;
  return Math.round(p * 1000000) / 1000000;
}

/**
 * A self-contained series generator for one symbol+timeframe. Advancing it
 * is a pure fold over PRNG state, so two instances advanced to the same bar
 * produce identical candles (covered by a unit test).
 */
export class SampleSeries {
  constructor(symbol, tfMs) {
    this.symbol = symbol;
    this.tfMs = tfMs;
    this.base = SAMPLE_BASE_PRICES[symbol] || 100;
    this.price = this.base;
    this.rng = mulberry32(fnv1a(`${symbol}|${tfMs}`));
    this.spareGauss = null;
    this.barTime = SAMPLE_ANCHOR;
    this.regimeLeft = 0;
    this.mu = 0;
    this.bars = [];
    // first open
    this.prevClose = this.base;
  }

  gauss() {
    if (this.spareGauss !== null) {
      const v = this.spareGauss;
      this.spareGauss = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    this.spareGauss = r * Math.sin(theta);
    return r * Math.cos(theta);
  }

  step() {
    const tfMinutes = this.tfMs / 60000;
    const sigma = 0.004 * Math.sqrt(tfMinutes / 5); // per-bar volatility

    // Drift regime: trend up/down/flat for a seeded stretch of bars.
    if (this.regimeLeft <= 0) {
      this.regimeLeft = 120 + Math.floor(this.rng() * 360);
      this.mu = (this.rng() - 0.5) * 2 * 0.00012;
    }
    this.regimeLeft -= 1;

    // Gentle mean reversion toward the base level keeps prices in a sane band.
    const reversion = Math.max(-0.002, Math.min(0.002, -0.003 * Math.log(this.price / this.base)));
    const ret = this.mu + reversion + sigma * this.gauss();

    const o = this.prevClose;
    const c = Math.max(this.base * 0.15, Math.min(this.base * 5, o * Math.exp(ret)));
    const wickUp = Math.abs((this.rng() * 2 - 1)) * sigma * 0.6;
    const wickDown = Math.abs((this.rng() * 2 - 1)) * sigma * 0.6;
    const h = Math.max(o, c) * (1 + wickUp);
    const l = Math.min(o, c) * (1 - wickDown);
    const v = (0.5 + this.rng() * 1.5) * (1 + (3 * Math.abs(ret)) / sigma);

    this.bars.push({
      t: this.barTime,
      o: roundPrice(o),
      h: roundPrice(h),
      l: roundPrice(l),
      c: roundPrice(c),
      v: Math.round(v * 100) / 100,
      complete: true,
    });

    this.prevClose = c;
    this.price = c;
    this.barTime += this.tfMs;
  }

  /** Advance (deterministically) until the series covers `now`. */
  advanceTo(now) {
    let guard = 0;
    while (this.barTime + this.tfMs <= now && guard < 2_000_000) {
      this.step();
      guard++;
    }
    // Keep memory bounded; PRNG state lives on the instance, so the future
    // path stays identical after pruning.
    if (this.bars.length > 6000) this.bars = this.bars.slice(-4000);
  }
}

/** Shared cache of series per symbol+timeframe for the running process. */
export class SampleSource {
  constructor() {
    this.series = new Map();
  }

  key(symbol, tfMs) {
    return `${symbol}|${tfMs}`;
  }

  /** Returns closed candles plus the in-progress candle, oldest first. */
  candles(symbol, tfMs, limit) {
    const now = Date.now();
    const k = this.key(symbol, tfMs);
    let s = this.series.get(k);
    if (!s) {
      s = new SampleSeries(symbol, tfMs);
      this.series.set(k, s);
      logSystem('Sample series generated', { symbol, tfMs, anchor: SAMPLE_ANCHOR });
    }
    s.advanceTo(now);
    const all = s.bars;
    const closed = all.slice(Math.max(0, all.length - limit - 1), all.length);
    // Mark the last bar as in-progress if it has not closed yet.
    const out = closed.map((b) => ({ ...b }));
    if (out.length) {
      const lastBar = out[out.length - 1];
      lastBar.complete = lastBar.t + tfMs <= now;
    }
    return out;
  }

  lastPrice(symbol, tfMs) {
    const k = this.key(symbol, tfMs);
    const s = this.series.get(k);
    if (!s) return null;
    const arr = s.bars;
    return arr.length ? arr[arr.length - 1].c : null;
  }
}
