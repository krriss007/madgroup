"use client";

/**
 * MarketWatch — the realtime watchlist table.
 *
 * Columns: Symbol, Bid, Ask, Spread, Change %, High, Low.
 * Prices come from MT5 when connected. With DISCONNECTED MT5 in LIVE mode the
 * table shows "MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE" and no values at all,
 * because fabricating a live price is never acceptable.
 */

import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Star } from 'lucide-react';
import { formatNumber, formatPercent, formatPrice } from '@tradepilot/shared';
import type { Quote } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

export interface MarketWatchProps {
  symbols?: string[];
  selected?: string;
  onSelect?: (canonical: string) => void;
  compact?: boolean;
  showFilter?: boolean;
  className?: string;
  onAddSymbol?: (symbol: string) => void;
}

export function MarketWatch({ symbols, selected, onSelect, compact = false, showFilter = true, className, onAddSymbol }: MarketWatchProps): JSX.Element {
  const { quotes, watchlist, mode, connection, addToWatchlist } = useTerminal();
  const [filter, setFilter] = useState('');
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});

  const list = symbols ?? watchlist;
  const online = mode === 'DEMO' ? true : connection.status === 'CONNECTED';

  const rows = useMemo(() => {
    const filtered = filter ? list.filter((symbol) => symbol.toLowerCase().includes(filter.toLowerCase())) : list;
    return filtered.map((symbol) => ({ symbol, quote: quotes[symbol] ?? null }));
  }, [filter, list, quotes]);

  // Flash rows green/red when the mid price moves.
  useMemo(() => {
    const next: Record<string, 'up' | 'down'> = {};
    for (const { symbol, quote } of rows) {
      if (!quote) continue;
      const previous = quotes[symbol];
      if (!previous) continue;
      const prevMid = (previous.bid + previous.ask) / 2;
      const mid = (quote.bid + quote.ask) / 2;
      if (mid > prevMid) next[symbol] = 'up';
      else if (mid < prevMid) next[symbol] = 'down';
    }
    if (Object.keys(next).length) setFlash(next);
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  return (
    <div className={cn('panel flex min-h-0 flex-col', className)}>
      <div className="panel-header">
        <span>Market Watch</span>
        <div className="flex items-center gap-1.5">
          {mode === 'DEMO' ? <Badge variant="demo">simulated</Badge> : online ? <Badge variant="success">MT5 live</Badge> : <Badge variant="destructive">offline</Badge>}
          <span className="text-2xs text-muted-foreground">{list.length} symbols</span>
        </div>
      </div>

      {showFilter ? (
        <div className="flex items-center gap-2 border-b border-panel-border px-2 py-1.5">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter symbols…"
            className="h-7 text-xs"
            aria-label="Filter symbols"
          />
          {onAddSymbol ? (
            <button
              type="button"
              className="rounded border border-panel-border px-2 py-1 text-2xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                const value = window.prompt('Add a symbol (the broker\'s exact name, e.g. XAUUSDm):');
                if (value) onAddSymbol(value.trim().toUpperCase());
              }}
            >
              + Add
            </button>
          ) : null}
        </div>
      ) : null}

      {!online ? (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-2 py-2 text-2xs font-semibold uppercase tracking-wide text-rose-300">
          MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE
          <span className="mt-0.5 block font-normal normal-case text-rose-200/80">
            Start your MT5 terminal with the TradePilotBridge EA attached. Live prices are never simulated.
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="table-compact">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="text-right">Bid</th>
              <th className="text-right">Ask</th>
              <th className="text-right">Spread</th>
              <th className="text-right">Change %</th>
              {!compact ? (
                <>
                  <th className="text-right">High</th>
                  <th className="text-right">Low</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ symbol, quote }) => {
              const movement = flash[symbol];
              return (
                <tr
                  key={symbol}
                  className={cn(
                    'cursor-pointer',
                    selected === symbol && 'bg-accent/70',
                    movement === 'up' && 'animate-flash-up',
                    movement === 'down' && 'animate-flash-down',
                  )}
                  onClick={() => onSelect?.(symbol)}
                >
                  <td className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {selected === symbol ? <Star className="h-3 w-3 text-primary" /> : null}
                      {symbol}
                    </span>
                  </td>
                  <QuoteCell quote={quote} field="bid" />
                  <QuoteCell quote={quote} field="ask" />
                  <td className="num text-right text-muted-foreground">
                    {quote ? `${formatNumber(quote.spreadPoints, 1)} pts` : '—'}
                  </td>
                  <td className={cn('num text-right', (quote?.changePercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                    {quote ? (
                      <span className="inline-flex items-center gap-0.5">
                        {(quote.changePercent ?? 0) >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        {formatPercent(quote.changePercent, 2)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  {!compact ? (
                    <>
                      <td className="num text-right text-muted-foreground">{quote ? formatPrice(quote.high, quote.digits) : '—'}</td>
                      <td className="num text-right text-muted-foreground">{quote ? formatPrice(quote.low, quote.digits) : '—'}</td>
                    </>
                  ) : null}
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={compact ? 5 : 7} className="py-6 text-center text-2xs text-muted-foreground">
                  No symbols to display. {watchlist.length === 0 ? 'Build a watchlist to start streaming quotes.' : null}
                  {watchlist.length === 0 ? (
                    <button type="button" className="ml-2 text-primary hover:underline" onClick={() => void addToWatchlist('XAUUSD')}>
                      Load defaults
                    </button>
                  ) : null}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="border-t border-panel-border px-2 py-1 text-2xs text-muted-foreground">
        {mode === 'DEMO'
          ? 'Simulated market — demo prices only, never used for live trading.'
          : online
            ? 'Streaming from your MT5 terminal.'
            : 'Waiting for MT5 heartbeat…'}
      </div>
    </div>
  );
}

function QuoteCell({ quote, field }: { quote: Quote | null; field: 'bid' | 'ask' }): JSX.Element {
  return (
    <td className={cn('num text-right', field === 'bid' ? 'text-sky-300' : 'text-amber-300')}>
      {quote ? formatPrice(quote[field], quote.digits) : '—'}
    </td>
  );
}
