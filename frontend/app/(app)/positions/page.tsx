"use client";

import { useTerminal } from '@/lib/terminal-context';
import { PositionsTable } from '@/components/terminal/positions-table';
import { EmergencyControls } from '@/components/terminal/emergency-controls';
import { ConnectionStatus } from '@/components/terminal/connection-status';
import { Badge } from '@/components/ui/badge';
import { formatMoney, formatNumber } from '@tradepilot/shared';

/** Positions — every open position with live P/L, modify and close actions. */
export default function PositionsPage(): JSX.Element {
  const { positions, account, mode, quotes } = useTerminal();
  const floating = positions.reduce((total, position) => total + position.profit, 0);
  const lots = positions.reduce((total, position) => total + position.volume, 0);

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-sm font-semibold">Open positions</h1>
          <p className="text-2xs text-muted-foreground">
            {positions.length} open · {formatNumber(lots, 2)} lots · floating P/L{' '}
            <span className={floating >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{formatMoney(floating)}</span>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={mode === 'DEMO' ? 'demo' : 'live'}>{mode === 'DEMO' ? 'DEMO' : 'LIVE'}</Badge>
          {account ? <span className="text-2xs text-muted-foreground">Equity {formatMoney(account.equity, account.currency)}</span> : null}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="panel overflow-hidden">
          <PositionsTable emptyMessage="No open positions. Open the XAU/USD terminal to place your first demo order." />
        </div>
        <div className="space-y-3">
          <ConnectionStatus />
          <EmergencyControls />
          <div className="panel p-3 text-2xs leading-relaxed text-muted-foreground">
            <p className="font-semibold text-foreground/90">Prices for open positions</p>
            <p className="mt-1">
              P/L on open positions is calculated by {mode === 'DEMO' ? 'the TradePilot demo broker' : 'your MT5 terminal'} from live
              bid/ask quotes.{' '}
              {mode === 'LIVE' ? 'When MT5 is disconnected the values shown are the last ones the terminal reported.' : ''}
            </p>
            <p className="mt-1">{Object.keys(quotes).length} symbols are currently streaming into this page.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
