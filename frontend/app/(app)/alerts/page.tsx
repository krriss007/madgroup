"use client";

import { useCallback, useEffect, useState } from 'react';
import { BellRing, Plus, Trash2 } from 'lucide-react';
import { formatDateTime, formatPrice } from '@tradepilot/shared';
import type { PriceAlert } from '@tradepilot/shared';
import { api, ApiError } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';
import { useSymbols } from '@/hooks/use-symbols';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Price Alerts — server-side alerts that fire from the live quote stream. */
export default function AlertsPage(): JSX.Element {
  const { pushToast, quotes, refresh, notifications } = useTerminal();
  const { symbols } = useSymbols();
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [symbol, setSymbol] = useState('XAUUSD');
  const [condition, setCondition] = useState<'ABOVE' | 'BELOW'>('ABOVE');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get<{ alerts: PriceAlert[] }>('/alerts');
      setAlerts(response.alerts);
    } catch (error) {
      pushToast({ title: 'Could not load alerts', message: (error as Error).message, level: 'error' });
    }
  }, [pushToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/alerts', {
        symbol: symbol.trim().toUpperCase(),
        condition,
        price: Number(price),
        note: note.trim() || null,
      });
      setPrice('');
      setNote('');
      await load();
      pushToast({ title: 'Alert created', level: 'success' });
    } catch (error) {
      pushToast({
        title: 'Alert not created',
        message: error instanceof ApiError ? error.message : (error as Error).message,
        level: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api.delete(`/alerts/${id}`);
      setAlerts((current) => current.filter((alert) => alert.id !== id));
    } catch (error) {
      pushToast({ title: 'Could not delete the alert', message: (error as Error).message, level: 'error' });
    }
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="flex items-center gap-1.5 text-sm font-semibold">
            <BellRing className="h-4 w-4 text-amber-400" /> Price alerts
          </h1>
          <p className="text-2xs text-muted-foreground">
            Alerts are evaluated by the backend against streaming quotes and raise a notification plus a toast when they trigger.
          </p>
        </div>
        <Button size="sm" variant="subtle" className="ml-auto" onClick={() => void refresh()}>
          Refresh quotes
        </Button>
      </div>

      <div className="grid gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
        <form onSubmit={create} className="panel space-y-2 p-3">
          <p className="panel-header -mx-3 -mt-3 mb-2">
            <span className="flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> New alert
            </span>
          </p>
          <div className="space-y-1">
            <Label>Symbol</Label>
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(symbols.length ? symbols.map((entry) => entry.canonical) : ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY']).map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Condition</Label>
              <Select value={condition} onValueChange={(value) => setCondition(value as 'ABOVE' | 'BELOW')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ABOVE">Price above</SelectItem>
                  <SelectItem value="BELOW">Price below</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="alert-price">Price</Label>
              <Input
                id="alert-price"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                required
                inputMode="decimal"
                className="num"
                placeholder={quotes[symbol] ? formatPrice(quotes[symbol].ask, quotes[symbol].digits) : '0.00'}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="alert-note">Note (optional)</Label>
            <Input id="alert-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            <Plus className="h-4 w-4" /> Create alert
          </Button>
          <p className="text-[10px] text-muted-foreground">
            Alerts use the same quote stream the terminal displays. In LIVE mode an alert cannot evaluate while MT5 is offline — it simply
            stays armed until the stream returns, and it never invents a price to fire on.
          </p>
        </form>

        <div className="space-y-2">
          <div className="panel overflow-hidden">
            <div className="panel-header">
              Price alerts <span className="text-2xs font-normal text-muted-foreground">{alerts.filter((alert) => !alert.triggered).length} armed</span>
            </div>
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Condition</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Current</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => {
                  const quote = quotes[alert.canonical] ?? null;
                  return (
                    <tr key={alert.id}>
                      <td className="font-medium">{alert.symbol}</td>
                      <td className="text-muted-foreground">{alert.condition === 'ABOVE' ? 'above' : 'below'}</td>
                      <td className="num text-right">{formatPrice(alert.price, quote?.digits ?? 2)}</td>
                      <td className={cn('num text-right', quote ? '' : 'text-muted-foreground')}>
                        {quote ? formatPrice(quote.bid, quote.digits) : '—'}
                      </td>
                      <td>
                        <Badge variant={alert.triggered ? 'success' : 'outline'}>
                          {alert.triggered ? `triggered ${formatDateTime(alert.triggeredAt)}` : 'armed'}
                        </Badge>
                      </td>
                      <td className="text-2xs text-muted-foreground">{formatDateTime(alert.createdAt)}</td>
                      <td className="text-right">
                        <Button size="xs" variant="ghost" onClick={() => void remove(alert.id)} title="Delete alert">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {alerts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-2xs text-muted-foreground">
                      No alerts yet. Alerts you create here are stored on the server, so they survive a page reload.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="panel overflow-hidden">
            <div className="panel-header">Recent notifications</div>
            <ul className="divide-y divide-panel-border">
              {notifications.slice(0, 8).map((notification) => (
                <li key={notification.id} className="flex items-start gap-2 px-3 py-2 text-2xs">
                  <Badge
                    variant={
                      notification.level === 'warning' ? 'warning' : notification.level === 'critical' ? 'destructive' : notification.level === 'success' ? 'success' : 'outline'
                    }
                  >
                    {notification.level}
                  </Badge>
                  <div>
                    <p className="font-medium text-foreground/90">{notification.title}</p>
                    <p className="text-muted-foreground">{notification.message}</p>
                  </div>
                  <span className="ml-auto whitespace-nowrap text-[10px] text-muted-foreground">{formatDateTime(notification.createdAt)}</span>
                </li>
              ))}
              {notifications.length === 0 ? <li className="px-3 py-4 text-center text-2xs text-muted-foreground">Nothing yet.</li> : null}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
