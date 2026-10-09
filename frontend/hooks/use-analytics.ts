'use client';

/**
 * useAnalytics — portfolio analytics and equity/balance snapshots for the
 * active mode. Numbers come from trades the account actually executed; an
 * account without trades returns `hasData: false`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsSummary } from '@tradepilot/shared';
import { api } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';

export interface PortfolioSnapshotPoint {
  time: string;
  balance: number;
  equity: number;
}

export function useAnalytics(): {
  summary: AnalyticsSummary | null;
  series: PortfolioSnapshotPoint[];
  headline: { dayPl: number; totalPl: number; openPl: number } | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const { mode, authenticated, account } = useTerminal();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [series, setSeries] = useState<PortfolioSnapshotPoint[]>([]);
  const [headline, setHeadline] = useState<{ dayPl: number; totalPl: number; openPl: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const balance = account?.balance ?? null;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!authenticated) return;
      setLoading(true);
      try {
        const [analytics, portfolio] = await Promise.all([
          // NOTE: /analytics answers `{ mode, summary }` — the summary is nested.
          // Reading it as if it were the summary itself is what produced
          // "Cannot read properties of undefined (reading 'slice')" on the
          // dashboard, because `summary.dailyPl` was undefined.
          api.get<{ mode: string; summary?: AnalyticsSummary | null }>('/analytics', { mode }, signal),
          api.get<{ series: PortfolioSnapshotPoint[]; headline: { dayPl: number; totalPl: number; openPl: number } }>(
            '/account/portfolio',
            { mode },
            signal,
          ),
        ]);
        setSummary(analytics.summary ?? null);
        setSeries(portfolio.series ?? []);
        setHeadline(portfolio.headline ?? null);
        setError(null);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [authenticated, mode],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, nonce, balance]);

  return { summary, series, headline, loading, error, reload: () => setNonce((value) => value + 1) };
}
