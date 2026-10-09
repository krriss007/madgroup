"use client";

import { useTerminal } from '@/lib/terminal-context';
import { useAnalytics } from '@/hooks/use-analytics';
import { AnalyticsPanels } from '@/components/dashboard/analytics-panels';
import { AccountEquityChart } from '@/components/dashboard/account-equity-chart';
import { AccountStats } from '@/components/dashboard/account-stats';
import { Badge } from '@/components/ui/badge';

/** Analytics — equity curve, daily/monthly P/L, distribution and win/loss split. */
export default function AnalyticsPage(): JSX.Element {
  const { mode } = useTerminal();
  const { summary, series, headline, loading, error } = useAnalytics();

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-sm font-semibold">Portfolio analytics</h1>
          <p className="text-2xs text-muted-foreground">
            Calculated from the trades and account snapshots recorded for this {mode === 'DEMO' ? 'demo' : 'live'} account.
          </p>
        </div>
        <Badge variant={mode === 'DEMO' ? 'demo' : 'live'} className="ml-auto">
          {mode === 'DEMO' ? 'DEMO — practice results' : 'LIVE account'}
        </Badge>
      </div>

      <AccountStats headline={headline} />

      <div className="panel p-3">
        <p className="panel-header -mx-3 -mt-3 mb-2">Equity curve</p>
        <AccountEquityChart points={series} height={280} />
      </div>

      {error ? <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-2xs text-rose-200">{error}</p> : null}

      <AnalyticsPanels summary={summary} loading={loading} />
    </div>
  );
}
