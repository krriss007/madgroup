import { useMemo, useState } from 'react';
import type { InstrumentSpec, MarketStatus } from '../../../shared/types';
import type { QuoteView } from '../useTerminal';
import { CATEGORY_LABEL, fmtPct, fmtPrice } from '../lib';

interface Props {
  instruments: InstrumentSpec[];
  quotes: Record<string, QuoteView>;
  selected: string;
  market: MarketStatus | null;
  onSelect: (symbol: string) => void;
}

const CATEGORIES = ['all', 'forex', 'metals', 'indices', 'crypto'] as const;

export function MarketWatch({ instruments, quotes, selected, market, onSelect }: Props) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('all');
  const [query, setQuery] = useState('');
  const liveSet = useMemo(() => new Set(market?.live ?? []), [market]);

  const rows = instruments.filter(
    (i) =>
      (category === 'all' || i.category === category) &&
      (query === '' || i.symbol.toLowerCase().includes(query.toLowerCase()) || i.name.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <section className="panel market-watch">
      <header className="panel-head">
        <span className="panel-title">Market Watch</span>
        <input
          className="search"
          placeholder="Search symbol"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>
      <div className="tabs small">
        {CATEGORIES.map((c) => (
          <button key={c} className={`tab ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
            {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="mw-head">
        <span>Symbol</span>
        <span className="num">Bid</span>
        <span className="num">Ask</span>
        <span className="num">Chg</span>
      </div>
      <div className="mw-list">
        {rows.map((spec) => {
          const q = quotes[spec.symbol];
          const pos = q && q.changePct >= 0;
          return (
            <button
              key={spec.symbol}
              className={`mw-row ${selected === spec.symbol ? 'selected' : ''}`}
              onClick={() => onSelect(spec.symbol)}
            >
              <span className="mw-sym">
                <b>{spec.symbol}</b>
                <small className={`feed-badge ${liveSet.has(spec.symbol) ? 'live' : 'sim'}`}>
                  {liveSet.has(spec.symbol) ? 'LIVE' : 'SIM'}
                </small>
              </span>
              <span className={`num bid ${q ? q.tick : ''}`}>{q ? fmtPrice(q.bid, spec.digits) : '—'}</span>
              <span className={`num ask ${q ? q.tick : ''}`}>{q ? fmtPrice(q.ask, spec.digits) : '—'}</span>
              <span className={`num chg ${pos ? 'pos' : 'neg'}`}>{q ? fmtPct(q.changePct) : '—'}</span>
            </button>
          );
        })}
        {rows.length === 0 && <div className="empty">No symbols match.</div>}
      </div>
    </section>
  );
}
