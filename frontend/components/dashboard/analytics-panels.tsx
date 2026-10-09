"use client";

/**
 * Portfolio analytics panels: headline metrics, daily/monthly P/L bars, P/L
 * distribution and win/loss split. All numbers come from the trades the account
 * actually executed; an empty account shows an explicit "no data" state rather
 * than invented statistics.
 */

import { BarChart3, PiggyBank, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { formatMoney, formatNumber, formatPercent } from '@tradepilot/shared';
import type { AnalyticsSummary } from '@tradepilot/shared';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

export function AnalyticsPanels({ summary, loading }: { summary: AnalyticsSummary | null; loading?: boolean }): JSX.Element {
  if (loading || !summary) {
    return (
      <div className="grid gap-2 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  const metrics = [
    { label: "Net P/L", value: formatMoney(summary.netProfit ?? 0), tone: (summary.netProfit ?? 0) >= 0 ? "positive" : "negative", icon: <PiggyBank className="h-3 w-3" /> },
    { label: "Total trades", value: String(summary.totalTrades ?? 0) },
    { label: "Win rate", value: summary.winRate != null ? formatPercent(summary.winRate, 1) : "—", icon: <Target className="h-3 w-3" /> },
    { label: "Profit factor", value: summary.profitFactor != null ? formatNumber(summary.profitFactor, 2) : "—", icon: <BarChart3 className="h-3 w-3" /> },
    { label: "Average win", value: summary.averageWin != null ? formatMoney(summary.averageWin) : "—", tone: "positive" },
    { label: "Average loss", value: summary.averageLoss != null ? formatMoney(summary.averageLoss) : "—", tone: "negative" },
    { label: "Max drawdown", value: `${formatMoney(summary.maxDrawdown ?? 0)} (${formatNumber(summary.maxDrawdownPercent ?? 0, 1)}%)`, icon: <TrendingDown className="h-3 w-3" /> },
    { label: "Expectancy / trade", value: summary.expectancy != null ? formatMoney(summary.expectancy) : "—", icon: <TrendingUp className="h-3 w-3" /> },
  ];

  // Every series is optional at the type level: an account with no closed trades,
  // or a payload that predates a field, must render an empty state instead of
  // throwing while the terminal is on screen.
  const daily = (summary.dailyPl ?? []).slice(-30);
  const monthly = (summary.monthlyPl ?? []).slice(-12);
  const buckets = summary.distribution?.buckets ?? [];
  const winLoss = summary.distribution?.winLoss ?? { wins: summary.wins ?? 0, losses: summary.losses ?? 0, breakEven: summary.breakEven ?? 0 };
  const bySymbol = summary.bySymbol ?? [];
  const maxDaily = Math.max(1, ...daily.map((entry) => Math.abs(entry.pl)));
  const maxMonthly = Math.max(1, ...monthly.map((entry) => Math.abs(entry.pl)));
  const maxBucket = Math.max(1, ...buckets.map((bucket) => bucket.count));

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="panel p-2.5">
            <p className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
              {metric.icon}
              {metric.label}
            </p>
            <p
              className={cn(
                "num mt-1 text-sm font-semibold",
                metric.tone === "positive" && "text-emerald-400",
                metric.tone === "negative" && "text-rose-400",
              )}
            >
              {metric.value}
            </p>
          </div>
        ))}
      </div>

      {!summary.hasData ? (
        <div className="panel p-4 text-center text-xs text-muted-foreground">
          No trades recorded on this account yet, so there are no statistics to show. Metrics appear as soon as the first position is closed.
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="panel p-3">
            <p className="panel-header -mx-3 -mt-3 mb-2">Daily P/L (last 30 days)</p>
            <div className="flex h-36 items-end gap-1">
              {daily.length === 0 ? <p className="text-2xs text-muted-foreground">No closed trades in the period.</p> : null}
              {daily.map((entry) => (
                <div key={entry.date} className="group flex h-full flex-1 flex-col justify-end" title={`${entry.date}: ${formatMoney(entry.pl)} (${entry.trades} trades)`}>
                  <div
                    className={cn("w-full rounded-sm", entry.pl >= 0 ? "bg-emerald-500/70" : "bg-rose-500/70")}
                    style={{ height: `${(Math.abs(entry.pl) / maxDaily) * 100}%`, minHeight: 2 }}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-3">
            <p className="panel-header -mx-3 -mt-3 mb-2">Monthly P/L</p>
            <div className="flex h-36 items-end gap-2">
              {monthly.length === 0 ? <p className="text-2xs text-muted-foreground">No closed trades in the period.</p> : null}
              {monthly.map((entry) => (
                <div key={entry.month} className="flex h-full flex-1 flex-col justify-end" title={`${entry.month}: ${formatMoney(entry.pl)}`}>
                  <div
                    className={cn("w-full rounded-sm", entry.pl >= 0 ? "bg-emerald-500/70" : "bg-rose-500/70")}
                    style={{ height: `${(Math.abs(entry.pl) / maxMonthly) * 100}%`, minHeight: 2 }}
                  />
                  <span className="mt-1 truncate text-center text-[9px] text-muted-foreground">{entry.month.slice(2)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-3">
            <p className="panel-header -mx-3 -mt-3 mb-2">P/L distribution</p>
            <div className="space-y-1">
              {buckets.length === 0 ? <p className="text-2xs text-muted-foreground">No distribution available yet.</p> : null}
              {buckets.map((bucket) => (
                <div key={bucket.label} className="flex items-center gap-2 text-2xs">
                  <span className="w-24 shrink-0 text-muted-foreground">{bucket.label}</span>
                  <div className="h-2 flex-1 rounded bg-accent/50">
                    <div className="h-2 rounded bg-primary/60" style={{ width: `${(bucket.count / maxBucket) * 100}%` }} />
                  </div>
                  <span className="num w-8 text-right">{bucket.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel p-3">
            <p className="panel-header -mx-3 -mt-3 mb-2">Win / loss split</p>
            <div className="flex items-center gap-3">
              <WinLossDonut wins={winLoss.wins} losses={winLoss.losses} breakEven={winLoss.breakEven} />
              <dl className="space-y-1 text-2xs">
                <Row label="Wins" value={String(winLoss.wins)} tone="positive" />
                <Row label="Losses" value={String(winLoss.losses)} tone="negative" />
                <Row label="Break even" value={String(winLoss.breakEven)} />
                <Row label="Gross profit" value={formatMoney(summary.grossProfit ?? 0)} tone="positive" />
                <Row label="Gross loss" value={formatMoney(-(summary.grossLoss ?? 0))} tone="negative" />
                <Row label="Costs (comm + swap)" value={formatMoney((summary.totalCommission ?? 0) + (summary.totalSwap ?? 0))} />
              </dl>
            </div>
          </div>

          <div className="panel p-3 lg:col-span-2">
            <p className="panel-header -mx-3 -mt-3 mb-2">By instrument</p>
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="text-right">Trades</th>
                  <th className="text-right">Net P/L</th>
                  <th className="text-right">Win rate</th>
                </tr>
              </thead>
              <tbody>
                {bySymbol.map((row) => (
                  <tr key={row.symbol}>
                    <td className="font-medium">{row.symbol}</td>
                    <td className="num text-right">{row.trades}</td>
                    <td className={cn("num text-right", row.netProfit >= 0 ? "text-emerald-400" : "text-rose-400")}>{formatMoney(row.netProfit)}</td>
                    <td className="num text-right">{row.winRate != null ? formatPercent(row.winRate, 1) : "—"}</td>
                  </tr>
                ))}
                {bySymbol.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-2xs text-muted-foreground">No trades yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="rounded border border-panel-border bg-background/40 px-3 py-2 text-2xs text-muted-foreground">
        {summary.disclaimer ?? 'Simulated practice results are not real trading performance.'}
      </p>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("num", tone === "positive" && "text-emerald-400", tone === "negative" && "text-rose-400")}>{value}</dd>
    </div>
  );
}

function WinLossDonut({ wins, losses, breakEven }: { wins: number; losses: number; breakEven: number }): JSX.Element {
  const total = Math.max(1, wins + losses + breakEven);
  const winPct = (wins / total) * 100;
  const lossPct = (losses / total) * 100;
  return (
    <div
      className="relative h-24 w-24 shrink-0 rounded-full"
      style={{
        background: `conic-gradient(#22c55e 0 ${winPct}%, #ef4444 ${winPct}% ${winPct + lossPct}%, #64748b ${winPct + lossPct}% 100%)`,
      }}
      role="img"
      aria-label={`${wins} wins, ${losses} losses, ${breakEven} break even`}
    >
      <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full bg-panel">
        <span className="num text-sm font-semibold">{total === 1 && wins + losses + breakEven === 0 ? 0 : wins + losses + breakEven}</span>
        <span className="text-[9px] text-muted-foreground">trades</span>
      </div>
    </div>
  );
}
