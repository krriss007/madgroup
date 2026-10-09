'use client';

/**
 * PositionsTable — open positions with inline SL/TP modification and closing.
 *
 * Columns: Ticket, Symbol, Direction, Lots, Entry, Current, SL, TP, Swap,
 * Commission, P/L, P/L %. P/L % is the return on the margin the position uses.
 */

import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, PencilLine, X } from 'lucide-react';
import { formatDateTime, formatLots, formatMoney, formatNumber, formatPercent, formatPrice } from '@tradepilot/shared';
import type { Position } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface PositionsTableProps {
  positions?: Position[];
  compact?: boolean;
  showActions?: boolean;
  emptyMessage?: string;
}

export function PositionsTable({ positions, compact = false, showActions = true, emptyMessage }: PositionsTableProps): JSX.Element {
  const { positions: storePositions, mode, modifyPosition, closePosition, quotes } = useTerminal();
  const rows = positions ?? storePositions;

  const [editing, setEditing] = useState<Position | null>(null);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [closing, setClosing] = useState<Position | null>(null);
  const [busy, setBusy] = useState(false);

  const totals = rows.reduce(
    (acc, position) => ({
      volume: acc.volume + position.volume,
      profit: acc.profit + position.profit,
      swap: acc.swap + position.swap,
      commission: acc.commission + position.commission,
    }),
    { volume: 0, profit: 0, swap: 0, commission: 0 },
  );

  const startEdit = (position: Position): void => {
    setEditing(position);
    setStopLoss(position.stopLoss != null ? String(position.stopLoss) : '');
    setTakeProfit(position.takeProfit != null ? String(position.takeProfit) : '');
  };

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    try {
      await modifyPosition(editing.ticket, {
        stopLoss: stopLoss ? Number(stopLoss) : null,
        takeProfit: takeProfit ? Number(takeProfit) : null,
      });
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmClose = async (): Promise<void> => {
    if (!closing) return;
    setBusy(true);
    try {
      await closePosition(closing.ticket, { confirm: mode === 'LIVE' ? 'CLOSE' : 'CLOSE' });
      setClosing(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="panel flex min-h-0 flex-col">
        <div className="panel-header">
          <span>Positions</span>
          <span className="flex items-center gap-2 text-2xs">
            <span className="text-muted-foreground">{rows.length} open · {formatLots(totals.volume)} lots</span>
            <span className={cn('num font-semibold', totals.profit >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{formatMoney(totals.profit)}</span>
            {mode === 'DEMO' ? <Badge variant="demo">simulated</Badge> : <Badge variant="live">live</Badge>}
          </span>
        </div>

        <div className="min-h-0 overflow-auto">
          <table className="table-compact">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Symbol</th>
                <th>Direction</th>
                <th className="text-right">Lots</th>
                <th className="text-right">Entry</th>
                <th className="text-right">Current</th>
                <th className="text-right">SL</th>
                <th className="text-right">TP</th>
                {!compact ? (
                  <>
                    <th className="text-right">Swap</th>
                    <th className="text-right">Comm.</th>
                  </>
                ) : null}
                <th className="text-right">P/L</th>
                <th className="text-right">P/L %</th>
                {!compact ? <th>Opened</th> : null}
                {showActions ? <th className="text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((position) => {
                const digits = quotes[position.canonical]?.digits ?? 2;
                const positive = position.profit >= 0;
                return (
                  <tr key={position.id}>
                    <td className="num text-muted-foreground">#{position.ticket}</td>
                    <td className="font-medium">{position.canonical}</td>
                    <td>
                      <span className={cn('inline-flex items-center gap-1 font-semibold', position.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400')}>
                        {position.side === 'BUY' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        {position.side}
                      </span>
                    </td>
                    <td className="num text-right">{formatLots(position.volume)}</td>
                    <td className="num text-right">{formatPrice(position.openPrice, digits)}</td>
                    <td className="num text-right">{formatPrice(position.currentPrice, digits)}</td>
                    <td className="num text-right text-rose-300">{position.stopLoss != null ? formatPrice(position.stopLoss, digits) : '—'}</td>
                    <td className="num text-right text-emerald-300">{position.takeProfit != null ? formatPrice(position.takeProfit, digits) : '—'}</td>
                    {!compact ? (
                      <>
                        <td className="num text-right text-muted-foreground">{formatNumber(position.swap, 2)}</td>
                        <td className="num text-right text-muted-foreground">{formatNumber(position.commission, 2)}</td>
                      </>
                    ) : null}
                    <td className={cn('num text-right font-semibold', positive ? 'text-emerald-400' : 'text-rose-400')}>{formatMoney(position.profit)}</td>
                    <td className={cn('num text-right', positive ? 'text-emerald-400' : 'text-rose-400')}>{formatPercent(position.profitPercent, 2)}</td>
                    {!compact ? <td className="text-2xs text-muted-foreground">{formatDateTime(position.openTime)}</td> : null}
                    {showActions ? (
                      <td className="text-right">
                        <span className="inline-flex gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="xs" variant="ghost" onClick={() => startEdit(position)} aria-label={`Modify ${position.ticket}`}>
                                <PencilLine className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Modify Stop Loss / Take Profit</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button size="xs" variant="ghost" className="text-rose-300" onClick={() => setClosing(position)} aria-label={`Close ${position.ticket}`}>
                                <X className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Close position</TooltipContent>
                          </Tooltip>
                        </span>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={compact ? 8 : 13} className="py-6 text-center text-2xs text-muted-foreground">
                    {emptyMessage ?? 'No open positions.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {!compact && rows.length > 0 ? (
          <div className="flex items-center justify-between border-t border-panel-border px-2 py-1 text-2xs text-muted-foreground">
            <span>Swap {formatNumber(totals.swap, 2)} · Commission {formatNumber(totals.commission, 2)}</span>
            <span>
              Floating P/L <span className={cn('num font-semibold', totals.profit >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{formatMoney(totals.profit)}</span>
            </span>
          </div>
        ) : null}
      </div>

      {/* Modify SL/TP ---------------------------------------------------- */}
      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modify position #{editing?.ticket}</DialogTitle>
            <DialogDescription>
              {editing?.canonical} {editing?.side} {editing ? formatLots(editing.volume) : ''} lots · entry {editing ? formatPrice(editing.openPrice, 2) : ''}.
              Changes are validated against the broker&apos;s stops level before they are sent.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="modify-sl">Stop Loss</Label>
              <Input id="modify-sl" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} className="num" inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="modify-tp">Take Profit</Label>
              <Input id="modify-tp" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} className="num" inputMode="decimal" />
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

      {/* Close confirmation --------------------------------------------- */}
      <Dialog open={Boolean(closing)} onOpenChange={(open) => !open && setClosing(null)}>
        <DialogContent className={mode === 'LIVE' ? 'border-rose-500/50' : undefined}>
          <DialogHeader>
            <DialogTitle>Close position #{closing?.ticket}?</DialogTitle>
            <DialogDescription>
              {mode === 'LIVE'
                ? 'This will send a market close for a LIVE position and realise the profit or loss with your broker.'
                : 'This will close the simulated position at the current demo market price.'}
              {closing ? ` Floating P/L: ${formatMoney(closing.profit)}.` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClosing(null)} disabled={busy}>
              Keep position
            </Button>
            <Button variant="destructive" onClick={() => void confirmClose()} disabled={busy}>
              {mode === 'LIVE' ? 'Close live position' : 'Close demo position'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
