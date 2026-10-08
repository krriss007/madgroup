"use client";

import { useTerminal } from '@/lib/terminal-context';
import { useSymbols } from '@/hooks/use-symbols';
import { RiskCalculatorPanel } from '@/components/terminal/risk-calculator-panel';
import { Badge } from '@/components/ui/badge';

/** Risk Calculator — position sizing driven by the broker's own symbol specs. */
export default function RiskCalculatorPage(): JSX.Element {
  const { mode, watchlist } = useTerminal();
  const { symbols } = useSymbols();
  const ordered = [
    ...symbols.filter((entry) => watchlist.includes(entry.canonical) || watchlist.includes(entry.symbol)),
    ...symbols.filter((entry) => !watchlist.includes(entry.canonical) && !watchlist.includes(entry.symbol)),
  ];

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-sm font-semibold">Risk calculator</h1>
          <p className="text-2xs text-muted-foreground">
            Position size from your risk budget, the entry/stop distance and the broker specification of the instrument.
          </p>
        </div>
        <Badge variant={mode === 'DEMO' ? 'demo' : 'success'} className="ml-auto">
          {mode === 'DEMO' ? 'demo specifications' : 'MT5 specifications'}
        </Badge>
      </div>

      <RiskCalculatorPanel symbols={ordered} initialSymbol={ordered.some((entry) => entry.canonical === 'XAUUSD') ? 'XAUUSD' : ordered[0]?.canonical ?? 'XAUUSD'} />

      <div className="panel p-3 text-2xs leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground/90">How the size is derived</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          <li>Money at risk = balance × risk %.</li>
          <li>Loss per lot = stop distance in ticks × the tick value your broker reports for 1.00 lot.</li>
          <li>Volume = money at risk ÷ loss per lot, then snapped down to the symbol&apos;s volume step and clamped to its min/max volume.</li>
          <li>The result is additionally capped by your maximum lot size and by the free margin the account has available.</li>
        </ol>
        <p className="mt-1">
          Contract sizes, tick values and volume grids are read from {mode === 'DEMO' ? 'the demo broker profile' : 'your MT5 terminal'} at
          runtime — nothing about XAUUSD or any other instrument is hard-coded in the interface.
        </p>
      </div>
    </div>
  );
}
