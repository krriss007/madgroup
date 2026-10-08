"use client";

import { useTerminal } from '@/lib/terminal-context';
import { OrdersTable } from '@/components/terminal/orders-table';
import { EmergencyControls } from '@/components/terminal/emergency-controls';
import { ConnectionStatus } from '@/components/terminal/connection-status';
import { Badge } from '@/components/ui/badge';

/** Pending orders — limit, stop and stop-limit orders with modify and cancel actions. */
export default function OrdersPage(): JSX.Element {
  const { orders, mode } = useTerminal();

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-sm font-semibold">Pending orders</h1>
          <p className="text-2xs text-muted-foreground">
            {orders.length} resting order{orders.length === 1 ? '' : 's'} — they execute at your broker when price reaches the trigger.
          </p>
        </div>
        <Badge variant={mode === 'DEMO' ? 'demo' : 'live'} className="ml-auto">
          {mode === 'DEMO' ? 'DEMO' : 'LIVE'}
        </Badge>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="panel overflow-hidden">
          <OrdersTable />
        </div>
        <div className="space-y-3">
          <ConnectionStatus />
          <EmergencyControls />
        </div>
      </div>
    </div>
  );
}
