'use client';

/**
 * useSymbols — load the instrument list with the broker specifications that
 * apply to the active mode. In DEMO mode these are the demo profile specs; in
 * LIVE mode they are exactly what the connected MT5 terminal reports. The UI
 * never invents contract specs.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SymbolInfo } from '@tradepilot/shared';
import { api } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';

export interface SymbolEntry {
  symbol: string;
  canonical: string;
  spec: SymbolInfo;
}

export function useSymbols(): { symbols: SymbolEntry[]; loading: boolean; error: string | null; reload: () => void } {
  const { mode, authenticated } = useTerminal();
  const [symbols, setSymbols] = useState<SymbolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!authenticated) return;
      setLoading(true);
      try {
        const response = await api.get<{ symbols: SymbolInfo[] }>('/market/symbols', { mode }, signal);
        setSymbols((response.symbols ?? []).map((spec) => ({ symbol: spec.symbol, canonical: spec.canonical, spec })));
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
  }, [load, nonce]);

  return { symbols, loading, error, reload: () => setNonce((value) => value + 1) };
}

/** Resolve one symbol's entry from the list, tolerating broker name variants. */
export function findSymbol(symbols: SymbolEntry[], symbol: string | null | undefined): SymbolEntry | null {
  if (!symbol) return null;
  const target = symbol.toUpperCase();
  return (
    symbols.find((entry) => entry.symbol.toUpperCase() === target) ??
    symbols.find((entry) => entry.canonical.toUpperCase() === target) ??
    symbols.find((entry) => entry.symbol.toUpperCase().startsWith(target)) ??
    null
  );
}
