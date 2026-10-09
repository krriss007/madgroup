"use client";

import { useTerminal } from '@/lib/terminal-context';
import { HistoryTable } from '@/components/terminal/history-table';
import { Badge } from '@/components/ui/badge';

/** Trade history — closed trades with a full record of entry, exit, costs and result. */
export default function HistoryPage(): JSX.Element {
  const { mode } = useTerminal();

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-sm font-semibold">Trade history</h1>
          <p className="text-2xs text-muted-foreground">
            Every closed trade recorded for this account, with costs included. Export the current filter with the CSV button.
          </p>
        </div>
        <Badge variant={mode === 'DEMO' ? 'demo' : 'live'} className="ml-auto">
          {mode === 'DEMO' ? 'DEMO trades' : 'LIVE trades'}
        </Badge>
      </div>

      <div className="panel overflow-hidden">
        <HistoryTable limit={200} />
      </div>

      <p className="text-2xs text-muted-foreground">
        In DEMO mode these trades were executed by the TradePilot demo engine with simulated prices. They are practice results and are
        never presented as real trading performance.
      </p>
    </div>
  );
}
