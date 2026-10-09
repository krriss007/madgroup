/**
 * TradePilot — market data service.
 *
 * Single entry point the rest of the backend uses to obtain symbols, quotes and
 * candles. It resolves the correct source for the requested mode:
 *
 *   DEMO → MarketSimulator (explicitly labelled simulated data)
 *   LIVE → the quote cache fed by the user's MT5 terminal through the EA
 *
 * If a LIVE account has no live data the service returns an empty result and
 * the API answers with `MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE`. It never
 * falls back to simulated numbers for a live account.
 */

import { EventEmitter } from 'node:events';
import {
  ErrorCode,
  TradePilotError,
  canonicalize,
  type Candle,
  type Quote,
  type SymbolInfo,
  type Timeframe,
  type TradingMode,
} from '@tradepilot/shared';
import type { EaSymbolPayload, EaTickPayload } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { SymbolRow } from '../db/types';
import type { Logger } from '../lib/logger';
import { MarketSimulator, type SimulatedQuote } from './demo/market-simulator';
import { eaSymbolToSymbolInfo, eaTickToQuote, simulatedQuoteToQuote, simulatedQuoteToSymbolInfo } from './market/converters';
import { newId } from '../lib/ids';

interface LiveSymbolState {
  symbol: SymbolInfo;
  bid: number;
  ask: number;
  spreadPoints: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  time: number;
  receivedAt: number;
}

export interface MarketAvailability {
  mode: TradingMode;
  online: boolean;
  message: string | null;
  reason: 'MT5_ONLINE' | 'MT5_OFFLINE' | 'DEMO_SIMULATED';
  lastQuoteAt: string | null;
}

export class MarketService extends EventEmitter {
  private readonly liveStates = new Map<string, Map<string, LiveSymbolState>>();
  private readonly liveSymbols = new Map<string, Map<string, SymbolInfo>>();

  constructor(
    private readonly store: Store,
    private readonly simulator: MarketSimulator,
    private readonly logger: Logger,
  ) {
    super();
    // Forward simulator ticks so the WebSocket hub can broadcast demo quotes.
    this.simulator.on('tick', (quotes: SimulatedQuote[]) => {
      this.emit('demo-quotes', quotes.map(simulatedQuoteToQuote));
    });
  }

  /* ------------------------------------------------------------------ */
  /* DEMO                                                               */
  /* ------------------------------------------------------------------ */

  getSimulator(): MarketSimulator {
    return this.simulator;
  }

  demoQuotes(canonicals?: string[]): Quote[] {
    const wanted = canonicals ? new Set(canonicals.map((c) => canonicalize(c))) : null;
    return this.simulator
      .quotes()
      .filter((q) => !wanted || wanted.has(q.canonical))
      .map((q) => simulatedQuoteToQuote(q));
  }

  demoSymbols(canonicals?: string[]): SymbolInfo[] {
    const wanted = canonicals ? new Set(canonicals.map((c) => canonicalize(c))) : null;
    return this.simulator
      .quotes()
      .filter((q) => !wanted || wanted.has(q.canonical))
      .map((q) => simulatedQuoteToSymbolInfo(q));
  }

  demoCandles(canonical: string, timeframe: Timeframe, count: number): Candle[] {
    return this.simulator.candles(canonicalize(canonical), timeframe, count);
  }

  /* ------------------------------------------------------------------ */
  /* LIVE (EA reported)                                                  */
  /* ------------------------------------------------------------------ */

  deviceKey(userId: string, deviceId: string): string {
    return `${userId}:${deviceId}`;
  }

  /** Store the broker's real symbol specifications reported by the EA. */
  async ingestSymbols(userId: string, deviceId: string, connectionId: string, payloads: EaSymbolPayload[]): Promise<number> {
    const key = this.deviceKey(userId, deviceId);
    const map = this.liveSymbols.get(key) ?? new Map<string, SymbolInfo>();
    let stored = 0;

    for (const payload of payloads) {
      const info = eaSymbolToSymbolInfo(payload);
      map.set(info.symbol, info);
      const row: SymbolRow = {
        id: `sym_${userId}_${info.symbol}`.replace(/[^A-Za-z0-9_.-]/g, '_'),
        userId,
        connectionId,
        symbol: info.symbol,
        canonical: info.canonical,
        source: 'MT5',
        spec: info as unknown as Record<string, unknown>,
        updatedAt: new Date().toISOString(),
      };
      await this.store.symbols.upsert(row);
      stored += 1;
    }

    this.liveSymbols.set(key, map);
    this.emit('symbols', { userId, deviceId, symbols: [...map.values()] });
    return stored;
  }

  /** Update the live quote cache from an EA tick batch. */
  ingestTicks(userId: string, deviceId: string, payloads: EaTickPayload[]): Quote[] {
    const key = this.deviceKey(userId, deviceId);
    const states = this.liveStates.get(key) ?? new Map<string, LiveSymbolState>();
    const symbols = this.liveSymbols.get(key) ?? new Map<string, SymbolInfo>();
    const quotes: Quote[] = [];

    for (const tick of payloads) {
      const info = symbols.get(tick.symbol);
      if (!info) continue; // ignore quotes for symbols we have no specification for
      const canonical = info.canonical;
      const previous = states.get(tick.symbol);
      const dayOpen = (tick as EaTickPayload & { day_open?: number }).day_open ?? previous?.open ?? tick.bid;
      const state: LiveSymbolState = {
        symbol: info,
        bid: tick.bid,
        ask: tick.ask,
        spreadPoints: tick.spread_points,
        high: (tick as EaTickPayload & { day_high?: number }).day_high ?? Math.max(previous?.high ?? tick.ask, tick.ask),
        low: (tick as EaTickPayload & { day_low?: number }).day_low ?? Math.min(previous?.low ?? tick.bid, tick.bid),
        open: dayOpen,
        previousClose: previous?.open ?? dayOpen,
        time: Date.parse(tick.time) || Date.now(),
        receivedAt: Date.now(),
      };
      states.set(tick.symbol, state);
      quotes.push(eaTickToQuote(tick, state, info));
    }

    this.liveStates.set(key, states);
    if (quotes.length) this.emit('live-quotes', { userId, deviceId, quotes });
    return quotes;
  }

  liveSymbolsFor(userId: string, deviceId: string): SymbolInfo[] {
    return [...(this.liveSymbols.get(this.deviceKey(userId, deviceId))?.values() ?? [])];
  }

  liveQuotesFor(userId: string, deviceId: string): Quote[] {
    const states = this.liveStates.get(this.deviceKey(userId, deviceId));
    if (!states) return [];
    const out: Quote[] = [];
    for (const state of states.values()) out.push(this.liveQuote(state));
    return out;
  }

  private liveQuote(state: LiveSymbolState): Quote {
    const spread = Math.max(0, state.ask - state.bid);
    return {
      symbol: state.symbol.symbol,
      canonical: state.symbol.canonical,
      bid: state.bid,
      ask: state.ask,
      spread,
      spreadPoints: state.symbol.point > 0 ? Math.round((spread / state.symbol.point) * 10) / 10 : state.spreadPoints,
      digits: state.symbol.digits,
      high: state.high,
      low: state.low,
      open: state.open,
      close: state.bid,
      changePercent: state.open ? ((state.bid - state.open) / state.open) * 100 : 0,
      time: new Date(state.time).toISOString(),
      source: 'MT5',
    };
  }

  /** Restore cached symbol specs from the database after a restart. */
  async loadSymbolsFromStore(userId: string, deviceId: string, connectionId: string): Promise<void> {
    const rows = await this.store.symbols.findMany({ userId: { eq: userId }, connectionId: { eq: connectionId } });
    if (!rows.length) return;
    const map = new Map<string, SymbolInfo>();
    for (const row of rows) map.set(row.symbol, row.spec as unknown as SymbolInfo);
    this.liveSymbols.set(this.deviceKey(userId, deviceId), map);
  }

  /* ------------------------------------------------------------------ */
  /* unified accessors                                                  */
  /* ------------------------------------------------------------------ */

  async listSymbols(mode: TradingMode, userId: string, deviceId?: string | null): Promise<SymbolInfo[]> {
    if (mode === 'DEMO') return this.demoSymbols();
    if (!deviceId) return [];
    return this.liveSymbolsFor(userId, deviceId);
  }

  async getSymbolSpec(mode: TradingMode, userId: string, symbol: string, deviceId?: string | null): Promise<SymbolInfo> {
    const canonical = canonicalize(symbol);
    const list = await this.listSymbols(mode, userId, deviceId);
    const exact = list.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
    if (exact) return exact;
    const byCanonical = list.find((s) => s.canonical === canonical);
    if (byCanonical) return byCanonical;
    if (mode === 'LIVE') {
      throw new TradePilotError(
        ErrorCode.SYMBOL_NOT_FOUND,
        `Symbol ${symbol} is not available on your MT5 account. The EA reports the broker's actual symbol names — check Settings → MT5 Connection for the symbol list.`,
        404,
      );
    }
    throw new TradePilotError(ErrorCode.SYMBOL_NOT_FOUND, `Unknown symbol ${symbol}.`, 404);
  }

  async getQuotes(mode: TradingMode, userId: string, symbols: string[], deviceId?: string | null): Promise<Quote[]> {
    const canonicals = symbols.map((s) => canonicalize(s));
    if (mode === 'DEMO') return this.demoQuotes(canonicals.length ? canonicals : undefined);
    if (!deviceId) return [];
    const all = this.liveQuotesFor(userId, deviceId);
    if (!canonicals.length) return all;
    const wanted = new Set(canonicals);
    const known = new Set(this.liveSymbolsFor(userId, deviceId).map((s) => s.symbol));
    return all.filter((q) => wanted.has(q.canonical) || known.has(q.symbol));
  }

  async getCandles(
    mode: TradingMode,
    userId: string,
    symbol: string,
    timeframe: Timeframe,
    count: number,
    liveProvider?: (symbol: string, timeframe: Timeframe, count: number) => Promise<Candle[]>,
  ): Promise<Candle[]> {
    if (mode === 'DEMO') return this.demoCandles(symbol, timeframe, count);
    if (!liveProvider) return [];
    return liveProvider(symbol, timeframe, count);
  }

  availability(mode: TradingMode, online: boolean, lastHeartbeatAge: number | null): MarketAvailability {
    if (mode === 'DEMO') {
      return {
        mode,
        online: true,
        message: 'Simulated demo market — prices are generated locally and are not tradable market prices.',
        reason: 'DEMO_SIMULATED',
        lastQuoteAt: new Date().toISOString(),
      };
    }
    if (!online) {
      return {
        mode,
        online: false,
        message: 'MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE',
        reason: 'MT5_OFFLINE',
        lastQuoteAt: null,
      };
    }
    const quotes = this.liveQuotesFor('', '');
    return {
      mode,
      online: true,
      message: null,
      reason: 'MT5_ONLINE',
      lastQuoteAt: quotes[0]?.time ?? null,
    };
  }

  /** Daily stats for the instrument detail panels. */
  dayStatsFor(canonical: string): { high: number; low: number; open: number } | null {
    return this.simulator.dayStats(canonical);
  }

  markLiveStale(): void {
    this.logger.debug({}, 'live market cache retained while the device is offline');
  }
}

export { simulatedQuoteToQuote, simulatedQuoteToSymbolInfo };
export { newId };
