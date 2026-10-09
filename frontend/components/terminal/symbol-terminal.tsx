"use client";

/**
 * SymbolTerminal — the full trading screen for one instrument:
 *   left   → market watch (symbols + bid/ask/spread/change/high/low)
 *   center → candlestick/line/area chart with timeframes and indicators
 *   right  → order panel (BUY/SELL, market/pending, SL/TP, risk, lot sizing)
 *   bottom → open positions, pending orders and trade history
 *
 * XAUUSD is the primary instrument, but the layout works for any symbol the
 * broker provides (including broker-specific name variants such as XAUUSDm).
 */

import { useMemo, useState } from 'react';
import { CandlestickChart, Coins, LineChart, Star, TriangleAlert } from 'lucide-react';
import { formatPrice, type IndicatorConfig, type Timeframe } from '@tradepilot/shared';
import { useCandles } from '@/hooks/use-candles';
import { findSymbol, useSymbols } from '@/hooks/use-symbols';
import { useTerminal } from '@/lib/terminal-context';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarketWatch } from '@/components/terminal/market-watch';
import { TradingChart } from '@/components/terminal/trading-chart';
import { OrderPanel } from '@/components/terminal/order-panel';
import { InstrumentPanel } from '@/components/terminal/instrument-panel';
import { PositionsTable } from '@/components/terminal/positions-table';
import { OrdersTable } from '@/components/terminal/orders-table';
import { HistoryTable } from '@/components/terminal/history-table';

type ChartType = 'candlestick' | 'line' | 'area';

const INITIAL_INDICATORS: IndicatorConfig = {
  ema: [9, 21, 50],
  rsi: { enabled: true, period: 14 },
  macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
  stochastic: { enabled: false, k: 14, d: 3 },
  bollinger: { enabled: false, period: 20, deviation: 2 },
  atr: { enabled: false, period: 14 },
};

export interface SymbolTerminalProps {
  /** Requested symbol, e.g. XAUUSD or a broker variant such as XAUUSDm */
  requested: string;
  /** Symbols to show in the left market watch (defaults to the watchlist) */
  watchSymbols?: string[];
  className?: string;
}

export function SymbolTerminal({ requested, watchSymbols, className }: SymbolTerminalProps): JSX.Element {
  const { quotes, positions, orders, mode, connection, watchlist, addToWatchlist, removeFromWatchlist } = useTerminal();
  const { symbols } = useSymbols();
  const [timeframe, setTimeframe] = useState<Timeframe>('M15');
  const [chartType, setChartType] = useState<ChartType>('candlestick');
  const [indicators, setIndicators] = useState<IndicatorConfig>(INITIAL_INDICATORS);
  const [showVolume, setShowVolume] = useState(true);

  const entry = useMemo(() => findSymbol(symbols, requested), [requested, symbols]);
  const canonical = entry?.canonical ?? requested.toUpperCase();
  const displaySymbol = entry?.symbol ?? canonical;
  const quote = quotes[canonical] ?? quotes[displaySymbol] ?? null;
  const spec = entry?.spec ?? null;

  const { candles, source, atr, loading, error } = useCandles(canonical, timeframe);
  const online = mode === 'DEMO' || connection.status === 'CONNECTED';

  const symbolPositions = useMemo(
    () => positions.filter((position) => position.canonical === canonical || position.symbol === displaySymbol),
    [canonical, displaySymbol, positions],
  );
  const symbolOrders = useMemo(
    () => orders.filter((order) => order.canonical === canonical || order.symbol === displaySymbol),
    [canonical, displaySymbol, orders],
  );

  const inWatchlist = watchlist.includes(canonical) || watchlist.includes(displaySymbol);

  return (
    <div className={cn('flex min-h-0 flex-col gap-2 p-2', className)}>
      <InstrumentPanel symbol={displaySymbol} quote={quote} spec={spec} atr={atr} />

      <div className="grid min-h-0 gap-2 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
        <div className="hidden min-h-0 flex-col gap-2 xl:flex">
          <MarketWatch
            symbols={watchSymbols}
            selected={canonical}
            onSelect={(next) => {
              if (next === canonical) return;
              window.location.href = `/markets/${next.toLowerCase()}`;
            }}
            className="min-h-0 flex-1"
          />
          <div className="panel p-2 text-[10px] leading-relaxed text-muted-foreground">
            <p className="flex items-center gap-1 font-semibold text-foreground/90">
              <Coins className="h-3 w-3 text-amber-400" /> Instrument notes
            </p>
            <p className="mt-1">
              Contract specifications (contract size, tick value, volume grid, stops level) are read from{' '}
              {spec?.source === 'MT5' ? 'your MT5 terminal' : 'the demo broker profile'} — never hard-coded.
            </p>
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-2">
          <div className="panel flex items-center gap-2 px-2 py-1.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold">
              {canonical === 'XAUUSD' ? <Coins className="h-3.5 w-3.5 text-amber-400" /> : <CandlestickChart className="h-3.5 w-3.5 text-sky-400" />}
              {displaySymbol}
              {displaySymbol !== canonical ? <span className="text-2xs font-normal text-muted-foreground">({canonical})</span> : null}
            </span>
            {quote ? (
              <span className="num text-xs text-muted-foreground">
                {formatPrice(quote.bid, quote.digits)} / {formatPrice(quote.ask, quote.digits)}
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-1">
              <Badge variant={mode === 'DEMO' ? 'demo' : online ? 'success' : 'destructive'}>
                {mode === 'DEMO' ? 'demo data' : online ? 'MT5 stream' : 'MT5 offline'}
              </Badge>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  void (inWatchlist ? removeFromWatchlist(canonical) : addToWatchlist(canonical));
                }}
                title={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
              >
                <Star className={cn('h-3.5 w-3.5', inWatchlist && 'fill-amber-400 text-amber-400')} />
              </Button>
            </span>
          </div>

          {error ? (
            <p className="flex items-center gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-2xs text-rose-200">
              <TriangleAlert className="h-3 w-3" />
              {error}
            </p>
          ) : null}

          <TradingChart
            symbol={displaySymbol}
            candles={candles}
            loading={loading}
            timeframe={timeframe}
            onTimeframeChange={setTimeframe}
            chartType={chartType}
            onChartTypeChange={setChartType}
            indicators={indicators}
            onIndicatorsChange={setIndicators}
            currentPrice={quote ? (quote.bid + quote.ask) / 2 : null}
            priceDigits={quote?.digits ?? spec?.digits ?? 2}
            dataSource={source ?? undefined}
            showVolume={showVolume}
            onToggleVolume={setShowVolume}
            height={420}
          />

          <div className="panel">
            <Tabs defaultValue="positions">
              <TabsList className="w-full justify-start">
                <TabsTrigger value="positions">
                  Positions <span className="ml-1 text-2xs text-muted-foreground">{symbolPositions.length}</span>
                </TabsTrigger>
                <TabsTrigger value="orders">
                  Pending Orders <span className="ml-1 text-2xs text-muted-foreground">{symbolOrders.length}</span>
                </TabsTrigger>
                <TabsTrigger value="history">
                  <LineChart className="mr-1 h-3 w-3" /> History
                </TabsTrigger>
              </TabsList>
              <TabsContent value="positions" className="mt-0">
                <PositionsTable
                  positions={symbolPositions}
                  compact
                  emptyMessage={`No open positions on ${displaySymbol}.`}
                />
              </TabsContent>
              <TabsContent value="orders" className="mt-0">
                <OrdersTable orders={symbolOrders} compact />
              </TabsContent>
              <TabsContent value="history" className="mt-0">
                <HistoryTable limit={50} />
              </TabsContent>
            </Tabs>
          </div>
        </div>

        <div className="min-h-0">
          <OrderPanel
            symbol={displaySymbol}
            spec={spec}
            availableSymbols={symbols.map((item) => item.symbol)}
            onSymbolChange={(next) => {
              const nextEntry = findSymbol(symbols, next);
              if (nextEntry && nextEntry.canonical !== canonical) {
                window.location.href = `/markets/${nextEntry.canonical.toLowerCase()}`;
              }
            }}
          />
        </div>
      </div>

      {!online && mode === 'LIVE' ? (
        <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-2xs font-semibold text-rose-200">
          MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE. Live order buttons are disabled until your MT5 terminal reconnects; DEMO trading
          continues to work.
        </p>
      ) : null}

      {!spec ? (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-2xs text-amber-200">
          Waiting for the broker specification of {requested.toUpperCase()}. Order sizing stays disabled until it arrives.
        </p>
      ) : null}
    </div>
  );
}
