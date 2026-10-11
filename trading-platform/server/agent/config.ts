import { TIMEFRAMES, type AgentConfig, type AgentMode, type StrategyId, type Timeframe } from '../../shared/types';

export const STRATEGIES: StrategyId[] = ['ema_cross', 'rsi_reversion', 'breakout', 'consensus'];
export const AGENT_MODES: AgentMode[] = ['rules', 'llm'];

export function defaultAgentConfig(): AgentConfig {
  return {
    enabled: false,
    mode: 'rules',
    symbols: ['EURUSD', 'XAUUSD', 'BTCUSDT'],
    timeframe: 'M15',
    strategy: 'consensus',
    riskPercent: 1,
    slAtr: 1.5,
    tpAtr: 3,
    maxOpenPositions: 3,
    maxDailyLossPercent: 5,
    allowFlip: true,
    llmIntervalSec: 300,
  };
}

const num = (v: unknown, min: number, max: number): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
  return v;
};

/**
 * Merge a partial update into the agent config, validating every field.
 * `knownSymbols` restricts the symbols the agent may trade.
 */
export function applyAgentPatch(
  current: AgentConfig,
  patch: Partial<Record<keyof AgentConfig, unknown>>,
  knownSymbols: string[],
): { ok: true; config: AgentConfig } | { ok: false; error: string } {
  const next: AgentConfig = { ...current, symbols: [...current.symbols] };
  const errors: string[] = [];

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') errors.push('enabled must be boolean');
    else next.enabled = patch.enabled;
  }
  if (patch.mode !== undefined) {
    if (!AGENT_MODES.includes(patch.mode as AgentMode)) errors.push('mode must be rules or llm');
    else next.mode = patch.mode as AgentMode;
  }
  if (patch.symbols !== undefined) {
    if (!Array.isArray(patch.symbols) || patch.symbols.some((s) => typeof s !== 'string')) {
      errors.push('symbols must be a list of symbols');
    } else {
      const unknown = (patch.symbols as string[]).filter((s) => !knownSymbols.includes(s));
      if (unknown.length) errors.push(`unknown symbols: ${unknown.join(', ')}`);
      else next.symbols = [...new Set(patch.symbols as string[])];
    }
  }
  if (patch.timeframe !== undefined) {
    if (!TIMEFRAMES.includes(patch.timeframe as Timeframe)) errors.push('invalid timeframe');
    else next.timeframe = patch.timeframe as Timeframe;
  }
  if (patch.strategy !== undefined) {
    if (!STRATEGIES.includes(patch.strategy as StrategyId)) errors.push('invalid strategy');
    else next.strategy = patch.strategy as StrategyId;
  }
  const numeric: Array<[keyof AgentConfig, number, number, boolean]> = [
    ['riskPercent', 0.05, 5, false],
    ['slAtr', 0.5, 5, false],
    ['tpAtr', 0.5, 10, false],
    ['maxOpenPositions', 1, 10, true],
    ['maxDailyLossPercent', 1, 20, false],
    ['llmIntervalSec', 30, 3600, true],
  ];
  for (const [key, min, max, integer] of numeric) {
    if (patch[key] === undefined) continue;
    const v = num(patch[key], min, max);
    if (v === null || (integer && !Number.isInteger(v))) errors.push(`${key} must be between ${min} and ${max}`);
    else (next as unknown as Record<string, number>)[key] = v;
  }
  if (patch.allowFlip !== undefined) {
    if (typeof patch.allowFlip !== 'boolean') errors.push('allowFlip must be boolean');
    else next.allowFlip = patch.allowFlip;
  }

  if (errors.length) return { ok: false, error: errors.join('; ') };
  if (next.enabled && next.symbols.length === 0) return { ok: false, error: 'Pick at least one symbol' };
  return { ok: true, config: next };
}
