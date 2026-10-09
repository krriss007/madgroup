'use client';

/**
 * useRiskProfile — the account's live risk status (daily loss, open exposure,
 * lock state) together with the configured limits, for the active mode.
 */

import { useCallback, useEffect, useState } from 'react';
import type { RiskSettings, RiskStatus } from '@tradepilot/shared';
import { api } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';

export interface RiskProfile {
  risk: RiskStatus;
  settings: RiskSettings;
  lockedMessage: string | null;
}

export function useRiskProfile(): { risk: RiskStatus | null; settings: RiskSettings | null; lockedMessage: string | null; reload: () => void } {
  const { mode, authenticated, positions } = useTerminal();
  const [profile, setProfile] = useState<RiskProfile | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!authenticated) return;
      try {
        const response = await api.get<RiskProfile & { presets: unknown }>('/account/risk', { mode }, signal);
        setProfile({ risk: response.risk, settings: response.settings, lockedMessage: response.lockedMessage ?? null });
      } catch {
        /* The connection banner already surfaces transport problems. */
      }
    },
    [authenticated, mode],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, nonce, positions.length]);

  return { risk: profile?.risk ?? null, settings: profile?.settings ?? null, lockedMessage: profile?.lockedMessage ?? null, reload: () => setNonce((value) => value + 1) };
}
