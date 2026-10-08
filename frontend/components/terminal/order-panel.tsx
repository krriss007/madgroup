'use client';

/**
 * OrderPanel — the professional order-entry panel.
 *
 * Contents: instrument, direction (BUY/SELL), order type, lot size, entry price,
 * stop loss, take profit, risk %, estimated risk/reward and the place-order
 * buttons. Every order is previewed on the server (validation + risk checks)
 * before it is sent, and LIVE orders always require the confirmation dialog.
 *
 * The buttons are labelled DEMO or LIVE depending on the active account mode.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, Info, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { calculateLotSize, formatMoney, formatNumber, formatPrice, normalizeVolume } from '@tradepilot/shared';
import type { SymbolInfo } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { api, ApiError } from '@/lib/api';
import { ORDER_TYPES, RISK_PRESETS, LIVE_ORDER_WARNING } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface OrderPanelProps {
  symbol: string;
  spec: SymbolInfo | null;
  onSymbolChange?: (symbol: string) => void;
  availableSymbols?: string[];
  compact?: boolean;
}

type DraftType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

export function OrderPanel({ symbol, spec, onSymbolChange, availableSymbols = [], compact = false }: OrderPanelProps): JSX.Element {
  const { quotes, mode, account, risk, connection, placeOrder, previewOrder, liveTradingEnabled, pushToast } = useTerminal();
  const quote = quotes[symbol] ?? null;

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<DraftType>('MARKET');
  const [volume, setVolume] = useState('0.01');
  const [price, setPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [stopLimitPrice, setStopLimitPrice] = useState('');
  const [riskPercent, setRiskPercent] = useState<number>(1);
  const [autoSize, setAutoSize] = useState(true);
  const [expiration, setExpiration] = useState('');
  const [comment, setComment] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<Awaited<ReturnType<typeof previewOrder>> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const liveLocked = mode === 'LIVE' && !liveTradingEnabled;
  const tradingLocked = risk?.locked ?? false;
  // DEMO prices come from the backend's own simulator, so the panel is usable
  // whenever the API answers. In LIVE the buttons must reflect reality: no
  // connected EA means no live order, so they go dead instead of letting the
  // user submit something the backend will refuse (`MT5_NOT_AUTHORIZED`).
  const online = mode === 'DEMO' || connection.status === 'CONNECTED';

  const entry = type === 'MARKET' ? (quote ? (side === 'BUY' ? quote.ask : quote.bid) : NaN) : Number(price);

  // Prefill the entry price with the live market price whenever it moves.
  useEffect(() => {
    if (type === 'MARKET' && quote) setPrice(formatPrice(side === 'BUY' ? quote.ask : quote.bid, quote.digits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, side, quote?.bid, quote?.ask]);

  const lots = useMemo(() => {
    if (!spec || !Number.isFinite(entry)) return null;
    const sl = stopLoss ? Number(stopLoss) : NaN;
    if (!Number.isFinite(sl) || sl <= 0) return null;
    return calculateLotSize({
      balance: account?.balance ?? 0,
      riskPercent,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit: takeProfit ? Number(takeProfit) : null,
      symbol: spec,
    });
  }, [account?.balance, entry, riskPercent, spec, stopLoss, takeProfit]);

  // Auto position sizing: keep the lot size aligned with the risk %.
  useEffect(() => {
    if (!autoSize || !lots || lots.status === 'invalid' || lots.volume <= 0) return;
    setVolume(normalizeVolume(lots.volume, spec?.volumeStep ?? 0.01).toFixed(Math.max(2, String(spec?.volumeStep ?? 0.01).split('.')[1]?.length ?? 2)));
  }, [autoSize, lots, spec?.volumeStep]);

  const numericVolume = Number(volume);
  const volumeRisk = useMemo(() => {
    if (!spec || !Number.isFinite(entry) || !stopLoss) return null;
    const sl = Number(stopLoss);
    if (!Number.isFinite(sl) || sl <= 0) return null;
    const distance = Math.abs(entry - sl);
    const ticks = spec.tickSize > 0 ? distance / spec.tickSize : 0;
    const loss = ticks * spec.tickValueLoss * (Number.isFinite(numericVolume) ? numericVolume : 0);
    const reward = takeProfit
      ? (Math.abs(Number(takeProfit) - entry) / (spec.tickSize || 0.00001)) * spec.tickValueProfit * (Number.isFinite(numericVolume) ? numericVolume : 0)
      : null;
    return {
      loss,
      reward,
      ratio: reward != null && loss > 0 ? reward / loss : null,
      percentOfBalance: account?.balance ? (loss / account.balance) * 100 : 0,
    };
  }, [account?.balance, entry, numericVolume, spec, stopLoss, takeProfit]);

  const draft = {
    symbol,
    side,
    type,
    volume: Number.isFinite(numericVolume) ? numericVolume : 0,
    price: type === 'MARKET' ? null : price ? Number(price) : null,
    stopLimitPrice: type === 'STOP_LIMIT' && stopLimitPrice ? Number(stopLimitPrice) : null,
    stopLoss: stopLoss ? Number(stopLoss) : null,
    takeProfit: takeProfit ? Number(takeProfit) : null,
    expiration: expiration || null,
    comment: comment || null,
  };

  const openPreview = async (): Promise<void> => {
    setPreviewError(null);
    setBusy(true);
    try {
      const result = await previewOrder(draft, { riskPercent: autoSize ? riskPercent : null });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : (error as Error).message;
      setPreviewError(message);
      pushToast({ level: 'error', title: 'Order rejected before sending', message });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await placeOrder(draft, { confirmed: mode === 'LIVE', riskPercent: autoSize ? riskPercent : null });
      if (result.success) setPreviewOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const setPresetRisk = (value: number): void => {
    setAutoSize(true);
    setRiskPercent(value);
  };

  const buttonLabel = mode === 'LIVE' ? `LIVE ORDER` : `DEMO ORDER`;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="panel flex flex-col">
        <div className="panel-header">
          <span>Order Panel</span>
          <span className="flex items-center gap-1.5">
            {mode === 'DEMO' ? (
              <Badge variant="demo">DEMO · simulated</Badge>
            ) : liveTradingEnabled ? (
              <Badge variant="live">🔴 LIVE · real money</Badge>
            ) : (
              <Badge variant="outline">
                <Lock className="h-3 w-3" /> live locked
              </Badge>
            )}
          </span>
        </div>

        <div className="space-y-3 p-3">
          {tradingLocked ? (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-2xs text-rose-200">
              <p className="font-semibold">DAILY LOSS LIMIT REACHED — TRADING LOCKED</p>
              {risk?.lockReasons?.map((reason) => (
                <p key={reason}>• {reason}</p>
              ))}
            </div>
          ) : null}

          {liveLocked ? (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-2xs text-amber-200">
              <p className="font-semibold">LIVE TRADING IS DISABLED</p>
              <p>Enable it in Settings → Live Trading after your MT5 terminal is connected. Until then orders would be rejected.</p>
            </div>
          ) : null}

          {/* Instrument ------------------------------------------------- */}
          <div className="space-y-1">
            <Label>Instrument</Label>
            {availableSymbols.length ? (
              <Select value={symbol} onValueChange={(value) => onSymbolChange?.(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableSymbols.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input value={symbol} onChange={(event) => onSymbolChange?.(event.target.value.toUpperCase())} className="num" />
            )}
          </div>

          {/* Direction + type ------------------------------------------- */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={side === 'BUY' ? 'buy' : 'outline'}
              size="sm"
              onClick={() => setSide('BUY')}
            >
              BUY
            </Button>
            <Button type="button" variant={side === 'SELL' ? 'sell' : 'outline'} size="sm" onClick={() => setSide('SELL')}>
              SELL
            </Button>
          </div>

          <div className="space-y-1">
            <Label>Order type</Label>
            <div className="grid grid-cols-4 gap-1">
              {ORDER_TYPES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setType(option.id)}
                  className={cn(
                    'rounded border px-1 py-1 text-2xs font-semibold',
                    type === option.id ? 'border-primary/50 bg-primary/15 text-primary' : 'border-panel-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Prices ------------------------------------------------------ */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="entry-price">Entry price</Label>
              <Input
                id="entry-price"
                value={type === 'MARKET' && quote ? formatPrice(side === 'BUY' ? quote.ask : quote.bid, quote.digits) : price}
                onChange={(event) => setPrice(event.target.value)}
                disabled={type === 'MARKET'}
                inputMode="decimal"
                className="num"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lot-size">Lot size</Label>
              <Input
                id="lot-size"
                value={volume}
                onChange={(event) => {
                  setAutoSize(false);
                  setVolume(event.target.value);
                }}
                inputMode="decimal"
                className="num"
              />
            </div>
          </div>

          {type === 'STOP_LIMIT' ? (
            <div className="space-y-1">
              <Label htmlFor="stop-limit">Stop limit price</Label>
              <Input id="stop-limit" value={stopLimitPrice} onChange={(event) => setStopLimitPrice(event.target.value)} inputMode="decimal" className="num" />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="stop-loss">Stop Loss</Label>
              <Input id="stop-loss" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} inputMode="decimal" placeholder="0.00" className="num" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="take-profit">Take Profit</Label>
              <Input id="take-profit" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} inputMode="decimal" placeholder="0.00" className="num" />
            </div>
          </div>

          {/* Risk sizing -------------------------------------------------- */}
          <div className="rounded border border-panel-border bg-background/40 p-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Calculator className="h-3 w-3" /> Risk sizing
              </span>
              <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                <span>auto size</span>
                <Switch checked={autoSize} onCheckedChange={setAutoSize} aria-label="Automatic position sizing" />
              </span>
            </div>

            <div className="mt-2 flex items-center gap-1">
              {RISK_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setPresetRisk(preset)}
                  className={cn(
                    'rounded border px-2 py-0.5 text-2xs font-semibold',
                    riskPercent === preset && autoSize ? 'border-primary/50 bg-primary/15 text-primary' : 'border-panel-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {preset}%
                </button>
              ))}
              <Input
                value={riskPercent}
                onChange={(event) => {
                  setAutoSize(true);
                  setRiskPercent(Number(event.target.value) || 0);
                }}
                className="num ml-1 h-6 w-16 text-2xs"
                inputMode="decimal"
              />
            </div>

            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
              <Metric label="Max risk" value={lots ? formatMoney(lots.maxRiskAmount) : '—'} />
              <Metric label="Estimated risk" value={volumeRisk ? formatMoney(volumeRisk.loss) : '—'} tone={volumeRisk && volumeRisk.loss > 0 ? 'negative' : 'neutral'} />
              <Metric label="Estimated reward" value={volumeRisk?.reward != null ? formatMoney(volumeRisk.reward) : '—'} tone="positive" />
              <Metric
                label="Risk / Reward"
                value={volumeRisk?.ratio != null ? `1:${formatNumber(volumeRisk.ratio, 2)}` : '—'}
                tone={volumeRisk?.ratio != null && volumeRisk.ratio < 1 ? 'negative' : 'neutral'}
              />
              <Metric label="Risk of balance" value={volumeRisk ? `${formatNumber(volumeRisk.percentOfBalance, 3)}%` : '—'} />
              <Metric label="Units" value={lots ? formatNumber(lots.units, 2) : '—'} />
              <Metric label="Est. margin" value={lots ? formatMoney(lots.estimatedMargin) : '—'} />
              <Metric label="Spread" value={quote ? `${formatNumber(quote.spreadPoints, 1)} pts` : '—'} />
            </dl>

            {lots && lots.status === 'invalid' ? (
              <p className="mt-2 flex items-start gap-1 text-2xs text-rose-300">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {lots.reasons.join(' ')}
              </p>
            ) : null}
            {lots?.warnings?.length ? (
              <ul className="mt-1 space-y-0.5 text-2xs text-amber-300">
                {lots.warnings.map((warning) => (
                  <li key={warning}>• {warning}</li>
                ))}
              </ul>
            ) : null}
            {previewError ? <p className="mt-2 text-2xs text-rose-300">{previewError}</p> : null}
          </div>

          {!compact ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="expiration">Expiration</Label>
                <Input id="expiration" type="datetime-local" value={expiration} onChange={(event) => setExpiration(event.target.value)} className="text-2xs" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="comment">Comment</Label>
                <Input id="comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="TradePilot" />
              </div>
            </div>
          ) : null}

          {/* Buttons ----------------------------------------------------- */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="buy"
                  className="h-10 font-semibold"
                  disabled={busy || tradingLocked || !online}
                  onClick={() => {
                    setSide('BUY');
                    void openPreview();
                  }}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {side === 'BUY' ? `BUY ${symbol}` : `BUY ${symbol}`}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{buttonLabel} · {symbol}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="sell"
                  className="h-10 font-semibold"
                  disabled={busy || tradingLocked || !online}
                  onClick={() => {
                    setSide('SELL');
                    void openPreview();
                  }}
                >
                  SELL {symbol}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{buttonLabel} · {symbol}</TooltipContent>
            </Tooltip>
          </div>

          <p className={cn('text-center text-2xs font-semibold uppercase tracking-wide', mode === 'LIVE' ? 'text-rose-300' : 'text-sky-300')}>
            {mode === 'LIVE' ? 'LIVE ORDER — REAL MONEY' : 'DEMO ORDER — SIMULATED EXECUTION'}
          </p>
        </div>
      </div>

      {/* Preview / confirmation dialog ---------------------------------- */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className={mode === 'LIVE' ? 'border-rose-500/50' : undefined}>
          <DialogHeader>
            <DialogTitle className={mode === 'LIVE' ? 'text-rose-300' : undefined}>
              {mode === 'LIVE' ? 'Confirm LIVE order' : 'Confirm demo order'}
            </DialogTitle>
            <DialogDescription>
              {mode === 'LIVE'
                ? `${LIVE_ORDER_WARNING} This order will be sent to your MT5 terminal (account ${account?.login ?? '—'}) and executed by your broker.`
                : 'This order will be executed by the TradePilot demo engine with simulated prices.'}
            </DialogDescription>
          </DialogHeader>

          {previewData ? (
            <div className="space-y-2 text-xs">
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <Line label="Action" value={`${previewData.side} ${previewData.symbol}`} />
                <Line label="Type" value={previewData.type} />
                <Line label="Volume" value={`${formatNumber(previewData.volume, 2)} lots`} />
                <Line label="Price" value={formatPrice(previewData.price, spec?.digits ?? 2)} />
                <Line label="Stop Loss" value={previewData.stopLoss ? formatPrice(previewData.stopLoss, spec?.digits ?? 2) : 'none'} />
                <Line label="Take Profit" value={previewData.takeProfit ? formatPrice(previewData.takeProfit, spec?.digits ?? 2) : 'none'} />
                <Line label="Estimated risk" value={formatMoney(previewData.estimatedRisk)} />
                <Line label="Estimated reward" value={formatMoney(previewData.estimatedReward)} />
                <Line label="Risk / Reward" value={previewData.riskReward != null ? `1:${formatNumber(previewData.riskReward, 2)}` : '—'} />
                <Line label="Spread" value={`${formatNumber(previewData.spreadPoints, 1)} pts`} />
              </div>

              <div className="max-h-40 overflow-auto rounded border border-panel-border bg-background/40 p-2">
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Safety validation</p>
                <ul className="space-y-0.5">
                  {previewData.checks.map((check) => (
                    <li key={check.rule} className="flex items-start gap-1.5 text-2xs">
                      <span className={check.ok ? 'text-emerald-400' : 'text-rose-400'}>{check.ok ? '✓' : '✕'}</span>
                      <span className={check.ok ? 'text-muted-foreground' : 'text-rose-200'}>
                        <span className="font-medium text-foreground/80">{check.rule}:</span> {check.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {previewData.errors.length ? (
                <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-2xs text-rose-200">
                  {previewData.errors.map((error) => (
                    <p key={`${error.code}-${error.message}`}>
                      <span className="font-semibold">{error.code}:</span> {error.message}
                    </p>
                  ))}
                  <p className="mt-1 font-semibold">The order will not be placed while a validation fails.</p>
                </div>
              ) : null}

              {previewData.warnings.length ? (
                <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-2xs text-amber-200">
                  {previewData.warnings.map((warning) => (
                    <p key={warning}>• {warning}</p>
                  ))}
                </div>
              ) : null}

              {!previewData.errors.length ? (
                <p className="flex items-center gap-1.5 text-2xs text-emerald-300">
                  <ShieldCheck className="h-3 w-3" /> All safety checks passed.
                </p>
              ) : null}

              {mode === 'DEMO' ? (
                <p className="flex items-start gap-1.5 text-2xs text-sky-200">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" /> Demo execution: prices are simulated and results are not real market performance.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading validation…</p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreviewOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={side === 'BUY' ? 'buy' : 'sell'}
              disabled={busy || !previewData || previewData.errors.length > 0}
              onClick={() => void confirm()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {mode === 'LIVE'
                ? `CONFIRM LIVE ${side} ${previewData ? formatNumber(previewData.volume, 2) : ''} LOTS`
                : `Confirm demo ${side}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'positive' | 'negative' | 'neutral' }): JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('num text-right', tone === 'positive' && 'text-emerald-400', tone === 'negative' && 'text-rose-400')}>{value}</dd>
    </>
  );
}

function Line({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="num text-right">{value}</span>
    </>
  );
}
