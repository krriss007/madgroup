"use client";

/** Horizontal price ticker shown above the dashboard content. */

import { formatPercent, formatPrice } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { cn } from '@/lib/utils';

export function TickerTape(): JSX.Element | null {
  const { watchlist, quotes, mode, connection } = useTerminal();
  const online = mode === "DEMO" || connection.status === "CONNECTED";
  if (!watchlist.length) return null;

  return (
    <div className="flex items-center gap-4 overflow-x-auto border-b border-panel-border bg-panel/60 px-3 py-1.5 text-2xs scrollbar-none">
      {!online ? (
        <span className="whitespace-nowrap font-semibold text-rose-300">MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE</span>
      ) : null}
      {watchlist.map((symbol) => {
        const quote = quotes[symbol];
        if (!quote) return null;
        return (
          <span key={symbol} className="flex shrink-0 items-center gap-1.5">
            <span className="font-semibold text-foreground/90">{symbol}</span>
            <span className="num text-muted-foreground">{formatPrice(quote.bid, quote.digits)}</span>
            <span className={cn("num", (quote.changePercent ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
              {formatPercent(quote.changePercent, 2)}
            </span>
          </span>
        );
      })}
      {mode === "DEMO" ? <span className="ml-auto shrink-0 text-amber-300/80">simulated prices</span> : null}
    </div>
  );
}
