'use client';

/**
 * useCandles — fetch OHLC history for a symbol/timeframe and keep the last
 * candle current from the realtime quote stream. In LIVE mode the data comes
 * from MT5 through the backend; if MT5 is offline the hook returns an empty
 * series and the chart shows the "no live data" state instead of a stale one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { timeframeSeconds } from '@tradepilot/shared';
import type { Candle, Timeframe } from '@tradepilot/shared';
import { api } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';

export interface UseCandlesResult {
  candles: Candle[];
  source: 'MT5' | 'DEMO_SIMULATED' | null;
  atr: number | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useCandles(symbol: string, timeframe: Timeframe, count = 320): UseCandlesResult {
  const { quotes, mode } = useTerminal();
  const [candles, setCandles] = useState<Candle[]>([]);
  const [source, setSource] = useState<'MT5' | 'DEMO_SIMULATED' | null>(null);
  const [atr, setAtr] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastFetchRef = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await api.get<{ candles: Candle[]; source: 'MT5' | 'DEMO_SIMULATED'; atr: number | null }>(
          '/market/candles',
          { symbol, timeframe, count, mode },
          signal,
        );
        setCandles(response.candles);
        setSource(response.source);
        setAtr(response.atr);
        lastFetchRef.current = Date.now();
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
          setCandles([]);
          setSource(null);
        }
      } finally {
        setLoading(false);
      }
    },
    [count, mode, symbol, timeframe],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, mode, count, nonce]);

  // Keep the forming candle in sync with the incoming ticks, and refetch the
  // series once a new candle period starts.
  useEffect(() => {
    const quote = quotes[symbol] ?? null;
    if (!quote || candles.length === 0) return;
    const price = (quote.bid + quote.ask) / 2;
    setCandles((current) => {
      if (!current.length) return current;
      const bucket = Math.floor(Date.now() / 1000 / timeframeSeconds(timeframe)) * timeframeSeconds(timeframe);
      const last = { ...current[current.length - 1] };
      if (last.time !== bucket) {
        // New period → fetch the fresh series from the backend (throttled).
        if (Date.now() - lastFetchRef.current > 2_000) void load();
        return current;
      }
      const updated: Candle = {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
      };
      return [...current.slice(0, -1), updated];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotes, symbol, timeframe]);

  return { candles, source, atr, loading, error, reload: () => setNonce((value) => value + 1) };
}
