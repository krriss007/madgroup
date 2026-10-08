/**
 * TradePilot — DEMO MARKET SIMULATOR.
 *
 * Generates a *clearly labelled* simulated market for paper trading:
 *   • geometric Brownian motion per instrument, seeded for reproducibility
 *   • a real M1 candle history (aggregated on demand to M5…W1)
 *   • weekend closure and session windows, so the demo behaves like a market
 *   • bid/ask built from each instrument's spread, daily high/low tracking
 *
 * Every quote produced here is tagged `source: 'DEMO_SIMULATED'` and the UI
 * prints "SIMULATED DATA" next to it. Nothing in this file is ever used to
 * source a price for a LIVE account — live prices can only come from MT5.
 */

import { EventEmitter } from 'node:events';
import { round } from '@tradepilot/shared';
import { DEMO_PROFILES, demoProfile, usdRateFor, type DemoInstrumentProfile } from './profiles';

export interface SimulatedQuote {
  symbol: string;
  canonical: string;
  bid: number;
  ask: number;
  spread: number;
  spreadPoints: number;
  digits: number;
  high: number;
  low: number;
  open: number;
  close: number;
  changePercent: number;
  time: number;
  point: number;
  tickSize: number;
  contractSize: number;
  tickValue: number;
  tickValueProfit: number;
  tickValueLoss: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  stopsLevel: number;
  currencyProfit: string;
  commissionPerLot: number;
  swapLongPerLot: number;
  swapShortPerLot: number;
  description: string;
  sessions: string[];
  marketOpen: boolean;
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SymbolState {
  profile: DemoInstrumentProfile;
  price: number;
  bid: number;
  ask: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  m1: Candle[];
  lastTickAt: number;
  rngState: number;
}

export interface MarketSimulatorOptions {
  seed?: number;
  tickIntervalMs?: number;
  /** how much M1 history to pre-generate (days) */
  historyDays?: number;
  /** start the tick loop automatically */
  autoStart?: boolean;
  now?: () => Date;
}

/** mulberry32 — small, fast, seedable PRNG so demo sessions are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller transform for normally distributed steps. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const M1 = 60;
const TF_SECONDS: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
  W1: 604800,
};

export class MarketSimulator extends EventEmitter {
  private readonly states = new Map<string, SymbolState>();
  private readonly rng: () => number;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private candleCache = new Map<string, { payload: Candle[]; builtAt: number; lastTime: number }>();
  private running = false;

  constructor(private readonly options: MarketSimulatorOptions = {}) {
    super();
    this.rng = mulberry32(options.seed ?? 20261008);
    this.tickIntervalMs = options.tickIntervalMs ?? 500;
    this.now = options.now ?? (() => new Date());
    this.bootstrap(options.historyDays ?? 3);
    if (options.autoStart) this.start();
  }

  /* ------------------------------------------------------------------ */
  /* bootstrap                                                           */
  /* ------------------------------------------------------------------ */

  private bootstrap(historyDays: number): void {
    for (const profile of Object.values(DEMO_PROFILES)) {
      const seed = hashString(profile.canonical) ^ (this.options.seed ?? 20261008);
      const rng = mulberry32(seed)();
      const m1 = this.generateHistory(profile, Date.now(), historyDays * 24 * 60, mulberry32(seed));
      const lastClose = m1[m1.length - 1]?.close ?? profile.basePrice;
      const todayStart = startOfUtcDay(Date.now());
      const todayCandles = m1.filter((c) => c.time * 1000 >= todayStart);
      const dayOpen = todayCandles[0]?.open ?? lastClose;
      this.states.set(profile.canonical, {
        profile,
        price: lastClose,
        bid: lastClose - profile.spread / 2,
        ask: lastClose + profile.spread / 2,
        dayOpen,
        dayHigh: Math.max(...(todayCandles.length ? todayCandles.map((c) => c.high) : [lastClose])),
        dayLow: Math.min(...(todayCandles.length ? todayCandles.map((c) => c.low) : [lastClose])),
        m1,
        lastTickAt: Date.now(),
        rngState: Math.floor(rng * 2 ** 31),
      });
    }
  }

  private generateHistory(
    profile: DemoInstrumentProfile,
    endMs: number,
    count: number,
    rng: () => number,
  ): Candle[] {
    const secondsPerYear = 365 * 24 * 3600;
    const sigma = profile.annualVolatility;
    const dt = M1 / secondsPerYear;
    const volatility = sigma * Math.sqrt(dt);
    const candles: Candle[] = [];
    const step = profile.tickSize;
    // Walk forward from a synthetic starting price so the series ends near the
    // profile's base price (keeps the demo stable across restarts).
    let price = profile.basePrice * (1 - 0.02 * (rng() - 0.5));
    const startSeconds = Math.floor(endMs / 1000) - count * M1;

    for (let i = 0; i < count; i += 1) {
      const time = startSeconds + i * M1;
      const date = new Date(time * 1000);
      const open = price;
      let high = price;
      let low = price;
      const steps = 12; // sub-steps make the intrabar range realistic
      for (let s = 0; s < steps; s += 1) {
        const drift = -0.5 * volatility * volatility;
        const shock = volatility * gaussian(rng);
        price = price * Math.exp(drift + shock);
        high = Math.max(high, price);
        low = Math.min(low, price);
      }
      if (!this.isSessionOpen(profile, date)) {
        // Outside trading hours the market is flat: reuse the previous close.
        price = open;
        high = open;
        low = open;
      }
      candles.push({
        time,
        open: snap(open, step),
        high: snap(high, step),
        low: snap(low, step),
        close: snap(price, step),
        volume: Math.round(500 + rng() * 3_000),
      });
    }
    return candles;
  }

  /* ------------------------------------------------------------------ */
  /* session handling                                                    */
  /* ------------------------------------------------------------------ */

  private isSessionOpen(profile: DemoInstrumentProfile, date: Date): boolean {
    const day = date.getUTCDay();
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    if (profile.sessions.length === 0) {
      // 24/7 instrument (crypto): open all week
      return true;
    }
    const window = profile.sessions[day] ?? '';
    if (!window.trim()) return false;
    return window
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((segment) => {
        const [start, end] = segment.split('-');
        if (!start || !end) return false;
        const toMinutes = (value: string): number => {
          const [h, m] = value.split(':').map(Number);
          return (h || 0) * 60 + (m || 0);
        };
        const from = toMinutes(start);
        const to = toMinutes(end);
        if (to >= from) return minutes >= from && minutes <= to;
        return minutes >= from || minutes <= to;
      });
  }

  isMarketOpen(canonical: string, date: Date = this.now()): boolean {
    const state = this.states.get(canonical);
    if (!state) return false;
    return this.isSessionOpen(state.profile, date);
  }

  /* ------------------------------------------------------------------ */
  /* tick loop                                                           */
  /* ------------------------------------------------------------------ */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Advance the simulated market by one tick and emit quote events. */
  tick(at: Date = this.now()): SimulatedQuote[] {
    const secondsPerYear = 365 * 24 * 3600;
    const elapsedSeconds = Math.max(0.25, (at.getTime() - this.lastGlobalTickAt()) / 1000);
    const dt = elapsedSeconds / secondsPerYear;
    const out: SimulatedQuote[] = [];
    const priceMap = new Map<string, number>();
    for (const [canonical, state] of this.states) priceMap.set(canonical, state.price);

    for (const [canonical, state] of this.states) {
      const { profile } = state;
      const open = this.isSessionOpen(profile, at);
      if (open) {
        const sigma = profile.annualVolatility;
        const volatility = sigma * Math.sqrt(dt);
        const drift = -0.5 * volatility * volatility;
        const shock = volatility * gaussian(this.rng);
        state.price = Math.max(profile.tickSize, state.price * Math.exp(drift + shock));
        state.price = snap(state.price, profile.tickSize);
        // Spread widens slightly outside the London/NY window, like a real book.
        const hour = at.getUTCHours();
        const liquidityFactor = hour >= 7 && hour < 21 ? 1 : 1.6;
        const halfSpread = (profile.spread * liquidityFactor) / 2;
        state.bid = snap(state.price - halfSpread, profile.tickSize);
        state.ask = snap(state.price + halfSpread, profile.tickSize);
        state.dayHigh = Math.max(state.dayHigh, state.ask);
        state.dayLow = Math.min(state.dayLow, state.bid);
      }
      state.lastTickAt = at.getTime();

      // Keep the M1 series current: update the active candle or roll a new one.
      const bucket = Math.floor(at.getTime() / 1000 / M1) * M1;
      const last = state.m1[state.m1.length - 1];
      if (!last) {
        state.m1.push({ time: bucket, open: state.price, high: state.price, low: state.price, close: state.price, volume: 0 });
      } else if (last.time === bucket) {
        last.close = state.price;
        last.high = Math.max(last.high, state.price);
        last.low = Math.min(last.low, state.price);
        last.volume += Math.round(10 + this.rng() * 60);
      } else {
        state.m1.push({ time: bucket, open: state.price, high: state.price, low: state.price, close: state.price, volume: 8 });
        if (state.m1.length > 20_000) state.m1.splice(0, state.m1.length - 20_000);
        this.candleCache.delete(canonical);
      }
      // Daily rollover resets the session open/high/low.
      if (bucket * 1000 - startOfUtcDay(at.getTime()) < M1 * 1000) {
        state.dayOpen = state.price;
        state.dayHigh = state.price;
        state.dayLow = state.price;
      }

      out.push(this.buildQuote(canonical, at, priceMap));
    }

    this.emit('tick', out);
    for (const quote of out) this.emit('quote', quote);
    return out;
  }

  private lastGlobalTickAtValue = 0;

  private lastGlobalTickAt(): number {
    const value = this.lastGlobalTickAtValue;
    this.lastGlobalTickAtValue = this.now().getTime();
    return value || this.now().getTime() - this.tickIntervalMs;
  }

  private buildQuote(canonical: string, at: Date, priceMap: Map<string, number>): SimulatedQuote {
    const state = this.states.get(canonical)!;
    const { profile } = state;
    const tickValueUsd = profile.contractSize * profile.tickSize * usdRateFor(profile.quoteCurrency, priceMap);
    return {
      symbol: canonical,
      canonical,
      bid: state.bid,
      ask: state.ask,
      spread: round(state.ask - state.bid, profile.digits),
      spreadPoints: round((state.ask - state.bid) / profile.tickSize, 1),
      digits: profile.digits,
      high: round(state.dayHigh, profile.digits),
      low: round(state.dayLow, profile.digits),
      open: round(state.dayOpen, profile.digits),
      close: round(state.bid, profile.digits),
      changePercent: round(((state.bid - state.dayOpen) / state.dayOpen) * 100, 3),
      time: at.getTime(),
      point: profile.tickSize,
      tickSize: profile.tickSize,
      contractSize: profile.contractSize,
      tickValue: round(tickValueUsd, 5),
      tickValueProfit: round(tickValueUsd, 5),
      tickValueLoss: round(tickValueUsd, 5),
      volumeMin: profile.volumeMin,
      volumeMax: profile.volumeMax,
      volumeStep: profile.volumeStep,
      stopsLevel: profile.stopsLevel,
      currencyProfit: 'USD',
      commissionPerLot: profile.commissionPerLot,
      swapLongPerLot: profile.swapLongPerLot,
      swapShortPerLot: profile.swapShortPerLot,
      description: profile.description,
      sessions: profile.sessions,
      marketOpen: this.isSessionOpen(profile, at),
    };
  }

  /* ------------------------------------------------------------------ */
  /* queries                                                             */
  /* ------------------------------------------------------------------ */

  listSymbols(): string[] {
    return [...this.states.keys()];
  }

  has(canonical: string): boolean {
    return this.states.has(canonical);
  }

  quote(canonical: string, at: Date = this.now()): SimulatedQuote | null {
    if (!this.states.has(canonical)) return null;
    const priceMap = new Map<string, number>();
    for (const [key, state] of this.states) priceMap.set(key, state.price);
    return this.buildQuote(canonical, at, priceMap);
  }

  quotes(at: Date = this.now()): SimulatedQuote[] {
    const priceMap = new Map<string, number>();
    for (const [key, state] of this.states) priceMap.set(key, state.price);
    return [...this.states.keys()].map((canonical) => this.buildQuote(canonical, at, priceMap));
  }

  /** Aggregate the M1 series into the requested timeframe. */
  candles(canonical: string, timeframe: string, count: number, at: Date = this.now()): Candle[] {
    const state = this.states.get(canonical);
    if (!state) return [];
    const tf = TF_SECONDS[timeframe] ?? 900;
    const cacheKey = `${canonical}:${timeframe}`;
    const bucketOf = (time: number): number => Math.floor(time / tf) * tf;
    const currentBucket = bucketOf(Math.floor(at.getTime() / 1000));

    let series: Candle[];
    const cached = this.candleCache.get(cacheKey);
    if (cached && cached.lastTime === currentBucket && cached.builtAt > at.getTime() - tf * 500) {
      series = cached.payload;
    } else {
      const aggregated: Candle[] = [];
      let current: Candle | null = null;
      for (const candle of state.m1) {
        const bucket = bucketOf(candle.time);
        if (!current || current.time !== bucket) {
          if (current) aggregated.push(current);
          current = { time: bucket, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume };
        } else {
          current.high = Math.max(current.high, candle.high);
          current.low = Math.min(current.low, candle.low);
          current.close = candle.close;
          current.volume += candle.volume;
        }
      }
      if (current) aggregated.push(current);
      series = aggregated;
      this.candleCache.set(cacheKey, { payload: series, builtAt: at.getTime(), lastTime: currentBucket });
    }

    // Never advertise a candle that has not formed yet.
    const usable = series.filter((c) => c.time < currentBucket || c.time === currentBucket);
    return usable.slice(-Math.max(10, Math.min(count, 1_500))).map((c) => ({ ...c }));
  }

  /** Daily high/low for the XAUUSD special panel. */
  dayStats(canonical: string): { high: number; low: number; open: number } | null {
    const state = this.states.get(canonical);
    if (!state) return null;
    return {
      high: round(state.dayHigh, state.profile.digits),
      low: round(state.dayLow, state.profile.digits),
      open: round(state.dayOpen, state.profile.digits),
    };
  }

  reset(seed?: number): void {
    this.states.clear();
    this.candleCache.clear();
    if (seed != null) (this.options as MarketSimulatorOptions).seed = seed;
    this.bootstrap(3);
  }
}

function snap(value: number, step: number): number {
  const decimals = Math.max(0, Math.min(8, (String(step).split('.')[1] ?? '').length));
  return round(Math.round(value / step) * step, decimals);
}

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export { demoProfile };
export type { Candle as SimulatedCandle };
