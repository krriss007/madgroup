"use client";

import Link from 'next/link';
import { ArrowRight, Gauge } from 'lucide-react';
import { formatNumber, formatPercent } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { useSymbols } from '@/hooks/use-symbols';
import { InstrumentPanel } from '@/components/terminal/instrument-panel';
import { ConnectionStatus } from '@/components/terminal/connection-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Forex overview — the FX majors/pairs carried by the broker, with a link into each terminal. */
export default function ForexPage(): JSX.Element {
  const { quotes, mode } = useTerminal();
  const { symbols } = useSymbols();
  const fx = symbols.filter((entry) => entry.spec.category === 'forex');
  const primary = fx.find((entry) => entry.canonical === 'EURUSD') ?? fx[0] ?? null;
  const primaryQuote = primary ? quotes[primary.canonical] ?? null : null;

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="flex items-center gap-1.5 text-sm font-semibold">
            <Gauge className="h-4 w-4 text-sky-400" /> Forex markets
          </h1>
          <p className="text-2xs text-muted-foreground">
            {fx.length} instrument{fx.length === 1 ? '' : 's'} available from {mode === 'DEMO' ? 'the demo broker profile' : 'your MT5 terminal'}.
          </p>
        </div>
        <Badge variant={mode === 'DEMO' ? 'demo' : 'success'} className="ml-auto">
          {mode === 'DEMO' ? 'simulated prices' : 'MT5 live prices'}
        </Badge>
      </div>

      {primary ? (
        <InstrumentPanel
          symbol={primary.symbol}
          quote={primaryQuote}
          spec={primary.spec}
          compact={false}
        />
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="panel overflow-hidden">
          <div className="panel-header">
            Major pairs <span className="text-2xs font-normal text-muted-foreground">{fx.length} instruments</span>
          </div>
          <div className="overflow-x-auto">
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="text-right">Bid</th>
                  <th className="text-right">Ask</th>
                  <th className="text-right">Spread</th>
                  <th className="text-right">Change</th>
                  <th className="text-right">High / Low</th>
                  <th className="text-right">Digits</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {fx.map((entry) => {
                  const quote = quotes[entry.canonical] ?? null;
                  return (
                    <tr key={entry.symbol} className="hover:bg-accent/40">
                      <td className="font-medium">
                        {entry.symbol}
                        {entry.symbol !== entry.canonical ? <span className="ml-1 text-2xs text-muted-foreground">({entry.canonical})</span> : null}
                      </td>
                      <td className="num text-right text-sky-300">{quote ? quote.bid.toFixed(entry.spec.digits) : '—'}</td>
                      <td className="num text-right text-amber-300">{quote ? quote.ask.toFixed(entry.spec.digits) : '—'}</td>
                      <td className="num text-right text-muted-foreground">{quote ? formatNumber(quote.spreadPoints, 1) : '—'}</td>
                      <td className={cn('num text-right', (quote?.changePercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {quote ? formatPercent(quote.changePercent, 2) : '—'}
                      </td>
                      <td className="num text-right text-muted-foreground">
                        {quote ? `${quote.high.toFixed(entry.spec.digits)} / ${quote.low.toFixed(entry.spec.digits)}` : '—'}
                      </td>
                      <td className="num text-right text-muted-foreground">{entry.spec.digits}</td>
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
                {fx.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-2xs text-muted-foreground">
                      No forex instruments reported {mode === 'LIVE' ? 'by your MT5 terminal — check that Market Watch shows the symbols in MT5' : 'yet'}.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-3">
          <ConnectionStatus />
          <div className="panel p-3 text-2xs leading-relaxed text-muted-foreground">
            <p className="font-semibold text-foreground/90">Pricing source</p>
            <p className="mt-1">
              Prices shown here are the bid/ask your broker is streaming to the connected MT5 terminal. When MT5 is disconnected the
              table keeps the last known values greyed out — it never substitutes invented prices. In DEMO mode the values come from the
              TradePilot demo simulator and are labelled as simulated.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
