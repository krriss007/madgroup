"use client";

import Link from 'next/link';
import { Activity, ArrowRight, Coins, ShieldAlert } from 'lucide-react';
import { formatMoney, formatNumber, formatPercent, formatPrice } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { useAnalytics } from '@/hooks/use-analytics';
import { useSymbols } from '@/hooks/use-symbols';
import { useRiskProfile } from '@/hooks/use-risk-profile';
import { AccountStats } from '@/components/dashboard/account-stats';
import { TickerTape } from '@/components/dashboard/ticker-tape';
import { AccountEquityChart } from '@/components/dashboard/account-equity-chart';
import { AnalyticsPanels } from '@/components/dashboard/analytics-panels';
import { MarketWatch } from '@/components/terminal/market-watch';
import { ConnectionStatus } from '@/components/terminal/connection-status';
import { PositionsTable } from '@/components/terminal/positions-table';
import { OrdersTable } from '@/components/terminal/orders-table';
import { EmergencyControls } from '@/components/terminal/emergency-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function DashboardPage(): JSX.Element {
  const { account, mode, liveTradingEnabled, positions, orders, quotes } = useTerminal();
  const { summary, series, headline, loading } = useAnalytics();
  const { symbols } = useSymbols();
  const { risk, settings } = useRiskProfile();
  const gold = symbols.find((entry) => entry.canonical === 'XAUUSD') ?? null;
  const goldQuote = quotes.XAUUSD ?? null;

  const dailyLoss = risk?.dailyRealizedLoss ?? null;
  const lossLimitAmount = risk?.dailyLossLimitAmount ?? null;
  const locked = risk?.locked ?? false;
  const lossUsagePercent = lossLimitAmount && lossLimitAmount > 0 ? (Math.max(0, dailyLoss ?? 0) / lossLimitAmount) * 100 : 0;

  return (
    <div className="flex flex-col">
      <TickerTape />
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <h1 className="text-sm font-semibold">Trading desk</h1>
            <p className="text-2xs text-muted-foreground">
              {mode === 'DEMO'
                ? 'Demo environment with simulated prices and a simulated balance — no real money is ever at risk here.'
                : 'Live environment — orders are sent to your own broker account through the MT5 bridge.'}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Badge variant={mode === 'DEMO' ? 'demo' : 'live'}>{mode === 'DEMO' ? 'DEMO / PAPER' : '🔴 LIVE TRADING'}</Badge>
            {mode === 'LIVE' && !liveTradingEnabled ? <Badge variant="warning">live disabled</Badge> : null}
            <Button asChild size="sm" variant="subtle">
              <Link href="/markets/xauusd">
                <Coins className="h-3.5 w-3.5" /> Open XAU/USD terminal
              </Link>
            </Button>
          </div>
        </div>

        <AccountStats headline={headline} />

        {locked ? (
          <p className="flex items-center gap-2 rounded border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-200">
            <ShieldAlert className="h-3.5 w-3.5" /> DAILY LOSS LIMIT REACHED — TRADING LOCKED
          </p>
        ) : null}

        {dailyLoss != null && lossLimitAmount != null && !locked ? (
          <div className="panel p-2.5">
            <div className="flex items-center justify-between text-2xs">
              <span className="uppercase tracking-wide text-muted-foreground">Daily loss usage</span>
              <span className="num">
                {formatMoney(dailyLoss)} / {formatMoney(lossLimitAmount)} limit
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full rounded bg-accent/60">
              <div
                className={cn('h-1.5 rounded', lossUsagePercent > 70 ? 'bg-rose-500' : 'bg-emerald-500')}
                style={{ width: `${Math.min(100, Math.max(2, lossUsagePercent))}%` }}
              />
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="panel">
              <div className="panel-header -mx-3 -mt-3 mb-2">
                <span className="flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5" /> Equity & balance
                </span>
                <span className="text-2xs font-normal text-muted-foreground">
                  {mode === 'DEMO' ? 'Demo account history' : 'Live account history'}
                </span>
              </div>
              <AccountEquityChart points={series} />
            </div>

            <div className="panel">
              <div className="panel-header -mx-3 -mt-3 mb-2">
                Open positions
                <Link href="/positions" className="text-2xs font-normal text-primary hover:underline">
                  view all <ArrowRight className="inline h-3 w-3" />
                </Link>
              </div>
              <PositionsTable positions={positions.slice(0, 5)} compact emptyMessage="No open positions right now." />
            </div>

            <div className="panel">
              <div className="panel-header -mx-3 -mt-3 mb-2">
                Pending orders
                <Link href="/orders" className="text-2xs font-normal text-primary hover:underline">
                  view all <ArrowRight className="inline h-3 w-3" />
                </Link>
              </div>
              <OrdersTable orders={orders.slice(0, 5)} compact />
            </div>

            <div className="panel p-3">
              <p className="panel-header -mx-3 -mt-3 mb-2">Performance analytics</p>
              <AnalyticsPanels summary={summary} loading={loading} />
            </div>
          </div>

          <div className="space-y-3">
            <ConnectionStatus />
            <EmergencyControls />

            <div className="panel">
              <div className="panel-header -mx-3 -mt-3 mb-2">
                Watchlist
                <Link href="/watchlist" className="text-2xs font-normal text-primary hover:underline">
                  manage <ArrowRight className="inline h-3 w-3" />
                </Link>
              </div>
              <MarketWatch compact showFilter={false} onSelect={(symbol) => (window.location.href = `/markets/${symbol.toLowerCase()}`)} />
            </div>

            {gold ? (
              <div className="panel p-3">
                <p className="panel-header -mx-3 -mt-3 mb-2">XAU/USD focus</p>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
                  <dt className="text-muted-foreground">Contract size</dt>
                  <dd className="num text-right">{formatNumber(gold.spec.contractSize, 0)}</dd>
                  <dt className="text-muted-foreground">Tick size / value</dt>
                  <dd className="num text-right">
                    {formatNumber(gold.spec.tickSize, 5)} / {formatNumber(gold.spec.tickValueLoss, 4)}
                  </dd>
                  <dt className="text-muted-foreground">Volume min / step</dt>
                  <dd className="num text-right">
                    {gold.spec.volumeMin} / {gold.spec.volumeStep}
                  </dd>
                  <dt className="text-muted-foreground">Stops level</dt>
                  <dd className="num text-right">{gold.spec.stopsLevel} pts</dd>
                  <dt className="text-muted-foreground">Spread (current)</dt>
                  <dd className="num text-right">
                    {goldQuote ? `${formatPrice(goldQuote.ask - goldQuote.bid, goldQuote.digits)} (${formatNumber(goldQuote.spreadPoints, 1)} pts)` : '—'}
                  </dd>
                </dl>
                <Button asChild size="sm" variant="subtle" className="mt-2 w-full">
                  <Link href="/markets/xauusd">
                    Trade XAU/USD <ArrowRight className="h-3 w-3" />
                  </Link>
                </Button>
              </div>
            ) : null}

            <div className="panel p-3 text-2xs leading-relaxed text-muted-foreground">
              <p className="font-semibold text-foreground/90">Risk settings in force</p>
              <ul className="mt-1 space-y-0.5">
                <li>Max risk per trade: {settings ? formatPercent(settings.maxRiskPerTradePercent, 2) : '—'}</li>
                <li>Max daily loss: {settings ? formatPercent(settings.maxDailyLossPercent, 1) : '—'}</li>
                <li>Max open positions: {settings?.maxOpenPositions ?? '—'}</li>
                <li>Max lot size: {settings?.maxLotSize ?? '—'}</li>
              </ul>
              <Link href="/settings" className="mt-1 inline-block text-primary hover:underline">
                Adjust in Settings
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
