import WebSocket from 'ws';
import { TIMEFRAMES, type Bar, type InstrumentSpec, type Timeframe } from '../../shared/types';
import type { MarketData } from './marketData';

export const TF_TO_BINANCE: Record<Timeframe, string> = {
  M1: '1m',
  M5: '5m',
  M15: '15m',
  M30: '30m',
  H1: '1h',
  H4: '4h',
  D1: '1d',
};

export interface BinanceOptions {
  restUrl: string;
  wsUrl: string;
  historyBars?: number;
  fetchImpl?: typeof fetch;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  onStatus?: (status: BinanceStatus) => void;
}

export interface BinanceStatus {
  connected: boolean;
  liveSymbols: string[];
  error: string | null;
}

/** Parse a Binance kline REST row into a Bar. Row format: [openTime, open, high, low, close, volume, ...]. */
export function parseKline(row: unknown[]): Bar {
  return {
    t: Number(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    v: Number(row[5]),
  };
}

/** Parse a Binance bookTicker stream message into a mid/spread update, or null if it isn't one. */
export function parseBookTicker(
  message: unknown,
): { binanceSymbol: string; bid: number; ask: number } | null {
  const payload = (message as { data?: unknown })?.data ?? message;
  const p = payload as { s?: unknown; b?: unknown; a?: unknown };
  if (typeof p?.s !== 'string' || p.b === undefined || p.a === undefined) return null;
  const bid = Number(p.b);
  const ask = Number(p.a);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return { binanceSymbol: p.s, bid, ask };
}

export async function fetchKlines(
  restUrl: string,
  binanceSymbol: string,
  tf: Timeframe,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Bar[]> {
  const url = `${restUrl.replace(/\/$/, '')}/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=${TF_TO_BINANCE[tf]}&limit=${limit}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${binanceSymbol} ${tf}`);
  const rows = (await res.json()) as unknown[];
  if (!Array.isArray(rows)) throw new Error(`Unexpected klines payload for ${binanceSymbol}`);
  return rows.map((r) => parseKline(r as unknown[]));
}

/**
 * Live crypto feed from Binance's public market data streams (no API key needed).
 * - History: REST klines for every timeframe.
 * - Prices: bookTicker stream (best bid/ask) → mid + real spread.
 * Symbols that fail to load keep using the simulator.
 */
export class BinanceFeed {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private stopped = false;
  private byBinance = new Map<string, InstrumentSpec>();
  private liveSymbols = new Set<string>();
  private error: string | null = null;
  private connected = false;

  constructor(
    private market: MarketData,
    private opts: BinanceOptions,
  ) {}

  status(): BinanceStatus {
    return { connected: this.connected, liveSymbols: [...this.liveSymbols], error: this.error };
  }

  async start(specs: InstrumentSpec[]): Promise<void> {
    const feedSpecs = specs.filter((s) => s.binanceSymbol);
    if (feedSpecs.length === 0) return;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const limit = this.opts.historyBars ?? 500;

    const results = await Promise.all(
      feedSpecs.map(async (spec): Promise<InstrumentSpec | null> => {
        try {
          const binanceSymbol = spec.binanceSymbol!;
          // Fetch every timeframe first so a partial failure never mixes real and simulated history.
          const series = new Map<Timeframe, Bar[]>();
          for (const tf of TIMEFRAMES) {
            const bars = await fetchKlines(this.opts.restUrl, binanceSymbol, tf, limit, fetchImpl);
            if (bars.length === 0) throw new Error(`no ${tf} candles for ${binanceSymbol}`);
            series.set(tf, bars);
          }
          for (const [tf, bars] of series) this.market.seed(spec.symbol, tf, bars);
          this.market.markSource(spec.symbol, 'live');
          return spec;
        } catch (err) {
          this.error = `History unavailable for ${spec.symbol}: ${(err as Error).message}`;
          this.opts.log?.('warn', this.error);
          return null;
        }
      }),
    );
    const loaded = results.filter((s): s is InstrumentSpec => s !== null);
    if (loaded.length === 0) {
      this.report();
      return;
    }
    for (const spec of loaded) {
      this.byBinance.set(spec.binanceSymbol!, spec);
    }
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const streams = [...this.byBinance.keys()].map((s) => `${s.toLowerCase()}@bookTicker`);
    const url = `${this.opts.wsUrl.replace(/\/$/, '')}/stream?streams=${streams.join('/')}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.retries = 0;
      this.error = null;
      this.opts.log?.('info', `Binance live feed connected (${streams.length} symbols)`);
      this.report();
    });

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleMessage(parsed);
    });

    ws.on('error', (err) => {
      this.error = `Binance WebSocket error: ${err.message}`;
      this.opts.log?.('warn', this.error);
    });

    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      this.report();
      this.scheduleReconnect();
    });
  }

  /** Exposed for tests: process one parsed bookTicker message. */
  handleMessage(message: unknown): boolean {
    const update = parseBookTicker(message);
    if (!update) return false;
    const spec = this.byBinance.get(update.binanceSymbol);
    if (!spec) return false;
    const mid = (update.bid + update.ask) / 2;
    const spread = update.ask - update.bid;
    this.market.tick(spec.symbol, mid, Date.now(), { source: 'live', spread });
    this.liveSymbols.add(spec.symbol);
    return true;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.retries += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retries, 5));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private report(): void {
    this.opts.onStatus?.(this.status());
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
