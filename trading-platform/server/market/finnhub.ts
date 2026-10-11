import WebSocket from 'ws';
import { TIMEFRAME_MS, type Bar, type InstrumentSpec, type Timeframe } from '../../shared/types';
import { aggregateBars, type MarketData } from './marketData';

/** Finnhub resolution strings for each timeframe we can fetch directly. H4 is aggregated from H1. */
const FINNHUB_RESOLUTION: Partial<Record<Timeframe, string>> = {
  M1: '1',
  M5: '5',
  M15: '15',
  M30: '30',
  H1: '60',
  D1: 'D',
};

export interface FinnhubOptions {
  apiKey: string;
  restUrl?: string;
  wsUrl?: string;
  historyBars?: number;
  fetchImpl?: typeof fetch;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  onStatus?: (status: FinnhubStatus) => void;
}

export interface FinnhubStatus {
  connected: boolean;
  streamingSymbols: string[];
  historyFailures: string[];
  error: string | null;
}

/** Finnhub candle endpoint family for a symbol: "forex" for OANDA:*, "crypto" for BINANCE:* etc. */
export function candleEndpoint(finnhubSymbol: string): 'forex' | 'crypto' {
  return finnhubSymbol.startsWith('BINANCE:') || finnhubSymbol.startsWith('COINBASE:') ? 'crypto' : 'forex';
}

/** Parse a Finnhub candle response ({ s, t[], o[], h[], l[], c[], v[] }) into ascending bars. */
export function parseCandles(payload: unknown): Bar[] {
  const p = payload as { s?: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[] };
  if (!p || p.s !== 'ok' || !Array.isArray(p.t)) {
    throw new Error(`no candle data (status ${p?.s ?? 'unknown'})`);
  }
  const bars: Bar[] = [];
  for (let i = 0; i < p.t!.length; i++) {
    const bar: Bar = {
      t: p.t![i]! * 1000,
      o: Number(p.o![i]),
      h: Number(p.h![i]),
      l: Number(p.l![i]),
      c: Number(p.c![i]),
      v: Number(p.v?.[i] ?? 0),
    };
    if ([bar.o, bar.h, bar.l, bar.c].every((n) => Number.isFinite(n) && n > 0)) bars.push(bar);
  }
  return bars;
}

/** Parse a Finnhub WebSocket message. Returns the latest trade price per symbol. */
export function parseTradeMessage(message: unknown): Array<{ finnhubSymbol: string; price: number; time: number }> {
  const m = message as { type?: string; data?: Array<{ s?: string; p?: number; t?: number }> };
  if (m?.type !== 'trade' || !Array.isArray(m.data)) return [];
  const latest = new Map<string, { finnhubSymbol: string; price: number; time: number }>();
  for (const trade of m.data) {
    if (!trade?.s || !Number.isFinite(trade.p) || !(trade.p! > 0)) continue;
    const time = Number.isFinite(trade.t) ? (trade.t as number) : Date.now();
    const prev = latest.get(trade.s);
    if (!prev || time >= prev.time) latest.set(trade.s, { finnhubSymbol: trade.s, price: trade.p!, time });
  }
  return [...latest.values()];
}

/**
 * Live feed from Finnhub (https://finnhub.io). Streams last-trade prices over
 * WebSocket for forex, metals and crypto. Candle history uses the REST candle
 * endpoints, which Finnhub only serves on paid plans; when a load fails the
 * symbol keeps simulated history and streams live prices on top.
 */
export class FinnhubFeed {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private stopped = false;
  private connected = false;
  private byFinnhub = new Map<string, InstrumentSpec>();
  private streaming = new Set<string>();
  private historyFailures: string[] = [];
  private error: string | null = null;

  constructor(
    private market: MarketData,
    private opts: FinnhubOptions,
  ) {}

  status(): FinnhubStatus {
    return {
      connected: this.connected,
      streamingSymbols: [...this.streaming],
      historyFailures: [...this.historyFailures],
      error: this.error,
    };
  }

  private report(): void {
    this.opts.onStatus?.(this.status());
  }

  /** Redacts the API key from any URL before logging. */
  private redact(text: string): string {
    return text.split(this.opts.apiKey).join('***');
  }

  async start(specs: InstrumentSpec[]): Promise<void> {
    const mapped = specs.filter((s) => s.finnhubSymbol);
    if (mapped.length === 0) return;
    for (const spec of mapped) this.byFinnhub.set(spec.finnhubSymbol!, spec);

    // History (best effort; Finnhub may return 403 on free plans).
    await Promise.all(
      mapped.map(async (spec) => {
        try {
          await this.loadHistory(spec);
        } catch (err) {
          this.historyFailures.push(spec.symbol);
          this.opts.log?.('warn', `Finnhub history unavailable for ${spec.symbol}: ${this.redact((err as Error).message)} (using simulated history)`);
        }
      }),
    );
    this.connect();
  }

  private async loadHistory(spec: InstrumentSpec): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const base = (this.opts.restUrl ?? 'https://finnhub.io/api/v1').replace(/\/$/, '');
    const count = this.opts.historyBars ?? 500;
    const endpoint = candleEndpoint(spec.finnhubSymbol!);
    const timeframes: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'D1', 'H4'];

    // Fetch H1 once and derive H4 from it.
    const fetched = new Map<Timeframe, Bar[]>();
    for (const tf of timeframes) {
      const resolution = FINNHUB_RESOLUTION[tf];
      if (!resolution) continue;
      const to = Math.floor(Date.now() / 1000);
      const from = to - Math.ceil((count * TIMEFRAME_MS[tf]) / 1000);
      const url = `${base}/${endpoint}/candle?symbol=${encodeURIComponent(spec.finnhubSymbol!)}&resolution=${resolution}&from=${from}&to=${to}`;
      const res = await fetchImpl(url, {
        headers: { 'X-Finnhub-Token': this.opts.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${endpoint}/candle ${tf}`);
      const bars = parseCandles(await res.json());
      if (bars.length === 0) throw new Error(`no ${tf} candles`);
      fetched.set(tf, bars);
    }

    for (const tf of timeframes) {
      if (tf === 'H4') {
        const h1 = fetched.get('H1');
        if (h1) this.market.seed(spec.symbol, 'H4', aggregateBars(h1, TIMEFRAME_MS.H4).slice(-count));
        continue;
      }
      const bars = fetched.get(tf);
      if (bars) this.market.seed(spec.symbol, tf, bars.slice(-count));
    }
    // Every timeframe must be present, otherwise the chart would mix histories.
    for (const tf of timeframes) {
      if (this.market.bars(spec.symbol, tf, 1).length === 0) throw new Error(`missing ${tf} history`);
    }
  }

  private connect(): void {
    if (this.stopped || this.byFinnhub.size === 0) return;
    const url = `${(this.opts.wsUrl ?? 'wss://ws.finnhub.io').replace(/\/$/, '')}?token=${encodeURIComponent(this.opts.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.retries = 0;
      this.error = null;
      for (const sym of this.byFinnhub.keys()) {
        ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
      }
      this.opts.log?.('info', `Finnhub live feed connected (${this.byFinnhub.size} symbols)`);
      this.report();
    });

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if ((parsed as { type?: string })?.type === 'error') {
        this.error = this.redact(`Finnhub: ${(parsed as { msg?: string }).msg ?? 'error'}`);
        this.opts.log?.('warn', this.error);
        this.report();
        return;
      }
      this.handleMessage(parsed);
    });

    ws.on('error', (err) => {
      this.error = this.redact(`Finnhub WebSocket error: ${err.message}`);
      this.opts.log?.('warn', this.error);
    });

    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      this.report();
      this.scheduleReconnect();
    });
  }

  /** Exposed for tests. */
  handleMessage(message: unknown): number {
    let applied = 0;
    for (const trade of parseTradeMessage(message)) {
      const spec = this.byFinnhub.get(trade.finnhubSymbol);
      if (!spec) continue;
      this.market.tick(spec.symbol, trade.price, Date.now(), { source: 'live', spread: spec.spread });
      this.streaming.add(spec.symbol);
      applied++;
    }
    if (applied > 0) this.report();
    return applied;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.retries += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retries, 5));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
