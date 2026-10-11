import { TIMEFRAMES, TIMEFRAME_MS, type Bar, type Timeframe } from '../../shared/types';
import type { MarketData } from './marketData';

export type Rng = () => number;

/** Standard normal sample (Box–Muller). */
export function gaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SimulatorOptions {
  /** Volatility multiplier. 1 = realistic, higher = livelier charts. */
  speed?: number;
  rng?: Rng;
  historyBars?: number;
  /** Last known prices (e.g. from the previous run) so restarts continue where prices left off. */
  anchors?: Record<string, number>;
}

/**
 * Generates a random-walk OHLC series for one timeframe that ends at `endPrice`.
 * Mean-reverts toward `basePrice` so long-running simulations stay plausible.
 */
export function generateSeries(opts: {
  tf: Timeframe;
  count: number;
  endTime: number;
  basePrice: number;
  endPrice: number;
  dailyVolPct: number;
  speed: number;
  rng: Rng;
}): Bar[] {
  const { tf, count, endTime, basePrice, endPrice, dailyVolPct, speed, rng } = opts;
  const periodMs = TIMEFRAME_MS[tf];
  const lastBucket = Math.floor(endTime / periodMs) * periodMs;
  const sigma = (dailyVolPct / 100) * Math.sqrt(periodMs / 86_400_000) * speed;

  // Walk forward from a starting point drawn around the base price.
  let open = basePrice * (1 + 0.02 * gaussian(rng));
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const t = lastBucket - (count - 1 - i) * periodMs;
    const z = gaussian(rng);
    let close = open * (1 + sigma * z) + (basePrice - open) * 0.01;
    if (close <= 0) close = open;
    const wickUp = Math.abs(gaussian(rng)) * sigma * 0.5;
    const wickDn = Math.abs(gaussian(rng)) * sigma * 0.5;
    const high = Math.max(open, close) * (1 + wickUp);
    const low = Math.min(open, close) * (1 - wickDn);
    bars.push({ t, o: open, h: high, l: low, c: close, v: Math.round(50 + rng() * 500) });
    open = close;
  }

  // Bridge the walk onto the current price: scale each bar by a factor that ramps
  // from 1 (first bar) to endPrice/rawEnd (last bar). This avoids a single jump at
  // the end of the chart and makes the last close equal the live price exactly.
  const rawEnd = bars[bars.length - 1]?.c ?? endPrice;
  if (bars.length > 1 && rawEnd > 0) {
    const ratio = endPrice / rawEnd;
    let prevClose = bars[0]!.o;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]!;
      const scale = 1 + (ratio - 1) * (i / (bars.length - 1));
      b.o = prevClose;
      b.c = b.c * scale;
      b.h = Math.max(b.h * scale, b.o, b.c);
      b.l = Math.min(b.l * scale, b.o, b.c);
      prevClose = b.c;
    }
  }
  const last = bars[bars.length - 1];
  if (last) last.c = endPrice;
  return bars;
}

/** Seed simulated history for every symbol that is not already fed by a live source. */
export function seedSimulatedHistory(market: MarketData, opts: SimulatorOptions = {}, now = Date.now()): void {
  const speed = opts.speed ?? 3;
  const rng = opts.rng ?? Math.random;
  const count = opts.historyBars ?? 500;

  for (const symbol of market.symbols()) {
    const spec = market.spec(symbol);
    if (!spec) continue;
    const st = market.state(symbol);
    if (st?.source === 'live') continue;

    // Current price: the last known price if we have one, otherwise a random point near the base price.
    const anchor = opts.anchors?.[symbol];
    const endPrice = anchor && anchor > 0 ? anchor : spec.simBasePrice * (1 + 0.01 * gaussian(rng));
    for (const tf of TIMEFRAMES) {
      const bars = generateSeries({
        tf,
        count,
        endTime: now,
        basePrice: spec.simBasePrice,
        endPrice,
        dailyVolPct: spec.dailyVolPct,
        speed,
        rng,
      });
      market.seed(symbol, tf, bars);
    }
    market.tick(symbol, endPrice, now, { source: 'sim', spread: spec.spread });
  }
}

/**
 * Advance simulated prices by one step (call about once per second).
 * Symbols with a fresh live feed are skipped.
 */
export function stepSimulator(
  market: MarketData,
  now: number,
  opts: { speed?: number; rng?: Rng; liveStaleMs?: number } = {},
): void {
  const speed = opts.speed ?? 3;
  const rng = opts.rng ?? Math.random;
  const liveStaleMs = opts.liveStaleMs ?? 30_000;

  for (const symbol of market.symbols()) {
    const st = market.state(symbol);
    if (!st) continue;
    if (st.source === 'live' && now - st.lastLiveTick < liveStaleMs) continue;
    const spec = st.spec;
    const perSecondSigma = (spec.dailyVolPct / 100) * Math.sqrt(1 / 86_400) * speed;
    const z = gaussian(rng);
    const mid = st.mid * (1 + perSecondSigma * z) + (spec.simBasePrice - st.mid) * 0.00002;
    market.tick(symbol, mid, now, { source: 'sim', spread: spec.spread });
  }
}
