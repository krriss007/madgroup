"use client";

/**
 * InstrumentPanel — the instrument detail card, used first and foremost for
 * XAUUSD (primary instrument): gold price, bid/ask, spread, daily high/low, ATR,
 * current session and market status, plus the session indicators.
 */

import { Clock, Coins, Moon, Sun, Sunrise } from 'lucide-react';
import { formatNumber, formatPrice, relativeTime } from '@tradepilot/shared';
import type { Quote, SymbolInfo } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { SESSION_WINDOWS, useMarketClock } from '@/hooks/use-market-clock';

export interface InstrumentPanelProps {
  symbol: string;
  quote: Quote | null;
  spec: SymbolInfo | null;
  atr?: number | null;
  compact?: boolean;
}

export function InstrumentPanel({ symbol, quote, spec, atr, compact = false }: InstrumentPanelProps): JSX.Element {
  const { mode, connection } = useTerminal();
  const { activeSessions, label, weekendClosed, utcTime, londonNewYorkOverlap } = useMarketClock();
  const online = mode === "DEMO" || connection.status === "CONNECTED";

  const spread = quote ? quote.ask - quote.bid : null;
  const dayRange = quote ? quote.high - quote.low : null;

  return (
    <div className="panel p-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            {symbol === "XAUUSD" ? <Coins className="h-4 w-4 text-amber-400" /> : <Clock className="h-4 w-4 text-sky-400" />}
            {symbol}
            <span className="text-2xs font-normal text-muted-foreground">{spec?.description ?? ""}</span>
          </p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {spec ? `${spec.currencyBase}/${spec.currencyProfit} · ${spec.digits} digits · contract ${formatNumber(spec.contractSize, 0)}` : "Waiting for symbol specification…"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {mode === "DEMO" ? <Badge variant="demo">simulated</Badge> : online ? <Badge variant="success">MT5 live</Badge> : <Badge variant="destructive">offline</Badge>}
          <Badge variant={weekendClosed ? "warning" : "outline"}>{weekendClosed ? "market closed (weekend)" : "market open"}</Badge>
        </div>
      </div>

      {!online ? (
        <p className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-2xs font-semibold text-rose-200">
          MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 md:grid-cols-4">
          <Metric label="Bid" value={quote ? formatPrice(quote.bid, quote.digits) : "—"} tone="bid" />
          <Metric label="Ask" value={quote ? formatPrice(quote.ask, quote.digits) : "—"} tone="ask" />
          <Metric label="Spread" value={spread != null ? `${formatPrice(spread, quote?.digits ?? 2)} (${formatNumber(quote?.spreadPoints ?? 0, 1)} pts)` : "—"} />
          <Metric
            label="Change"
            value={quote ? `${formatNumber(quote.changePercent, 2)}%` : "—"}
            toneClass={(quote?.changePercent ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}
          />
          {!compact ? (
            <>
              <Metric label="Daily high" value={quote ? formatPrice(quote.high, quote.digits) : "—"} />
              <Metric label="Daily low" value={quote ? formatPrice(quote.low, quote.digits) : "—"} />
              <Metric label="Daily range" value={dayRange != null ? formatPrice(dayRange, quote?.digits ?? 2) : "—"} />
              <Metric label="ATR (14, M15)" value={atr != null ? formatPrice(atr, quote?.digits ?? 2) : "—"} />
            </>
          ) : null}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-panel-border pt-2">
        <span className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
          <Sun className="h-3 w-3" /> Session
        </span>
        {SESSION_WINDOWS.map((session) => {
          const active = activeSessions.some((entry) => entry.id === session.id);
          return (
            <span
              key={session.id}
              className={cn(
                "rounded border px-1.5 py-0.5 text-2xs",
                active ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-panel-border text-muted-foreground",
              )}
              title={`${session.start}-${session.end} UTC`}
            >
              {session.id === "SYDNEY" ? <Moon className="mr-1 inline h-3 w-3" /> : null}
              {session.id === "LONDON" ? <Sunrise className="mr-1 inline h-3 w-3" /> : null}
              {session.label}{" "}
              <span className="opacity-70">
                {session.start}–{session.end}
              </span>
            </span>
          );
        })}
        <span className="ml-auto text-2xs text-muted-foreground">
          {label} · {utcTime} UTC{londonNewYorkOverlap ? " · London/NY overlap" : ""}
        </span>
      </div>

      <p className="mt-2 text-[10px] text-muted-foreground">
        Last update {relativeTime(quote?.time ?? null)} · source {quote?.source === "MT5" ? "MT5 terminal" : mode === "DEMO" ? "TradePilot demo simulator" : "unavailable"}
      </p>
    </div>
  );
}

function Metric({ label, value, tone, toneClass }: { label: string; value: string; tone?: "bid" | "ask"; toneClass?: string }): JSX.Element {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("num text-sm", tone === "bid" && "text-sky-300", tone === "ask" && "text-amber-300", toneClass)}>{value}</p>
    </div>
  );
}
