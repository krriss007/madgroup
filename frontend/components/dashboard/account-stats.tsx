"use client";

/** Account header cards: balance, equity, free margin, margin level, P/L. */

import { ArrowDownRight, ArrowUpRight, Wallet } from 'lucide-react';
import { formatMoney, formatNumber, formatPercent } from '@tradepilot/shared';
import { useTerminal } from '@/lib/terminal-context';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

export function AccountStats({ headline }: { headline?: { dayPl: number; totalPl: number; openPl: number } | null }): JSX.Element {
  const { account, mode } = useTerminal();
  const currency = account?.currency ?? 'USD';

  const cards = [
    { label: 'Balance', value: formatMoney(account?.balance ?? null, currency), hint: 'Closed trades settled' },
    { label: 'Equity', value: formatMoney(account?.equity ?? null, currency), hint: 'Balance + floating P/L' },
    { label: 'Free Margin', value: formatMoney(account?.freeMargin ?? null, currency), hint: 'Available for new positions' },
    {
      label: 'Margin Level',
      value: account?.marginLevel != null ? `${formatNumber(account.marginLevel, 2)}%` : '—',
      hint: account?.marginLevel != null && account.marginLevel < 200 ? 'Below 200% — keep an eye on it' : 'Equity / margin used',
    },
    {
      label: 'Floating P/L',
      value: formatMoney(account?.profit ?? null, currency),
      hint: 'Open positions',
      tone: (account?.profit ?? 0) >= 0 ? 'positive' : 'negative',
    },
    {
      label: headline ? "Today's P/L" : 'Mode',
      value: headline ? formatMoney(headline.dayPl, currency) : mode,
      hint: headline ? 'Realised today' : 'Active account mode',
      tone: headline ? (headline.dayPl >= 0 ? 'positive' : 'negative') : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <div key={card.label} className="panel p-2.5">
          <p className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
            {card.label === 'Balance' ? <Wallet className="h-3 w-3" /> : null}
            {card.label}
          </p>
          {account ? (
            <p
              className={cn(
                "num mt-1 text-base font-semibold",
                card.tone === "positive" && "text-emerald-400",
                card.tone === "negative" && "text-rose-400",
              )}
            >
              {card.value}
            </p>
          ) : (
            <Skeleton className="mt-1 h-5 w-24" />
          )}
          <p className="mt-0.5 text-[10px] text-muted-foreground">{card.hint}</p>
        </div>
      ))}
    </div>
  );
}

export function PlDelta({ value, className }: { value: number; className?: string }): JSX.Element {
  const positive = value >= 0;
  return (
    <span className={cn("num inline-flex items-center gap-0.5 font-semibold", positive ? "text-emerald-400" : "text-rose-400", className)}>
      {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {formatPercent(value, 2)}
    </span>
  );
}
