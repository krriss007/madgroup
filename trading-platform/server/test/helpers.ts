import { INSTRUMENTS } from '../market/instruments';
import { MarketData } from '../market/marketData';
import { createAccount, TradingEngine, type PersistedAccount, type EngineEvent } from '../trading/engine';

export interface Harness {
  market: MarketData;
  engine: TradingEngine;
  state: PersistedAccount;
  clock: { t: number };
  events: EngineEvent[];
  /** Set a new price for a symbol and run the engine's tick handler (SL/TP, pending, stop-out). */
  tick: (symbol: string, mid: number) => void;
}

export function harness(start = Date.UTC(2026, 9, 12, 10, 0, 0)): Harness {
  const market = new MarketData(INSTRUMENTS);
  const clock = { t: start };
  const state = createAccount(start);
  const events: EngineEvent[] = [];
  const engine = new TradingEngine({
    market,
    state,
    now: () => clock.t,
    onEvent: (e) => events.push(e),
  });
  // Initial prices (sim source, Standard spreads).
  for (const spec of INSTRUMENTS) market.tick(spec.symbol, spec.simBasePrice, start, { source: 'sim', spread: spec.spread });
  const tick = (symbol: string, mid: number) => {
    const spec = market.spec(symbol)!;
    market.tick(symbol, mid, clock.t, { source: 'sim', spread: spec.spread });
    engine.onMarketTick(symbol);
  };
  return { market, engine, state, clock, events, tick };
}
