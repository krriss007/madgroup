"use client";

/**
 * OrdersTable — pending orders (BUY/SELL LIMIT, STOP, STOP LIMIT) with modify
 * and cancel actions. Live cancellations require an inline confirmation.
 */

import { useState } from 'react';
import { PencilLine, X } from 'lucide-react';
import { formatDateTime, formatLots, formatPrice, formatNumber } from '@tradepilot/shared';
import type { PendingOrder } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function OrdersTable({ orders, compact = false }: { orders?: PendingOrder[]; compact?: boolean }): JSX.Element {
  const { orders: storeOrders, mode, cancelOrder, refresh, pushToast, quotes } = useTerminal();
  const rows = orders ?? storeOrders;

  const [editing, setEditing] = useState<PendingOrder | null>(null);
  const [price, setPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<PendingOrder | null>(null);

  const startEdit = (order: PendingOrder): void => {
    setEditing(order);
    setPrice(String(order.price));
    setStopLoss(order.stopLoss != null ? String(order.stopLoss) : '');
    setTakeProfit(order.takeProfit != null ? String(order.takeProfit) : '');
  };

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.patch(`/trading/orders/${editing.ticket}`, {
        mode,
        price: price ? Number(price) : null,
        stopLoss: stopLoss ? Number(stopLoss) : null,
        takeProfit: takeProfit ? Number(takeProfit) : null,
        clientRequestId: `modify-order-${editing.ticket}-${Date.now()}`,
      });
      pushToast({ level: "success", title: `Order ${editing.ticket} modified` });
      setEditing(null);
      await refresh();
    } catch (error) {
      pushToast({ level: "error", title: "Modification rejected", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel flex min-h-0 flex-col">
        <div className="panel-header">
          <span>Pending Orders</span>
          <span className="flex items-center gap-2 text-2xs">
            <span className="text-muted-foreground">{rows.length} active</span>
            {mode === "DEMO" ? <Badge variant="demo">simulated</Badge> : <Badge variant="live">live</Badge>}
          </span>
        </div>
        <div className="min-h-0 overflow-auto">
          <table className="table-compact">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Symbol</th>
                <th>Type</th>
                <th className="text-right">Volume</th>
                <th className="text-right">Entry</th>
                <th className="text-right">SL</th>
                <th className="text-right">TP</th>
                {!compact ? <th>Expiration</th> : null}
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => {
                const digits = quotes[order.canonical]?.digits ?? 2;
                return (
                  <tr key={order.id}>
                    <td className="num text-muted-foreground">#{order.ticket}</td>
                    <td className="font-medium">{order.canonical}</td>
                    <td>
                      <span className={cn("font-semibold", order.side === "BUY" ? "text-emerald-400" : "text-rose-400")}>
                        {order.side} {order.type}
                      </span>
                    </td>
                    <td className="num text-right">{formatLots(order.volume)}</td>
                    <td className="num text-right">{formatPrice(order.price, digits)}</td>
                    <td className="num text-right text-rose-300">{order.stopLoss != null ? formatPrice(order.stopLoss, digits) : "—"}</td>
                    <td className="num text-right text-emerald-300">{order.takeProfit != null ? formatPrice(order.takeProfit, digits) : "—"}</td>
                    {!compact ? <td className="text-2xs text-muted-foreground">{order.expiration ? formatDateTime(order.expiration) : "GTC"}</td> : null}
                    <td>
                      <Badge variant="outline">{order.status}</Badge>
                    </td>
                    <td className="text-right">
                      <span className="inline-flex gap-1">
                        <Button size="xs" variant="ghost" onClick={() => startEdit(order)} aria-label={`Modify ${order.ticket}`}>
                          <PencilLine className="h-3 w-3" />
                        </Button>
                        <Button size="xs" variant="ghost" className="text-rose-300" onClick={() => setCancelling(order)} aria-label={`Cancel ${order.ticket}`}>
                          <X className="h-3 w-3" />
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={compact ? 9 : 10} className="py-6 text-center text-2xs text-muted-foreground">No pending orders.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modify pending order #{editing?.ticket}</DialogTitle>
            <DialogDescription>
              {editing?.canonical} {editing?.side} {editing?.type}. Prices are validated against the broker&apos;s stops level before being sent.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="order-price">Entry price</Label>
              <Input id="order-price" value={price} onChange={(event) => setPrice(event.target.value)} className="num" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="order-sl">Stop Loss</Label>
              <Input id="order-sl" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} className="num" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="order-tp">Take Profit</Label>
              <Input id="order-tp" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} className="num" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(cancelling)} onOpenChange={(open) => !open && setCancelling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel order #{cancelling?.ticket}?</DialogTitle>
            <DialogDescription>
              {mode === "LIVE"
                ? "The pending order will be deleted from your MT5 terminal. This cannot be undone."
                : "The simulated pending order will be removed from the demo account."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelling(null)}>
              Keep order
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (cancelling) void cancelOrder(cancelling.ticket);
                setCancelling(null);
              }}
            >
              Cancel order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
