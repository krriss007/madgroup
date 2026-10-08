"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Cable, Copy, Download, KeyRound, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { formatDateTime, relativeTime } from '@tradepilot/shared';
import type { Mt5Connection } from '@tradepilot/shared';
import { api, ApiError } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Mt5Overview {
  connections: Mt5Connection[];
  active: Mt5Connection | null;
  online: boolean;
  liveAccount: { login: string; server: string | null; currency: string; balance: number } | null;
  commandStats: Record<string, unknown>;
  heartbeatTimeoutMs: number;
  instructions: string[];
  warnings: string[];
  credentialsPolicy: string;
}

/** MT5 connection — the 10-step setup guide, device tokens and live status. */
export default function Mt5SetupPage(): JSX.Element {
  const { pushToast, connection, mode, liveTradingEnabled, refresh } = useTerminal();
  const [overview, setOverview] = useState<Mt5Overview | null>(null);
  const [deviceName, setDeviceName] = useState('Trading VPS');
  const [issuing, setIssuing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await api.get<Mt5Overview>('/settings/mt5');
      setOverview(response);
    } catch (error) {
      pushToast({ title: 'Could not load MT5 settings', message: (error as Error).message, level: 'error' });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function issue(): Promise<void> {
    setIssuing(true);
    try {
      const response = await api.post<{ token: string; deviceId: string; warning: string }>('/settings/mt5/devices', {
        deviceName: deviceName.trim() || null,
      });
      setToken(response.token);
      await load();
      pushToast({ title: 'Device token created', message: 'Copy it into the EA input — it will not be shown again.', level: 'success' });
    } catch (error) {
      pushToast({
        title: 'Token not created',
        message: error instanceof ApiError ? error.message : (error as Error).message,
        level: 'error',
      });
    } finally {
      setIssuing(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    try {
      await api.delete(`/settings/mt5/devices/${id}`);
      await load();
      pushToast({ title: 'Device revoked', level: 'success' });
    } catch (error) {
      pushToast({ title: 'Could not revoke the device', message: (error as Error).message, level: 'error' });
    }
  }

  const steps = [
    ...(overview?.instructions ?? []),
    'Confirm the connection card shows MT5 CONNECTED with your account login.',
    'Switch the environment to LIVE and enable live trading in Settings only when you are ready to use real money.',
  ].slice(0, 10);

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="xs" variant="ghost">
          <Link href="/settings">
            <ArrowLeft className="h-3.5 w-3.5" /> Settings
          </Link>
        </Button>
        <div>
          <h1 className="flex items-center gap-1.5 text-sm font-semibold">
            <Cable className="h-4 w-4 text-sky-400" /> MT5 connection setup
          </h1>
          <p className="text-2xs text-muted-foreground">
            TradePilot talks to your own MetaTrader 5 terminal through the TradePilotBridge Expert Advisor. No broker password is ever
            entered into this web app.
          </p>
        </div>
        <Badge variant={connection.status === 'CONNECTED' ? 'success' : 'destructive'} className="ml-auto">
          {connection.status === 'CONNECTED' ? 'MT5 CONNECTED' : 'MT5 DISCONNECTED'}
        </Badge>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="panel p-3">
          <p className="panel-header -mx-3 -mt-3 mb-3">Setup steps (10)</p>
          <ol className="space-y-2">
            {steps.map((step, index) => (
              <li key={step} className="flex gap-2 text-xs">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                  {index + 1}
                </span>
                <span className="text-muted-foreground">{step}</span>
              </li>
            ))}
          </ol>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="subtle">
              <a href="/mt5/TradePilotBridge.mq5" download>
                <Download className="h-3.5 w-3.5" /> Download TradePilotBridge.mq5
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href="/mt5/README.md" target="_blank" rel="noreferrer">
                EA source &amp; notes
              </a>
            </Button>
            <span className="text-2xs text-muted-foreground">
              The EA is plain MQL5 you can read and compile yourself — check <code>docs/MT5_EA_INSTALL.md</code> in the repository.
            </span>
          </div>

          <div className="mt-3 space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-2xs text-amber-200">
            <p className="flex items-center gap-1.5 font-semibold">
              <TriangleAlert className="h-3.5 w-3.5" /> Security essentials
            </p>
            {(overview?.warnings ?? [
              'Never enter your MT5 trading password anywhere in TradePilot — it is not requested and not stored.',
              'The EA only needs the device token; keep it secret, it is shown once.',
            ]).map((warning) => (
              <p key={warning}>• {warning}</p>
            ))}
            <p>• Use HTTPS between the EA and your backend in production, and keep the backend behind a firewall allow-listing your VPS.</p>
            <p>• Revoke a token immediately if a machine is compromised; the EA loses access on its next request.</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="panel p-3">
            <p className="panel-header -mx-3 -mt-3 mb-2">
              <span className="flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> Device tokens
              </span>
              <Button size="xs" variant="ghost" onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </p>

            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="device-name">Device name</Label>
                <Input id="device-name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
              </div>
              <Button size="sm" onClick={() => void issue()} disabled={issuing}>
                Generate token
              </Button>
            </div>

            <div className="mt-2 overflow-x-auto">
              <table className="table-compact">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Last heartbeat</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(overview?.connections ?? []).map((device) => (
                    <tr key={device.id}>
                      <td>
                        <span className="font-medium">{device.deviceName ?? 'unnamed'}</span>
                        <span className="ml-1 text-2xs text-muted-foreground">{device.tokenPrefix ?? ''}</span>
                      </td>
                      <td className="num text-2xs">{device.accountLogin ?? '—'}</td>
                      <td>
                        <Badge variant={device.status === 'CONNECTED' ? 'success' : device.revokedAt ? 'secondary' : 'outline'}>
                          {device.revokedAt ? 'revoked' : device.status}
                        </Badge>
                      </td>
                      <td className="text-2xs text-muted-foreground">{relativeTime(device.lastHeartbeat)}</td>
                      <td className="text-right">
                        {device.revokedAt ? null : (
                          <Button size="xs" variant="ghost" onClick={() => void revoke(device.id)} title="Revoke">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="py-4 text-center text-2xs text-muted-foreground">
                        Loading devices…
                      </td>
                    </tr>
                  ) : null}
                  {!loading && (overview?.connections ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-4 text-center text-2xs text-muted-foreground">
                        No device tokens yet. Generate one, then paste it into the EA&apos;s InpDeviceToken input.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel p-3 text-2xs">
            <p className="panel-header -mx-3 -mt-3 mb-2">Bridge status</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <dt className="text-muted-foreground">Environment</dt>
              <dd className="text-right">{mode}</dd>
              <dt className="text-muted-foreground">EA heartbeat age</dt>
              <dd className="text-right">{connection.lastHeartbeatAgeSeconds != null ? `${connection.lastHeartbeatAgeSeconds}s` : '—'}</dd>
              <dt className="text-muted-foreground">Account login</dt>
              <dd className="num text-right">{overview?.active?.accountLogin ?? '—'}</dd>
              <dt className="text-muted-foreground">Broker server</dt>
              <dd className="text-right">{overview?.active?.server ?? '—'}</dd>
              <dt className="text-muted-foreground">Terminal connected</dt>
              <dd className="text-right">{overview?.active?.terminalConnected ? 'yes' : 'no'}</dd>
              <dt className="text-muted-foreground">Algo trading</dt>
              <dd className="text-right">{overview?.active?.algoTradingEnabled ? 'enabled' : 'disabled'}</dd>
              <dt className="text-muted-foreground">Trading allowed</dt>
              <dd className="text-right">{overview?.active?.tradeAllowed ? 'yes' : 'no'}</dd>
              <dt className="text-muted-foreground">EA version</dt>
              <dd className="text-right">{overview?.active?.eaVersion ?? '—'}</dd>
              <dt className="text-muted-foreground">Heartbeat timeout</dt>
              <dd className="text-right">{overview?.heartbeatTimeoutMs ? `${overview.heartbeatTimeoutMs / 1000}s` : '—'}</dd>
              <dt className="text-muted-foreground">Live trading</dt>
              <dd className="text-right">{liveTradingEnabled ? '🔴 enabled' : 'disabled'}</dd>
              <dt className="text-muted-foreground">Live account</dt>
              <dd className="text-right">{overview?.liveAccount?.login ?? 'not linked'}</dd>
              <dt className="text-muted-foreground">Last checked</dt>
              <dd className="text-right">{formatDateTime(new Date().toISOString())}</dd>
            </dl>
            <Button size="xs" variant="outline" className="mt-2" onClick={() => void refresh()}>
              Refresh status
            </Button>
            {/simulat/i.test(overview?.active?.eaVersion ?? '') ? (
              <p className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-200">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  <strong className="font-semibold">TEST DOUBLE — NOT A BROKER.</strong> The connected EA reports
                  &ldquo;{overview?.active?.eaVersion}&rdquo;, i.e. the TradePilot bridge simulator. Every quote, balance and
                  trade result in this instance is synthetic and must never be treated as market data or performance.
                  Install TradePilotBridge.mq5 on your own MT5 terminal for real live data (see the install guide below).
                </span>
              </p>
            ) : null}
          </div>

          <div className="panel p-3 text-2xs leading-relaxed text-muted-foreground">
            <p className="flex items-center gap-1.5 font-semibold text-foreground/90">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> How the bridge authenticates
            </p>
            <p className="mt-1">
              The EA sends the device token with every request. The backend stores only a hash plus an encrypted copy and can revoke it at any
              time. Commands travelling back to the EA are signed with an HMAC using the shared secret, carry a unique command id, a nonce and a
              timestamp, and are rejected if they are replayed, stale, or for the wrong account.
            </p>
            <p className="mt-1">{overview?.credentialsPolicy ?? ''}</p>
          </div>
        </div>
      </div>

      <Dialog open={Boolean(token)} onOpenChange={(open) => (!open ? setToken(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Device token — shown once</DialogTitle>
            <DialogDescription>
              Paste this into the EA input <code>InpDeviceToken</code> and keep it secret. It is stored as a hash and an encrypted copy; the
              plain token cannot be retrieved later.
            </DialogDescription>
          </DialogHeader>
          <pre className="num overflow-x-auto rounded border border-panel-border bg-background/60 p-3 text-2xs">{token}</pre>
          <DialogFooter>
            <Button
              size="sm"
              variant="subtle"
              onClick={() => {
                if (token) void navigator.clipboard.writeText(token);
              }}
            >
              <Copy className="h-3.5 w-3.5" /> Copy token
            </Button>
            <Button size="sm" onClick={() => setToken(null)}>
              I have saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
