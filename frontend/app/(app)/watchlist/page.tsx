"use client";

import { useMemo, useState } from 'react';
import { Plus, Search, Star, Trash2 } from 'lucide-react';
import { formatPercent } from '@tradepilot/shared';
import { DEFAULT_WATCHLIST } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { useSymbols } from '@/hooks/use-symbols';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Watchlist — the symbols streamed to this terminal; defaults to the 11 core instruments. */
export default function WatchlistPage(): JSX.Element {
  const { watchlist, quotes, mode, connection, addToWatchlist, removeFromWatchlist, refresh } = useTerminal();
  const { symbols } = useSymbols();
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(() => {
    const held = new Set(watchlist);
    const query = filter.trim().toLowerCase();
    return symbols
      .filter((entry) => !held.has(entry.canonical) && !held.has(entry.symbol))
      .filter((entry) => (query ? `${entry.symbol} ${entry.spec.description}`.toLowerCase().includes(query) : true))
      .slice(0, 40);
  }, [filter, symbols, watchlist]);

  async function add(symbol: string): Promise<void> {
    setSaving(true);
    try {
      await addToWatchlist(symbol);
    } finally {
      setSaving(false);
    }
  }

  async function remove(canonical: string): Promise<void> {
    setSaving(true);
    try {
      await removeFromWatchlist(canonical);
    } finally {
      setSaving(false);
    }
  }

  async function restoreDefaults(): Promise<void> {
    setSaving(true);
    try {
      const missing = DEFAULT_WATCHLIST.map((symbol) => symbol.toUpperCase()).filter(
        (symbol) => !watchlist.includes(symbol),
      );
      for (const symbol of missing) await addToWatchlist(symbol);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  const online = mode === 'DEMO' || connection.status === 'CONNECTED';

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="flex items-center gap-1.5 text-sm font-semibold">
            <Star className="h-4 w-4 text-amber-400" /> Watchlist
          </h1>
          <p className="text-2xs text-muted-foreground">
            {watchlist.length} of {symbols.length} instruments streamed · default set: {DEFAULT_WATCHLIST.join(', ')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="subtle"
            disabled={saving}
            onClick={() => void restoreDefaults()}
          >
            Restore defaults
          </Button>
          <Badge variant={mode === 'DEMO' ? 'demo' : online ? 'success' : 'destructive'}>
            {mode === 'DEMO' ? 'demo prices' : online ? 'MT5 connected' : 'MT5 disconnected'}
          </Badge>
        </div>
      </div>

      {!online ? (
        <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-2xs font-semibold text-rose-200">
          MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE
        </p>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="panel overflow-hidden">
          <div className="panel-header">
            On the watchlist <span className="text-2xs font-normal text-muted-foreground">{watchlist.length} symbols</span>
          </div>
          <div className="overflow-x-auto">
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="text-right">Bid</th>
                  <th className="text-right">Ask</th>
                  <th className="text-right">Change</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {watchlist.map((symbol) => {
                  const quote = quotes[symbol] ?? null;
                  return (
                    <tr key={symbol}>
                      <td className="font-medium">{symbol}</td>
                      <td className="num text-right text-sky-300">{quote ? quote.bid.toFixed(quote.digits) : '—'}</td>
                      <td className="num text-right text-amber-300">{quote ? quote.ask.toFixed(quote.digits) : '—'}</td>
                      <td className={cn('num text-right', (quote?.changePercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {quote ? formatPercent(quote.changePercent, 2) : '—'}
                      </td>
                      <td className="text-right">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void remove(symbol)}
                          title="Remove from watchlist"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {watchlist.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-5 text-center text-2xs text-muted-foreground">
                      Watchlist is empty — add instruments from the list on the right.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel overflow-hidden">
          <div className="panel-header">
            Add instruments
            <div className="relative w-44">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search…" className="h-7 pl-6 text-2xs" />
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto">
            <table className="table-compact">
              <tbody>
                {candidates.map((entry) => (
                  <tr key={entry.symbol}>
                    <td className="font-medium">{entry.symbol}</td>
                    <td className="text-muted-foreground">{entry.spec.description}</td>
                    <td className="text-right">
                      <Button size="xs" variant="ghost" disabled={saving} onClick={() => void add(entry.canonical)}>
                        <Plus className="h-3.5 w-3.5" /> Add
                      </Button>
                    </td>
                  </tr>
                ))}
                {candidates.length === 0 ? (
                  <tr>
                    <td className="py-5 text-center text-2xs text-muted-foreground">Nothing left to add{filter ? ' for this filter' : ''}.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
