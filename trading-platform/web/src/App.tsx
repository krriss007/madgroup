import { useEffect, useMemo, useState } from 'react';
import { TIMEFRAMES, type Timeframe } from '../../shared/types';
import { useTerminal } from './useTerminal';
import { TopBar } from './components/TopBar';
import { MarketWatch } from './components/MarketWatch';
import { Chart } from './components/Chart';
import { OrderTicket } from './components/OrderTicket';
import { BottomPanel } from './components/BottomPanel';
import { AgentPanel } from './components/AgentPanel';
import { fmtPct, fmtPrice } from './lib';

export function App() {
  const term = useTerminal();
  const { state, subscribe, dismiss, toast } = term;
  const [symbol, setSymbol] = useState('EURUSD');
  const [tf, setTf] = useState<Timeframe>('M15');

  useEffect(() => {
    subscribe(symbol, tf);
  }, [symbol, tf, subscribe]);

  // Toasts disappear after a few seconds.
  useEffect(() => {
    const timers = state.toasts.map((t) => setTimeout(() => dismiss(t.id), 4500));
    return () => timers.forEach(clearTimeout);
  }, [state.toasts, dismiss]);

  const spec = useMemo(() => state.instruments.find((i) => i.symbol === symbol), [state.instruments, symbol]);
  const quote = state.quotes[symbol];
  const quotesForConversion = state.quotes;
  const positions = state.live?.positions ?? [];
  const pending = state.live?.pending ?? [];
  const liveSymbols = new Set(state.market?.live ?? []);

  if (!spec || !state.accountTypes) {
    return (
      <div className="boot">
        <div className="spinner" />
        <span>Connecting to the trading server…</span>
      </div>
    );
  }

  const accountType = state.full?.summary.settings.accountType ?? state.live?.summary.settings.accountType ?? 'standard';

  return (
    <div className="app">
      <TopBar summary={state.live?.summary ?? null} connected={state.connected} market={state.market} onToast={toast} />

      <main className="layout">
        <MarketWatch
          instruments={state.instruments}
          quotes={state.quotes}
          selected={symbol}
          market={state.market}
          onSelect={setSymbol}
        />

        <div className="center">
          <div className="chart-toolbar">
            <div className="sym">
              <b>{symbol}</b>
              <small className="muted">{spec.name}</small>
              <span className={`feed-badge ${liveSymbols.has(symbol) ? 'live' : 'sim'}`}>
                {liveSymbols.has(symbol) ? 'LIVE' : 'SIMULATED'}
              </span>
            </div>
            <div className="quote-inline">
              <span className="num sell-t">{fmtPrice(quote?.bid, spec.digits)}</span>
              <span className="num buy-t">{fmtPrice(quote?.ask, spec.digits)}</span>
              <span className={`num ${quote && quote.changePct >= 0 ? 'pos' : 'neg'}`}>{fmtPct(quote?.changePct)}</span>
              <span className="muted small">
                H {fmtPrice(quote?.high, spec.digits)} · L {fmtPrice(quote?.low, spec.digits)}
              </span>
            </div>
            <div className="tf">
              {TIMEFRAMES.map((t) => (
                <button key={t} className={t === tf ? 'active' : ''} onClick={() => setTf(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-wrap">
            <Chart
              symbol={symbol}
              tf={tf}
              digits={spec.digits}
              bar={state.bar}
              positions={positions}
              pending={pending}
            />
          </div>
          <BottomPanel instruments={state.instruments} live={state.live} full={state.full} onToast={toast} />
        </div>

        <aside className="right">
          <OrderTicket
            spec={spec}
            quote={quote}
            quotes={quotesForConversion}
            summary={state.live?.summary ?? null}
            accountType={accountType}
            onToast={toast}
          />
          <AgentPanel status={state.agent} logs={state.agentLogs} instruments={state.instruments} onToast={toast} />
        </aside>
      </main>

      <div className="toasts">
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`} onClick={() => dismiss(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
