"use client";

/**
 * HistoryTable — closed trades with the range filters required by the spec
 * (Today / Yesterday / 7 Days / 30 Days / Custom) and CSV export.
 */

import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { formatDateTime, formatDuration, formatLots, formatMoney, formatPercent, formatPrice } from '@tradepilot/shared';
import type { TradeRecord } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | 'custom' | 'all';

const RANGES: { id: RangeKey; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: '7 Days' },
  { id: '30d', label: '30 Days' },
  { id: 'custom', label: 'Custom' },
  { id: 'all', label: 'All' },
];

interface HistoryResponse {
  trades: TradeRecord[];
  total: number;
  summary: { trades: number; netProfit: number; commission: number; swap: number; wins: number; losses: number; volume: number; winRate: number | null };
  range: { from: string | null; to: string | null; label: RangeKey };
}

export function HistoryTable({ limit = 100 }: { limit?: number }): JSX.Element {
  const { mode, positions } = useTerminal();
  const [range, setRange] = useState<RangeKey>('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.get<HistoryResponse>('/history', {
        mode,
        range,
        from: range === 'custom' && from ? new Date(from).toISOString() : undefined,
        to: range === 'custom' && to ? new Date(to).toISOString() : undefined,
        limit,
      });
      setData(response);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [from, limit, mode, range, to]);

  useEffect(() => {
    void load();
  }, [load, positions.length]);

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="panel-header flex-wrap gap-2">
        <span>Trade History</span>
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setRange(option.id)}
              className={cn(
                "rounded border px-1.5 py-0.5 text-2xs font-semibold",
                range === option.id ? "border-primary/50 bg-primary/15 text-primary" : "border-panel-border text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
          <Button size="xs" variant="ghost" onClick={() => void load()} aria-label="Refresh history">
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </Button>
          <a
            href={`/api/v1/history/export.csv?mode=${mode}&range=${range}`}
            className="inline-flex items-center gap-1 rounded border border-panel-border px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-foreground"
          >
            <Download className="h-3 w-3" /> CSV
          </a>
        </div>
      </div>

      {range === "custom" ? (
        <div className="flex flex-wrap items-end gap-2 border-b border-panel-border px-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="history-from">From</Label>
            <Input id="history-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-7 text-xs" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-to">To</Label>
            <Input id="history-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-7 text-xs" />
          </div>
          <Button size="sm" onClick={() => void load()}>
            Apply
          </Button>
        </div>
      ) : null}

      {error ? <p className="px-3 py-2 text-2xs text-rose-300">{error}</p> : null}

      <div className="min-h-0 overflow-auto">
        <table className="table-compact">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Date</th>
              <th>Symbol</th>
              <th>Direction</th>
              <th className="text-right">Volume</th>
              <th className="text-right">Entry</th>
              <th className="text-right">Exit</th>
              <th className="text-right">SL</th>
              <th className="text-right">TP</th>
              <th className="text-right">Commission</th>
              <th className="text-right">Swap</th>
              <th className="text-right">Net P/L</th>
              <th>Duration</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {(data?.trades ?? []).map((trade) => (
              <tr key={trade.id}>
                <td className="num text-muted-foreground">#{trade.ticket}</td>
                <td className="text-2xs text-muted-foreground">{formatDateTime(trade.closeTime)}</td>
                <td className="font-medium">{trade.canonical}</td>
                <td className={cn("font-semibold", trade.side === "BUY" ? "text-emerald-400" : "text-rose-400")}>{trade.side}</td>
                <td className="num text-right">{formatLots(trade.volume)}</td>
                <td className="num text-right">{formatPrice(trade.entryPrice, 2)}</td>
                <td className="num text-right">{formatPrice(trade.exitPrice, 2)}</td>
                <td className="num text-right text-rose-300">{trade.stopLoss != null ? formatPrice(trade.stopLoss, 2) : "—"}</td>
                <td className="num text-right text-emerald-300">{trade.takeProfit != null ? formatPrice(trade.takeProfit, 2) : "—"}</td>
                <td className="num text-right text-muted-foreground">{formatMoney(trade.commission)}</td>
                <td className="num text-right text-muted-foreground">{formatMoney(trade.swap)}</td>
                <td className={cn("num text-right font-semibold", trade.netProfit >= 0 ? "text-emerald-400" : "text-rose-400")}>{formatMoney(trade.netProfit)}</td>
                <td className="text-2xs text-muted-foreground">{formatDuration(trade.durationSeconds)}</td>
                <td>{trade.source === "MT5" ? <Badge variant="success">MT5</Badge> : <Badge variant="demo">demo</Badge>}</td>
              </tr>
            ))}
            {(data?.trades ?? []).length === 0 ? (
              <tr>
                <td colSpan={14} className="py-8 text-center text-2xs text-muted-foreground">
                  No closed trades in this period. History fills in automatically when positions are closed.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {data ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-panel-border px-3 py-1.5 text-2xs text-muted-foreground">
          <span>{data.summary.trades} trades</span>
          <span>{data.summary.volume.toFixed(2)} lots</span>
          <span>
            Net <span className={cn("num font-semibold", data.summary.netProfit >= 0 ? "text-emerald-400" : "text-rose-400")}>{formatMoney(data.summary.netProfit)}</span>
          </span>
          <span>Wins {data.summary.wins} · Losses {data.summary.losses}</span>
          <span>Win rate {data.summary.winRate != null ? formatPercent(data.summary.winRate, 1) : "—"}</span>
          <span className="ml-auto">Commission {formatMoney(data.summary.commission)} · Swap {formatMoney(data.summary.swap)}</span>
        </div>
      ) : null}
    </div>
  );
}
