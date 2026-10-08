"use client";

import Link from 'next/link';
import { ArrowRight, Coins, Search } from 'lucide-react';
import { useState } from 'react';
import { formatNumber, formatPercent } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { useSymbols } from '@/hooks/use-symbols';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const CATEGORY_LABEL: Record<string, string> = {
  metal: 'Metals',
  forex: 'Forex',
  index: 'Indices',
  crypto: 'Crypto',
  other: 'Other',
};

/** Markets — every instrument the broker carries, with live bid/ask/spread/change/high/low. */
export default function MarketsPage(): JSX.Element {
  const { quotes, mode, connection } = useTerminal();
  const { symbols, loading } = useSymbols();
  const [filter, setFilter] = useState('');

  const groups = ['metal', 'forex', 'index', 'crypto', 'other'].filter((category) => symbols.some((entry) => entry.spec.category === category));
  const filtered = filter ? symbols.filter((entry) => `${entry.symbol} ${entry.canonical} ${entry.spec.description}`.toLowerCase().includes(filter.toLowerCase())) : symbols;
  const online = mode === 'DEMO' || connection.status === 'CONNECTED';

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-sm font-semibold">Markets</h1>
          <p className="text-2xs text-muted-foreground">
            {symbols.length} instruments · specifications read from {mode === 'DEMO' ? 'the demo broker profile' : 'your MT5 terminal'}
          </p>
        </div>
        <div className="relative ml-auto w-56">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter symbols…" className="h-8 pl-7 text-xs" />
        </div>
        <Badge variant={mode === 'DEMO' ? 'demo' : online ? 'success' : 'destructive'}>
          {mode === 'DEMO' ? 'demo prices' : online ? 'MT5 connected' : 'MT5 disconnected'}
        </Badge>
      </div>

      {!online ? (
        <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-2xs font-semibold text-rose-200">
          MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE. Reconnect your MT5 terminal to stream live quotes.
        </p>
      ) : null}

      {groups.map((category) => {
        const rows = filtered.filter((entry) => entry.spec.category === category);
        if (!rows.length) return null;
        return (
          <div key={category} className="panel overflow-hidden">
            <div className="panel-header">
              {CATEGORY_LABEL[category] ?? category}
              <span className="text-2xs font-normal text-muted-foreground">{rows.length} instruments</span>
            </div>
            <div className="overflow-x-auto">
              <table className="table-compact">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="text-right">Bid</th>
                    <th className="text-right">Ask</th>
                    <th className="text-right">Spread</th>
                    <th className="text-right">Change %</th>
                    <th className="text-right">High</th>
                    <th className="text-right">Low</th>
                    <th className="text-right">Contract</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => {
                    const quote = quotes[entry.canonical] ?? null;
                    return (
                      <tr key={entry.symbol} className="hover:bg-accent/40">
                        <td className="font-medium">
                          {entry.canonical === 'XAUUSD' ? <Coins className="mr-1 inline h-3 w-3 text-amber-400" /> : null}
                          {entry.symbol}
                          {entry.symbol !== entry.canonical ? <span className="ml-1 text-2xs text-muted-foreground">({entry.canonical})</span> : null}
                        </td>
                        <td className="num text-right text-sky-300">{quote ? quote.bid.toFixed(entry.spec.digits) : '—'}</td>
                        <td className="num text-right text-amber-300">{quote ? quote.ask.toFixed(entry.spec.digits) : '—'}</td>
                        <td className="num text-right text-muted-foreground">{quote ? formatNumber(quote.spreadPoints, 1) : '—'}</td>
                        <td className={cn('num text-right', (quote?.changePercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                          {quote ? formatPercent(quote.changePercent, 2) : '—'}
                        </td>
                        <td className="num text-right">{quote ? quote.high.toFixed(entry.spec.digits) : '—'}</td>
                        <td className="num text-right">{quote ? quote.low.toFixed(entry.spec.digits) : '—'}</td>
                        <td className="num text-right text-muted-foreground">{formatNumber(entry.spec.contractSize, 0)}</td>
                        <td className="text-right">
                          <Button asChild size="xs" variant="ghost">
                            <Link href={`/markets/${entry.canonical.toLowerCase()}`}>
                              Trade <ArrowRight className="h-3 w-3" />
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {loading ? <p className="text-2xs text-muted-foreground">Loading instrument list…</p> : null}
      {!loading && symbols.length === 0 ? (
        <p className="panel p-4 text-center text-xs text-muted-foreground">
          No instruments available. In LIVE mode this means the MT5 bridge has not reported a Market Watch list yet.
        </p>
      ) : null}
    </div>
  );
}
