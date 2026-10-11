import { EventEmitter } from 'node:events';
import { TIMEFRAMES, TIMEFRAME_MS, type Bar, type InstrumentSpec, type Timeframe } from '../../shared/types';

/** Maximum bars kept per symbol/timeframe in memory. */
export const MAX_BARS = 1000;

export type FeedSource = 'live' | 'sim';

export interface SymbolState {
  spec: InstrumentSpec;
  mid: number;
  spread: number;
  source: FeedSource;
  /** Epoch ms of the last tick (any source). */
  lastTick: number;
  /** Epoch ms of the last tick coming from the live exchange feed. */
  lastLiveTick: number;
  bars: Record<Timeframe, Bar[]>;
}

export interface RawQuote {
  symbol: string;
  mid: number;
  spread: number;
  digits: number;
  dayOpen: number;
  high: number;
  low: number;
  source: FeedSource;
  time: number;
}

/**
 * In-memory market data store. Feeds (simulator or Binance) call `tick()`; the
 * store keeps candles for every timeframe up to date and emits `tick` events.
 */
export class MarketData extends EventEmitter {
  private states = new Map<string, SymbolState>();

  constructor(specs: InstrumentSpec[]) {
    super();
    for (const spec of specs) {
      const empty = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, [] as Bar[]])) as Record<Timeframe, Bar[]>;
      this.states.set(spec.symbol, {
        spec,
        mid: spec.simBasePrice,
        spread: spec.spread,
        source: 'sim',
        lastTick: 0,
        lastLiveTick: 0,
        bars: empty,
      });
    }
  }

  symbols(): string[] {
    return [...this.states.keys()];
  }

  has(symbol: string): boolean {
    return this.states.has(symbol);
  }

  spec(symbol: string): InstrumentSpec | undefined {
    return this.states.get(symbol)?.spec;
  }

  state(symbol: string): SymbolState | undefined {
    return this.states.get(symbol);
  }

  /** Current mid price of a symbol (0 if unknown). */
  mid(symbol: string): number {
    return this.states.get(symbol)?.mid ?? 0;
  }

  raw(symbol: string): RawQuote | null {
    const st = this.states.get(symbol);
    if (!st) return null;
    const d1 = st.bars.D1;
    const today = d1[d1.length - 1];
    return {
      symbol,
      mid: st.mid,
      spread: st.spread,
      digits: st.spec.digits,
      dayOpen: today ? today.o : st.mid,
      high: today ? today.h : st.mid,
      low: today ? today.l : st.mid,
      source: st.source,
      time: st.lastTick,
    };
  }

  /** Returns the most recent `limit` bars (oldest first). The last bar is the forming bar. */
  bars(symbol: string, tf: Timeframe, limit = 500): Bar[] {
    const st = this.states.get(symbol);
    if (!st) return [];
    const arr = st.bars[tf];
    return arr.slice(Math.max(0, arr.length - limit)).map((b) => ({ ...b }));
  }

  /** Replace the history of one timeframe (used by simulator seeding and Binance history load). */
  seed(symbol: string, tf: Timeframe, bars: Bar[]): void {
    const st = this.states.get(symbol);
    if (!st) return;
    st.bars[tf] = bars.slice(-MAX_BARS).map((b) => ({ ...b }));
    const last = st.bars[tf][st.bars[tf].length - 1];
    if (tf === 'M1' && last) {
      st.mid = last.c;
    }
  }

  /** Mark a symbol's history as live (a Binance history load succeeded). */
  markSource(symbol: string, source: FeedSource): void {
    const st = this.states.get(symbol);
    if (st) st.source = source;
  }

  /**
   * Apply a new price. Updates the forming candle for every timeframe.
   * @param time epoch ms of the tick
   */
  tick(symbol: string, mid: number, time: number, opts: { source: FeedSource; spread?: number }): void {
    const st = this.states.get(symbol);
    if (!st || !Number.isFinite(mid) || mid <= 0) return;
    st.mid = mid;
    if (opts.spread !== undefined && Number.isFinite(opts.spread) && opts.spread >= 0) {
      st.spread = opts.spread;
    }
    st.lastTick = time;
    st.source = opts.source;
    if (opts.source === 'live') st.lastLiveTick = time;
    for (const tf of TIMEFRAMES) {
      applyToBars(st.bars[tf], TIMEFRAME_MS[tf], time, mid);
    }
    this.emit('tick', symbol);
  }
}

/** Update (or open) the candle that contains `time` with price `price`. */
export function applyToBars(bars: Bar[], periodMs: number, time: number, price: number): void {
  const bucket = Math.floor(time / periodMs) * periodMs;
  const last = bars[bars.length - 1];
  if (!last || bucket > last.t) {
    const open = last ? last.c : price;
    bars.push({ t: bucket, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price, v: 1 });
    if (bars.length > MAX_BARS + 200) bars.splice(0, bars.length - MAX_BARS);
  } else if (bucket === last.t) {
    last.c = price;
    if (price > last.h) last.h = price;
    if (price < last.l) last.l = price;
    last.v += 1;
  }
  // bucket < last.t means an out-of-order tick: ignored.
}

/** Group bars into larger periods (e.g. H1 → H4). Input must be ascending. */
export function aggregateBars(bars: Bar[], periodMs: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const bucket = Math.floor(b.t / periodMs) * periodMs;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else {
      out.push({ t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  }
  return out;
}
