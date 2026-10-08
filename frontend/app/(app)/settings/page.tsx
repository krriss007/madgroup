"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertOctagon, ArrowRight, Cable, Save, ShieldCheck, Settings as SettingsIcon, UserRound } from 'lucide-react';
import { formatDateTime, formatPercent } from '@tradepilot/shared';
import type { RiskSettings } from '@tradepilot/shared';
import { api, ApiError } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';
import { LIVE_ENABLE_ACKNOWLEDGEMENTS, RISK_PRESETS, DAILY_LOSS_PRESETS, MAX_POSITIONS_PRESETS } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ConnectionStatus } from '@/components/terminal/connection-status';

/** Settings — profile, environment/live gating, risk limits and MT5 connection. */
export default function SettingsPage(): JSX.Element {
  const { session, mode, setMode, liveTradingEnabled, enableLiveTrading, disableLiveTrading, pushToast, logout, connection, refresh } = useTerminal();
  const [displayName, setDisplayName] = useState(session?.user.displayName ?? "");
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingRisk, setSavingRisk] = useState(false);
  const [acknowledged, setAcknowledged] = useState<boolean[]>(() => LIVE_ENABLE_ACKNOWLEDGEMENTS.map(() => false));

  const loadRisk = useCallback(async () => {
    try {
      const response = await api.get<{ settings: RiskSettings }>('/settings/risk');
      setSettings(response.settings);
    } catch (error) {
      pushToast({ title: 'Could not load risk settings', message: (error as Error).message, level: 'error' });
    }
  }, [pushToast]);

  useEffect(() => {
    void loadRisk();
  }, [loadRisk]);

  useEffect(() => {
    setDisplayName(session?.user.displayName ?? "");
  }, [session?.user.displayName]);

  async function saveProfile(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSavingProfile(true);
    try {
      await api.patch('/settings/profile', { displayName: displayName.trim() });
      await refresh();
      pushToast({ title: 'Profile updated', level: 'success' });
    } catch (error) {
      pushToast({ title: 'Profile not saved', message: (error as Error).message, level: 'error' });
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveRisk(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!settings) return;
    setSavingRisk(true);
    try {
      const response = await api.put<{ settings: RiskSettings }>('/settings/risk', {
        maxRiskPerTradePercent: settings.maxRiskPerTradePercent,
        maxDailyLossPercent: settings.maxDailyLossPercent,
        maxOpenPositions: settings.maxOpenPositions,
        maxTotalExposureLots: settings.maxTotalExposureLots,
        maxLotSize: settings.maxLotSize,
        maxDailyTrades: settings.maxDailyTrades,
        maxConsecutiveLosses: settings.maxConsecutiveLosses,
        requireLiveConfirmation: settings.requireLiveConfirmation,
        maxSlippagePoints: settings.maxSlippagePoints,
        tradingHoursEnabled: settings.tradingHoursEnabled,
        tradingHours: settings.tradingHours,
        strategyEngineEnabled: settings.strategyEngineEnabled,
      });
      setSettings(response.settings);
      pushToast({ title: 'Risk settings saved', message: 'New limits apply to the next order.', level: 'success' });
    } catch (error) {
      pushToast({
        title: 'Risk settings not saved',
        message: error instanceof ApiError ? error.message : (error as Error).message,
        level: 'error',
      });
    } finally {
      setSavingRisk(false);
    }
  }

  async function changeMode(next: 'DEMO' | 'LIVE'): Promise<void> {
    if (next === mode) return;
    try {
      await setMode(next);
    } catch (error) {
      pushToast({ title: 'Could not switch environment', message: (error as Error).message, level: 'error' });
    }
  }

  const allAcknowledged = acknowledged.every(Boolean);

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="flex items-center gap-1.5 text-sm font-semibold">
            <SettingsIcon className="h-4 w-4" /> Settings
          </h1>
          <p className="text-2xs text-muted-foreground">Account, environment, risk limits and the MT5 bridge.</p>
        </div>
        <Badge variant={mode === 'DEMO' ? 'demo' : 'live'} className="ml-auto">
          {mode === 'DEMO' ? 'DEMO environment' : '🔴 LIVE environment'}
        </Badge>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {/* Profile */}
        <form onSubmit={saveProfile} className="panel space-y-2 p-3">
          <p className="panel-header -mx-3 -mt-3 mb-2">
            <span className="flex items-center gap-1.5">
              <UserRound className="h-3.5 w-3.5" /> Profile &amp; session
            </span>
          </p>
          <div className="space-y-1">
            <Label htmlFor="display-name">Display name</Label>
            <Input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="text-right">{session?.user.email ?? '—'}</dd>
            <dt className="text-muted-foreground">Member since</dt>
            <dd className="text-right">{session?.user.createdAt ? formatDateTime(session.user.createdAt) : '—'}</dd>
            <dt className="text-muted-foreground">Live trading enabled</dt>
            <dd className="text-right">
              {session?.user.liveTradingEnabled ? formatDateTime(session.user.liveTradingEnabledAt ?? null) : 'never'}
            </dd>
            <dt className="text-muted-foreground">Kill switch</dt>
            <dd className="text-right">{session?.killSwitchEngaged ? 'engaged' : 'not engaged'}</dd>
          </dl>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={savingProfile}>
              <Save className="h-3.5 w-3.5" /> Save profile
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </form>

        {/* Environment */}
        <div className="panel space-y-2 p-3">
          <p className="panel-header -mx-3 -mt-3 mb-2">
            <span className="flex items-center gap-1.5">
              <Cable className="h-3.5 w-3.5" /> Environment
            </span>
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant={mode === 'DEMO' ? 'default' : 'outline'} onClick={() => void changeMode('DEMO')}>
              DEMO / PAPER
            </Button>
            <Button size="sm" variant={mode === 'LIVE' ? 'buy' : 'outline'} onClick={() => void changeMode('LIVE')}>
              LIVE
            </Button>
            <span className="ml-auto text-2xs text-muted-foreground">
              {mode === 'DEMO' ? 'Simulated prices and balance — nothing at risk.' : 'Orders use real money through your MT5 broker account.'}
            </span>
          </div>

          <Separator />

          <div className="space-y-2 text-2xs">
            <p className="font-semibold text-foreground/90">Live trading gate</p>
            <ul className="space-y-0.5 text-muted-foreground">
              <li>{connection.status === 'CONNECTED' ? '✅' : '⛔'} MT5 terminal connected through the bridge</li>
              <li>{connection.mt5?.accountLogin ? '✅' : '⛔'} broker account authorised (login {connection.mt5?.accountLogin ?? 'unknown'})</li>
              <li>{connection.mt5?.tradeAllowed ? '✅' : '⛔'} trading allowed on that account</li>
              <li>{settings ? '✅' : '⛔'} risk limits configured</li>
              <li>{liveTradingEnabled ? '✅' : '⛔'} live trading explicitly enabled</li>
            </ul>

            {!liveTradingEnabled ? (
              <div className="space-y-1 rounded border border-rose-500/40 bg-rose-500/10 p-2">
                <p className="font-semibold text-rose-200">Enabling live trading</p>
                <ul className="space-y-1">
                  {LIVE_ENABLE_ACKNOWLEDGEMENTS.map((text, index) => (
                    <li key={text} className="flex items-start gap-1.5">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={acknowledged[index] ?? false}
                        onChange={(event) =>
                          setAcknowledged((current) => current.map((value, position) => (position === index ? event.target.checked : value)))
                        }
                      />
                      <span className="text-muted-foreground">{text}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!allAcknowledged}
                  onClick={async () => {
                    try {
                      await enableLiveTrading(true);
                      pushToast({ title: '🔴 LIVE TRADING ENABLED', message: 'Every live order will ask for confirmation first.', level: 'warning' });
                    } catch (error) {
                      pushToast({
                        title: 'Live trading not enabled',
                        message: error instanceof ApiError ? error.message : (error as Error).message,
                        level: 'error',
                      });
                    }
                  }}
                >
                  <AlertOctagon className="h-3.5 w-3.5" /> Enable live trading
                </Button>
              </div>
            ) : (
              <div className="space-y-1 rounded border border-rose-500/40 bg-rose-500/10 p-2">
                <p className="font-semibold text-rose-200">🔴 LIVE TRADING IS ENABLED</p>
                <p className="text-muted-foreground">
                  Live orders are sent to your broker. Every order shows a confirmation that says “THIS ORDER WILL USE REAL MONEY.” before it is
                  sent.
                </p>
                <Button size="sm" variant="outline" onClick={() => void disableLiveTrading('Disabled from settings')}>
                  Disable live trading
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Risk */}
        <form onSubmit={saveRisk} className="panel space-y-2 p-3 xl:col-span-2">
          <p className="panel-header -mx-3 -mt-3 mb-2">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> Risk limits
            </span>
            <span className="text-2xs font-normal text-muted-foreground">Enforced by the backend on every order, DEMO and LIVE</span>
          </p>

          {!settings ? (
            <p className="text-2xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="risk-per-trade">Max risk per trade (%)</Label>
                  <Input
                    id="risk-per-trade"
                    type="number"
                    step="0.1"
                    min={0.1}
                    max={10}
                    value={settings.maxRiskPerTradePercent}
                    onChange={(event) => setSettings({ ...settings, maxRiskPerTradePercent: Number(event.target.value) })}
                    className="num"
                  />
                  <div className="flex gap-1">
                    {RISK_PRESETS.map((preset) => (
                      <Button
                        key={preset}
                        type="button"
                        size="xs"
                        variant={settings.maxRiskPerTradePercent === preset ? 'default' : 'outline'}
                        onClick={() => setSettings({ ...settings, maxRiskPerTradePercent: preset })}
                      >
                        {preset}%
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="max-daily-loss">Max daily loss (%)</Label>
                  <Input
                    id="max-daily-loss"
                    type="number"
                    step="0.5"
                    min={0.5}
                    max={50}
                    value={settings.maxDailyLossPercent}
                    onChange={(event) => setSettings({ ...settings, maxDailyLossPercent: Number(event.target.value) })}
                    className="num"
                  />
                  <div className="flex gap-1">
                    {DAILY_LOSS_PRESETS.map((preset) => (
                      <Button
                        key={preset}
                        type="button"
                        size="xs"
                        variant={settings.maxDailyLossPercent === preset ? 'default' : 'outline'}
                        onClick={() => setSettings({ ...settings, maxDailyLossPercent: preset })}
                      >
                        {preset}%
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="max-positions">Max open positions</Label>
                  <Input
                    id="max-positions"
                    type="number"
                    min={1}
                    max={50}
                    value={settings.maxOpenPositions}
                    onChange={(event) => setSettings({ ...settings, maxOpenPositions: Number(event.target.value) })}
                    className="num"
                  />
                  <div className="flex gap-1">
                    {MAX_POSITIONS_PRESETS.map((preset) => (
                      <Button
                        key={preset}
                        type="button"
                        size="xs"
                        variant={settings.maxOpenPositions === preset ? 'default' : 'outline'}
                        onClick={() => setSettings({ ...settings, maxOpenPositions: preset })}
                      >
                        {preset}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="max-exposure">Max total exposure (lots)</Label>
                  <Input
                    id="max-exposure"
                    type="number"
                    step="0.1"
                    min={0.01}
                    value={settings.maxTotalExposureLots}
                    onChange={(event) => setSettings({ ...settings, maxTotalExposureLots: Number(event.target.value) })}
                    className="num"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="max-lot">Max lot size per order</Label>
                  <Input
                    id="max-lot"
                    type="number"
                    step="0.01"
                    min={0.01}
                    value={settings.maxLotSize}
                    onChange={(event) => setSettings({ ...settings, maxLotSize: Number(event.target.value) })}
                    className="num"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="max-daily-trades">Max trades per day (blank = unlimited)</Label>
                  <Input
                    id="max-daily-trades"
                    type="number"
                    min={1}
                    value={settings.maxDailyTrades ?? ''}
                    onChange={(event) =>
                      setSettings({ ...settings, maxDailyTrades: event.target.value === '' ? null : Number(event.target.value) })
                    }
                    className="num"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="max-consecutive-losses">Stop after N consecutive losses (0 = off)</Label>
                  <Input
                    id="max-consecutive-losses"
                    type="number"
                    min={0}
                    value={settings.maxConsecutiveLosses}
                    onChange={(event) => setSettings({ ...settings, maxConsecutiveLosses: Number(event.target.value) })}
                    className="num"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="max-slippage">Max slippage (points)</Label>
                  <Input
                    id="max-slippage"
                    type="number"
                    min={0}
                    value={settings.maxSlippagePoints}
                    onChange={(event) => setSettings({ ...settings, maxSlippagePoints: Number(event.target.value) })}
                    className="num"
                  />
                </div>
              </div>

              <Separator />

              <div className="grid gap-3 md:grid-cols-3">
                <label className="flex items-center justify-between gap-3 rounded border border-panel-border px-2 py-1.5 text-2xs">
                  <span>Require confirmation for every live order</span>
                  <Switch
                    checked={settings.requireLiveConfirmation}
                    onCheckedChange={(checked) => setSettings({ ...settings, requireLiveConfirmation: checked })}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 rounded border border-panel-border px-2 py-1.5 text-2xs">
                  <span>Restrict trading to configured hours</span>
                  <Switch
                    checked={settings.tradingHoursEnabled}
                    onCheckedChange={(checked) => setSettings({ ...settings, tradingHoursEnabled: checked })}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 rounded border border-panel-border px-2 py-1.5 text-2xs">
                  <span>Strategy engine (signals only, off by default)</span>
                  <Switch
                    checked={settings.strategyEngineEnabled}
                    onCheckedChange={(checked) => setSettings({ ...settings, strategyEngineEnabled: checked })}
                  />
                </label>
              </div>

              {settings.tradingHoursEnabled ? (
                <div className="space-y-1">
                  <Label>Trading hours (UTC)</Label>
                  <div className="flex flex-wrap gap-2">
                    {settings.tradingHours.map((window, index) => (
                      <div key={`${window.start}-${window.end}-${index}`} className="flex items-center gap-1">
                        <Input
                          value={window.start}
                          onChange={(event) => {
                            const next = [...settings.tradingHours];
                            next[index] = { ...next[index], start: event.target.value };
                            setSettings({ ...settings, tradingHours: next });
                          }}
                          className="num h-8 w-20"
                        />
                        <span className="text-2xs text-muted-foreground">→</span>
                        <Input
                          value={window.end}
                          onChange={(event) => {
                            const next = [...settings.tradingHours];
                            next[index] = { ...next[index], end: event.target.value };
                            setSettings({ ...settings, tradingHours: next });
                          }}
                          className="num h-8 w-20"
                        />
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => setSettings({ ...settings, tradingHours: settings.tradingHours.filter((_, position) => position !== index) })}
                        >
                          remove
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => setSettings({ ...settings, tradingHours: [...settings.tradingHours, { start: '07:00', end: '16:00' }] })}
                    >
                      Add window
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Windows are evaluated in UTC. Orders outside them are rejected with the reason “Trading hours window is closed.”
                  </p>
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={savingRisk}>
                  <Save className="h-3.5 w-3.5" /> Save risk settings
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void loadRisk()}>
                  Reset to saved
                </Button>
                <span className="text-2xs text-muted-foreground">
                  Current daily loss limit: {settings ? formatPercent(settings.maxDailyLossPercent, 1) : '—'} of balance ·{' '}
                  {settings ? formatPercent(settings.maxRiskPerTradePercent, 2) : '—'} risk per trade
                </span>
              </div>
            </>
          )}
        </form>

        {/* MT5 */}
        <div className="panel space-y-2 p-3 xl:col-span-2">
          <p className="panel-header -mx-3 -mt-3 mb-2">
            <span className="flex items-center gap-1.5">
              <Cable className="h-3.5 w-3.5" /> MT5 connection
            </span>
            <Link href="/settings/mt5" className="text-2xs font-normal text-primary hover:underline">
              open setup page <ArrowRight className="inline h-3 w-3" />
            </Link>
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <ConnectionStatus />
            <div className="space-y-1 text-2xs text-muted-foreground">
              <p className="font-semibold text-foreground/90">Credential policy</p>
              <p>
                TradePilot never requests, transmits or stores your MT5 password. The Expert Advisor runs inside the terminal you are already
                logged into and authenticates with a revocable device token.
              </p>
              <p>
                Without a connected EA the LIVE environment cannot place orders — they fail safely with “MT5 NOT AUTHORIZED” instead of being
                simulated.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
