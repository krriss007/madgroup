// ---------------------------------------------------------------------------
// Risk manager: pure decision helpers used by the paper engine before any
// simulated order. Every decision path is returned (not thrown) so the engine
// can log it - "log every ... risk-limit decision" is a hard requirement.
// ---------------------------------------------------------------------------
import { logRisk } from './logger.js';

/**
 * Decide whether a new simulated entry is allowed right now.
 * @returns {allowed: boolean, code?: string, reason?: string}
 */
export function gateEntry(ctx) {
  const { config, account, equity, positions, symbol, now, state } = ctx;

  // 1. Kill switch / halted states
  if (state.bot.status === 'KILLED') {
    return deny('KILL_SWITCH', 'Emergency stop is active. Reset the simulator to trade again.');
  }
  if (state.risk.dayHalted) {
    return deny(
      'DAILY_LOSS_HALT',
      `Daily loss limit (${config.dailyLossLimitPct}% of day-start equity) was reached - entries are halted until the next UTC day.`
    );
  }

  // 2. Duplicate-order prevention: at most one position per symbol.
  const existing = positions.find((p) => p.symbol === symbol);
  if (existing) {
    return deny('DUPLICATE_SYMBOL', `A position on ${symbol} is already open - duplicate orders are prevented.`);
  }

  // 3. Maximum number of open positions.
  if (positions.length >= config.maxOpenPositions) {
    return deny(
      'MAX_POSITIONS',
      `Max open positions reached (${positions.length}/${config.maxOpenPositions}) - entry blocked.`
    );
  }

  // 4. Cooldown after a losing trade (global, measured from last losing exit).
  if (config.cooldownSec > 0 && state.risk.lastLossAt) {
    const elapsed = (now - state.risk.lastLossAt) / 1000;
    if (elapsed < config.cooldownSec) {
      const remain = Math.ceil(config.cooldownSec - elapsed);
      return deny(
        'COOLDOWN',
        `Cooldown after a losing trade: ${remain}s remaining (${config.cooldownSec}s configured).`
      );
    }
  }

  // 5. Position size must produce a positive notional.
  const notional = (equity * config.positionSizePct) / 100;
  if (!(notional > 0) || !Number.isFinite(notional)) {
    return deny('BAD_SIZE', 'Computed position size is not positive - check balance and position size settings.');
  }

  return { allowed: true };
}

/**
 * Update daily-loss tracking. Called once per engine tick.
 * Returns (and logs) a state transition into day-halt when the limit is hit.
 */
export function checkDailyLoss(config, account, equity, now) {
  if (config.dailyLossLimitPct <= 0) return { halted: false };
  const threshold = account.dayStartEquity * (1 - config.dailyLossLimitPct / 100);
  if (equity <= threshold) {
    logRisk('Daily loss limit reached', {
      dayStartEquity: round(account.dayStartEquity),
      equity: round(equity),
      limitPct: config.dailyLossLimitPct,
    });
    return { halted: true };
  }
  return { halted: false };
}

function deny(code, reason) {
  logRisk(`Entry blocked: ${code}`, { code, reason });
  return { allowed: false, code, reason };
}

function round(x) {
  return Math.round(x * 100) / 100;
}
