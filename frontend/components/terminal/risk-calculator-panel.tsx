"use client";

/**
 * RiskCalculatorPanel — computes position size from the broker's own symbol
 * specification (tick size, tick value, contract size, volume grid) reported by
 * MT5, or from the demo spec in DEMO mode. Nothing is hard-coded per symbol.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, Calculator } from 'lucide-react';
import { calculateLotSize, formatMoney, formatNumber, formatPrice, normalizeVolume } from '@tradepilot/shared';
import type { SymbolInfo } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

export function RiskCalculatorPanel({ symbols, initialSymbol = 'XAUUSD' }: { symbols: { symbol: string; canonical: string; spec: SymbolInfo }[]; initialSymbol?: string }): JSX.Element {
  const { account, quotes, mode } = useTerminal();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [balance, setBalance] = useState<string>(String(account?.balance ?? 10000));
  const [riskPercent, setRiskPercent] = useState('1');
  const [entry, setEntry] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');

  const spec = symbols.find((item) => item.canonical === symbol || item.symbol === symbol)?.spec ?? null;
  const quote = quotes[symbol] ?? null;

  const effectiveEntry = entry ? Number(entry) : quote ? (quote.ask + quote.bid) / 2 : 0;

  const result = useMemo(() => {
    if (!spec || !Number.isFinite(effectiveEntry) || effectiveEntry <= 0 || !stopLoss) return null;
    return calculateLotSize({
      balance: Number(balance) || 0,
      riskPercent: Number(riskPercent) || 0,
      entryPrice: effectiveEntry,
      stopLoss: Number(stopLoss),
      takeProfit: takeProfit ? Number(takeProfit) : null,
      symbol: spec,
    });
  }, [balance, effectiveEntry, riskPercent, spec, stopLoss, takeProfit]);

  return (
    <div className="panel p-3">
      <div className="panel-header -mx-3 -mt-3 mb-3">
        <span className="flex items-center gap-1.5">
          <Calculator className="h-3.5 w-3.5" /> Lot size calculator
        </span>
        <Badge variant={mode === "DEMO" ? "demo" : "success"}>{mode === "DEMO" ? "demo specs" : "MT5 specs"}</Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <div className="space-y-1">
            <Label>Symbol</Label>
            <Select value={symbol} onValueChange={setSymbol}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {symbols.map((item) => (
                  <SelectItem key={item.symbol} value={item.canonical}>
                    {item.symbol}
                    {item.symbol !== item.canonical ? ` (${item.canonical})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="calc-balance">Account balance</Label>
              <Input id="calc-balance" value={balance} onChange={(event) => setBalance(event.target.value)} className="num" inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="calc-risk">Risk %</Label>
              <Input id="calc-risk" value={riskPercent} onChange={(event) => setRiskPercent(event.target.value)} className="num" inputMode="decimal" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="calc-entry">Entry price</Label>
              <Input
                id="calc-entry"
                value={entry}
                onChange={(event) => setEntry(event.target.value)}
                placeholder={quote ? formatPrice(quote.ask, quote.digits) : "0.00"}
                className="num"
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="calc-sl">Stop Loss</Label>
              <Input id="calc-sl" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} className="num" inputMode="decimal" />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="calc-tp">Take Profit (optional)</Label>
            <Input id="calc-tp" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} className="num" inputMode="decimal" />
          </div>

          {spec ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded border border-panel-border bg-background/40 p-2 text-2xs">
              <dt className="text-muted-foreground">Contract size</dt>
              <dd className="num text-right">{formatNumber(spec.contractSize, 0)}</dd>
              <dt className="text-muted-foreground">Tick size / value</dt>
              <dd className="num text-right">
                {formatNumber(spec.tickSize, 5)} / {formatNumber(spec.tickValueLoss, 4)}
              </dd>
              <dt className="text-muted-foreground">Volume min / max / step</dt>
              <dd className="num text-right">
                {spec.volumeMin} / {spec.volumeMax} / {spec.volumeStep}
              </dd>
              <dt className="text-muted-foreground">Stops level</dt>
              <dd className="num text-right">{spec.stopsLevel} pts</dd>
              <dt className="text-muted-foreground">Digits / point</dt>
              <dd className="num text-right">
                {spec.digits} / {formatNumber(spec.point, 5)}
              </dd>
              <dt className="text-muted-foreground">Spec source</dt>
              <dd className="text-right">{spec.source === "MT5" ? "MT5 terminal" : "demo profile"}</dd>
            </dl>
          ) : (
            <p className="text-2xs text-muted-foreground">Select a symbol to load its broker specification.</p>
          )}
        </div>

        <div className="rounded border border-panel-border bg-background/40 p-3">
          <p className="text-2xs uppercase tracking-wide text-muted-foreground">Result</p>
          {result ? (
            <>
              <div className="mt-2 space-y-1.5 text-xs">
                <Row label="Maximum dollar risk" value={formatMoney(result.maxRiskAmount)} />
                <Row label="Recommended lot size" value={`${result.volume} lots`} strong />
                <Row label="Units" value={formatNumber(result.units, 2)} />
                <Row label="Actual risk at this size" value={formatMoney(result.actualRiskAmount)} />
                <Row label="Loss per lot at stop" value={formatMoney(result.lossPerLot)} />
                <Row label="Potential loss" value={formatMoney(result.potentialLoss)} tone="negative" />
                <Row label="Potential profit" value={result.potentialProfit ? formatMoney(result.potentialProfit) : "—"} tone="positive" />
                <Row label="Risk / Reward" value={result.riskReward != null ? `1:${formatNumber(result.riskReward, 2)}` : "—"} />
                <Row label="Stop distance" value={`${formatNumber(result.stopDistancePoints, 1)} points`} />
                <Row label="Estimated margin" value={formatMoney(result.estimatedMargin)} />
                <Row label="Snapped volume step" value={spec ? String(normalizeVolume(result.volume, spec.volumeStep)) : "—"} />
              </div>
              {result.status !== "ok" && result.reasons.length ? (
                <p className="mt-2 flex items-start gap-1 text-2xs text-rose-300">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {result.reasons.join(" ")}
                </p>
              ) : null}
              {result.warnings.length ? (
                <ul className="mt-2 space-y-0.5 text-2xs text-amber-300">
                  {result.warnings.map((warning) => (
                    <li key={warning}>• {warning}</li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 text-[10px] text-muted-foreground">
                Sized from the broker specification reported by {spec?.source === "MT5" ? "your MT5 terminal" : "the demo broker profile"} — never from a hard-coded table.
                Margin is an estimate; the terminal&apos;s margin check is authoritative.
              </p>
            </>
          ) : (
            <p className="mt-2 text-2xs text-muted-foreground">
              Enter a stop loss (and optionally a target) to compute the position size that keeps the trade inside your risk limit.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, tone, strong }: { label: string; value: string; tone?: "positive" | "negative"; strong?: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("num", strong && "text-sm font-semibold text-primary", tone === "positive" && "text-emerald-400", tone === "negative" && "text-rose-400")}>{value}</span>
    </div>
  );
}
