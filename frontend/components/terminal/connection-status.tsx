"use client";

import { Activity, AlertTriangle, ShieldCheck, WifiOff } from 'lucide-react';
import { relativeTime } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function ConnectionStatus({ compact = false }: { compact?: boolean }): JSX.Element {
  const { connection, mode, liveTradingEnabled } = useTerminal();
  const online = connection.status === 'CONNECTED';
  // The bridge test double identifies itself in the EA version it reports. When
  // that marker is present every price on screen is synthetic and must never be
  // read as market data — say so, loudly, instead of letting it look like a
  // broker connection. A real EA reports a normal version and shows no banner.
  const syntheticFeed = /simulat/i.test(connection.mt5?.eaVersion ?? '');

  return (
    <div className={cn('panel p-3', !online && mode === 'LIVE' && 'border-rose-500/40 bg-rose-950/20')}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
          {online ? <Activity className="h-3.5 w-3.5 text-emerald-400" /> : <WifiOff className="h-3.5 w-3.5 text-rose-400" />}
          {online ? 'MT5 CONNECTED' : 'MT5 DISCONNECTED'}
        </span>
        {mode === 'DEMO' ? (
          <Badge variant="demo">demo mode active</Badge>
        ) : liveTradingEnabled ? (
          <Badge variant="live">🔴 live trading</Badge>
        ) : (
          <Badge variant="outline">
            <ShieldCheck className="h-3 w-3" /> live locked
          </Badge>
        )}
      </div>

      {!compact ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs">
          <Row label="Account" value={connection.mt5?.accountLogin ?? '—'} />
          <Row label="Server" value={connection.mt5?.server ?? '—'} />
          <Row label="Latency" value={connection.mt5?.latencyMs != null ? `${connection.mt5.latencyMs} ms` : '—'} />
          <Row label="Last update" value={relativeTime(connection.mt5?.lastHeartbeat ?? null)} />
          <Row label="EA version" value={connection.mt5?.eaVersion ?? '—'} />
          <Row label="Terminal build" value={connection.mt5?.terminalBuild ?? '—'} />
          <Row label="Algo trading" value={connection.mt5?.algoTradingEnabled ? 'enabled' : 'disabled'} />
          <Row label="Trading allowed" value={connection.mt5?.tradeAllowed ? 'yes' : 'no'} />
        </dl>
      ) : null}

      {online && syntheticFeed ? (
        <p className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-2xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            <strong className="font-semibold">TEST DOUBLE — NOT A BROKER.</strong> This connection is the TradePilot
            bridge simulator; every price, balance and result shown comes from a synthetic feed. It exists to prove the
            LIVE plumbing works. Real live data requires your own MT5 terminal with TradePilotBridge.mq5 attached.
          </span>
        </p>
      ) : null}

      {!online ? (
        <p className="mt-2 flex items-start gap-1.5 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-2xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {mode === 'LIVE'
              ? 'MT5 is offline. Live prices are unavailable and live order buttons are disabled.'
              : 'No MT5 terminal connected. Demo trading works normally with simulated prices.'}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num truncate text-right text-foreground">{value}</dd>
    </>
  );
}
