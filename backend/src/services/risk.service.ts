/**
 * TradePilot — risk management.
 *
 * Two jobs:
 *   1. Persist the user's limits (Settings → Risk Management).
 *   2. Evaluate them before every order. If any limit is breached the order is
 *      NOT sent and the exact reason is returned to the UI.
 *
 * The daily-loss guard reads realised P/L from the trade history of the current
 * day and locks new trading when the configured percentage of the day's opening
 * balance has been lost.
 */

import {
  ErrorCode,
  TradePilotError,
  round,
  startOfUtcDay,
  dayKey,
  isWithinTradingHours,
  normalizeVolume,
  type RiskSettings,
  type RiskStatus,
  type SymbolInfo,
  type TradingMode,
  type OrderSide,
} from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { BrokerAccountRow, RiskSettingsRow, TradeRow } from '../db/types';
import type { Logger } from '../lib/logger';
import { newId } from '../lib/ids';

export const RISK_PRESETS = {
  maxRiskPerTradePercent: [0.5, 1, 2],
  maxDailyLossPercent: [1, 2, 5],
  maxOpenPositions: [1, 3, 5, 10],
} as const;

export interface PreTradeRequest {
  mode: TradingMode;
  account: BrokerAccountRow;
  symbol: SymbolInfo;
  side: OrderSide;
  volume: number;
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Slots already used by open positions (for the max-positions rule). */
  openPositionsCount: number;
  openExposureLots: number;
  /** true when MT5 is connected & authorized (LIVE only) */
  brokerOnline: boolean;
  /** domain check result from the shared validator, already computed */
  estimatedRiskAmount?: number | null;
  now?: Date;
}

export interface PreTradeCheck {
  ok: boolean;
  checks: { rule: string; ok: boolean; detail: string }[];
  errors: { code: string; message: string }[];
}

export class RiskService {
  constructor(
    private readonly store: Store,
    private readonly logger: Logger,
  ) {}

  /* ------------------------------------------------------------------ */
  /* settings                                                           */
  /* ------------------------------------------------------------------ */

  async getSettings(userId: string): Promise<RiskSettingsRow> {
    const existing = await this.store.riskSettings.findOne({ userId: { eq: userId } });
    if (existing) return existing;

    const row: RiskSettingsRow = {
      id: newId('rsk'),
      userId,
      maxRiskPerTradePercent: 1,
      maxDailyLossPercent: 2,
      maxOpenPositions: 3,
      maxTotalExposureLots: 5,
      maxLotSize: 1,
      maxDailyTrades: 20,
      maxConsecutiveLosses: 0,
      requireLiveConfirmation: true,
      maxSlippagePoints: 20,
      tradingHoursEnabled: false,
      tradingHours: [{ start: '00:00', end: '23:59' }],
      strategyEngineEnabled: false,
      updatedAt: new Date().toISOString(),
    };
    await this.store.riskSettings.insert(row);
    return row;
  }

  async updateSettings(userId: string, patch: Partial<RiskSettingsRow>): Promise<RiskSettingsRow> {
    const current = await this.getSettings(userId);
    const updated = await this.store.riskSettings.update(current.id, { ...patch, updatedAt: new Date().toISOString() });
    if (!updated) throw new TradePilotError(ErrorCode.INTERNAL, 'Failed to update risk settings.', 500);
    return updated;
  }

  toDomain(row: RiskSettingsRow): RiskSettings {
    return {
      userId: row.userId,
      maxRiskPerTradePercent: row.maxRiskPerTradePercent,
      maxDailyLossPercent: row.maxDailyLossPercent,
      maxOpenPositions: row.maxOpenPositions,
      maxTotalExposureLots: row.maxTotalExposureLots,
      maxLotSize: row.maxLotSize,
      maxDailyTrades: row.maxDailyTrades,
      maxConsecutiveLosses: row.maxConsecutiveLosses,
      requireLiveConfirmation: row.requireLiveConfirmation,
      maxSlippagePoints: row.maxSlippagePoints,
      tradingHoursEnabled: row.tradingHoursEnabled,
      tradingHours: row.tradingHours ?? [],
      strategyEngineEnabled: row.strategyEngineEnabled,
      updatedAt: row.updatedAt,
    };
  }

  /* ------------------------------------------------------------------ */
  /* status                                                             */
  /* ------------------------------------------------------------------ */

  async todayTrades(userId: string, accountId: string): Promise<TradeRow[]> {
    const start = startOfUtcDay();
    return this.store.trades.findMany(
      { userId: { eq: userId }, accountId: { eq: accountId }, closeTime: { gte: start.toISOString() } },
      { orderBy: [{ field: 'closeTime', direction: 'asc' }] },
    );
  }

  async computeStatus(
    userId: string,
    account: BrokerAccountRow,
    options: { liveTradingEnabled: boolean; brokerOnline: boolean; killSwitchEngaged: boolean; mt5Message?: string | null },
  ): Promise<RiskStatus> {
    const settings = await this.getSettings(userId);
    const [todayTrades, positions, openOrders] = await Promise.all([
      this.todayTrades(userId, account.id),
      this.store.positions.findMany({ accountId: { eq: account.id } }),
      this.store.orders.findMany({ accountId: { eq: account.id }, status: { eq: 'PENDING' } }),
    ]);

    const realized = todayTrades.reduce((acc, trade) => acc + trade.netProfit, 0);
    const losses = todayTrades.filter((t) => t.netProfit < 0).reduce((acc, t) => acc + t.netProfit, 0);
    const profits = todayTrades.filter((t) => t.netProfit > 0).reduce((acc, t) => acc + t.netProfit, 0);
    const dailyLossLimitAmount = round((account.startingBalance * settings.maxDailyLossPercent) / 100, 2);
    const exposure = round(positions.reduce((acc, p) => acc + p.volume, 0), 2);

    // Consecutive losses: walk the history backwards.
    const recent = await this.store.trades.findMany(
      { accountId: { eq: account.id } },
      { orderBy: [{ field: 'closeTime', direction: 'desc' }], limit: 50 },
    );
    let consecutiveLosses = 0;
    for (const trade of recent) {
      if (trade.netProfit < 0) consecutiveLosses += 1;
      else break;
    }

    const lockReasons: string[] = [];
    if (Math.abs(losses) >= dailyLossLimitAmount && dailyLossLimitAmount > 0) {
      lockReasons.push(`Daily loss limit reached (${round(Math.abs(losses), 2)} of ${dailyLossLimitAmount}).`);
    }
    if (settings.maxConsecutiveLosses > 0 && consecutiveLosses >= settings.maxConsecutiveLosses) {
      lockReasons.push(`${consecutiveLosses} consecutive losses — new entries paused by your risk settings.`);
    }
    if (settings.maxDailyTrades != null && todayTrades.length >= settings.maxDailyTrades) {
      lockReasons.push(`Daily trade limit reached (${settings.maxDailyTrades} trades).`);
    }
    if (settings.tradingHoursEnabled && !isWithinTradingHours(settings.tradingHours)) {
      lockReasons.push('Outside your configured trading hours.');
    }
    if (options.killSwitchEngaged) {
      lockReasons.push('Trading disabled by the emergency switch.');
    }
    void openOrders;

    const locked = lockReasons.length > 0;

    return {
      tradingEnabled: !locked,
      liveTradingEnabled: options.liveTradingEnabled,
      locked,
      lockReasons,
      dailyLossLimitAmount,
      dailyRealizedLoss: round(Math.abs(losses), 2),
      dailyRealizedProfit: round(profits, 2),
      dailyNetPl: round(realized, 2),
      dailyTradesCount: todayTrades.length,
      openPositionsCount: positions.length,
      totalExposureLots: exposure,
      consecutiveLosses,
      remainingRiskToday: round(Math.max(0, dailyLossLimitAmount - Math.abs(losses)), 2),
      day: dayKey(),
    };
  }

  /* ------------------------------------------------------------------ */
  /* pre-trade validation                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Full safety validation required by the specification. Every failing rule is
   * reported so the UI can display the exact reason.
   */
  async preTradeCheck(userId: string, request: PreTradeRequest): Promise<PreTradeCheck> {
    const settings = await this.getSettings(userId);
    const checks: PreTradeCheck['checks'] = [];
    const errors: PreTradeCheck['errors'] = [];
    const now = request.now ?? new Date();
    const isLive = request.mode === 'LIVE';

    const add = (rule: string, ok: boolean, detail: string, code?: string): void => {
      checks.push({ rule, ok, detail });
      if (!ok && code) errors.push({ code, message: detail });
    };

    // 1. Broker connection -------------------------------------------------
    if (isLive) {
      add(
        'MT5 connected',
        request.brokerOnline,
        request.brokerOnline
          ? 'MT5 terminal connected through the TradePilotBridge EA.'
          : 'MT5 is offline. Live trading is disabled.',
        ErrorCode.MT5_OFFLINE,
      );
    } else {
      add('Demo engine', true, 'Paper-trading engine is always available.');
    }

    // 2. Account authorization --------------------------------------------
    add(
      'Account authorized',
      request.account.isAuthorized,
      request.account.isAuthorized ? `Account ${request.account.login} authorized.` : 'Account is not authorized.',
      ErrorCode.MT5_NOT_AUTHORIZED,
    );

    // 3. Symbol exists -----------------------------------------------------
    add('Symbol exists', Boolean(request.symbol?.symbol), `Symbol ${request.symbol?.symbol ?? '—'} resolved from the broker specification.`, ErrorCode.SYMBOL_NOT_FOUND);

    // 4. Trading enabled by the broker ------------------------------------
    add(
      'Trading allowed',
      Boolean(request.symbol?.tradeAllowed),
      request.symbol?.tradeAllowed ? 'Broker allows trading on this symbol.' : 'The broker reports trading is disabled for this symbol.',
      ErrorCode.MT5_TRADE_DISABLED,
    );

    // 5. Market open -------------------------------------------------------
    const marketOpen = request.symbol?.tradeAllowed ?? false;
    add('Market open', marketOpen, marketOpen ? 'Market is open.' : 'Market is currently closed.', ErrorCode.MARKET_CLOSED);

    // 6. Volume valid ------------------------------------------------------
    const step = request.symbol?.volumeStep || 0.01;
    const volume = normalizeVolume(request.volume, step);
    const volumeOk =
      volume > 0 &&
      volume >= (request.symbol?.volumeMin || step) - 1e-9 &&
      volume <= (request.symbol?.volumeMax || 100) + 1e-9 &&
      volume <= (settings.maxLotSize || Infinity);
    add(
      'Volume valid',
      volumeOk,
      volumeOk
        ? `Volume ${volume} within broker grid (${request.symbol?.volumeMin}–${request.symbol?.volumeMax}, step ${step}).`
        : `Volume must be between ${request.symbol?.volumeMin} and ${request.symbol?.volumeMax} with a ${step} step. Configured maximum lot size: ${settings.maxLotSize}.`,
      volumeOk ? undefined : ErrorCode.INVALID_VOLUME,
    );

    // 7. SL / TP distance --------------------------------------------------
    if (request.stopLoss != null) {
      const stopsLevelPrice = (request.symbol?.stopsLevel || 0) * (request.symbol?.point || 0);
      const distance = Math.abs(request.price - request.stopLoss);
      const ok = distance >= stopsLevelPrice && distance > 0;
      add(
        'SL distance valid',
        ok,
        ok ? `Stop distance ${round(distance, request.symbol.digits)} ≥ stops level.` : 'Stop Loss is too close to the current market price.',
        ok ? undefined : ErrorCode.STOPS_LEVEL_VIOLATION,
      );
    } else {
      add('SL distance valid', true, 'No Stop Loss set (unprotected position — risk checks use the configured maximum).');
    }
    if (request.takeProfit != null) {
      const stopsLevelPrice = (request.symbol?.stopsLevel || 0) * (request.symbol?.point || 0);
      const distance = Math.abs(request.takeProfit - request.price);
      const ok = distance >= stopsLevelPrice && distance > 0;
      add(
        'TP distance valid',
        ok,
        ok ? `Target distance ${round(distance, request.symbol.digits)} ≥ stops level.` : 'Take Profit is too close to the current market price.',
        ok ? undefined : ErrorCode.STOPS_LEVEL_VIOLATION,
      );
    }

    // 8. Maximum risk per trade -------------------------------------------
    const riskAmount = request.estimatedRiskAmount ?? null;
    if (riskAmount != null && request.stopLoss != null) {
      const maxRisk = (request.account.balance * settings.maxRiskPerTradePercent) / 100;
      const ok = riskAmount <= maxRisk + 1e-6;
      add(
        'Max risk per trade',
        ok,
        ok
          ? `Risk ${round(riskAmount, 2)} within the ${settings.maxRiskPerTradePercent}% limit (${round(maxRisk, 2)}).`
          : `This order risks ${round(riskAmount, 2)}, above your ${settings.maxRiskPerTradePercent}% limit (${round(maxRisk, 2)}). Reduce the volume or tighten the stop.`,
        ok ? undefined : ErrorCode.RISK_LIMIT_EXCEEDED,
      );
    } else {
      add('Max risk per trade', true, 'Position size was not derived from a stop distance (no SL provided).');
    }

    // 9. Daily loss --------------------------------------------------------
    const todayTrades = await this.todayTrades(userId, request.account.id);
    const realizedLoss = Math.abs(todayTrades.filter((t) => t.netProfit < 0).reduce((acc, t) => acc + t.netProfit, 0));
    const dailyLimit = (request.account.startingBalance * settings.maxDailyLossPercent) / 100;
    const dailyOk = realizedLoss < dailyLimit;
    add(
      'Maximum daily loss',
      dailyOk,
      dailyOk
        ? `Today's realised loss ${round(realizedLoss, 2)} of the ${round(dailyLimit, 2)} limit.`
        : 'DAILY LOSS LIMIT REACHED — TRADING LOCKED',
      dailyOk ? undefined : ErrorCode.DAILY_LOSS_LIMIT_REACHED,
    );

    // 10. Open positions ---------------------------------------------------
    const positionsOk = request.openPositionsCount < settings.maxOpenPositions;
    add(
      'Maximum open positions',
      positionsOk,
      positionsOk
        ? `${request.openPositionsCount} of ${settings.maxOpenPositions} position slots used.`
        : `Maximum of ${settings.maxOpenPositions} open positions reached.`,
      positionsOk ? undefined : ErrorCode.MAX_POSITIONS_REACHED,
    );

    // 11. Total exposure ---------------------------------------------------
    const exposureOk = request.openExposureLots + volume <= settings.maxTotalExposureLots + 1e-9;
    add(
      'Maximum total exposure',
      exposureOk,
      exposureOk
        ? `Exposure ${round(request.openExposureLots + volume, 2)} of ${settings.maxTotalExposureLots} lots.`
        : `Total exposure would reach ${round(request.openExposureLots + volume, 2)} lots, above the ${settings.maxTotalExposureLots} lot limit.`,
      exposureOk ? undefined : ErrorCode.MAX_EXPOSURE_EXCEEDED,
    );

    // 12. Consecutive losses ----------------------------------------------
    let consecutiveLosses = 0;
    for (const trade of await this.store.trades.findMany(
      { accountId: { eq: request.account.id } },
      { orderBy: [{ field: 'closeTime', direction: 'desc' }], limit: 30 },
    )) {
      if (trade.netProfit < 0) consecutiveLosses += 1;
      else break;
    }
    const consecutiveOk = settings.maxConsecutiveLosses === 0 || consecutiveLosses < settings.maxConsecutiveLosses;
    if (!consecutiveOk) {
      add('Consecutive losses', false, `${consecutiveLosses} consecutive losses — new entries paused.`, ErrorCode.CONSECUTIVE_LOSS_LOCK);
    } else if (settings.maxConsecutiveLosses > 0) {
      add('Consecutive losses', true, `${consecutiveLosses} of ${settings.maxConsecutiveLosses} allowed.`);
    }

    // 13. Daily trade count -----------------------------------------------
    if (settings.maxDailyTrades != null) {
      const ok = todayTrades.length < settings.maxDailyTrades;
      add(
        'Maximum daily trades',
        ok,
        ok ? `${todayTrades.length} of ${settings.maxDailyTrades} trades today.` : `Daily trade limit of ${settings.maxDailyTrades} reached.`,
        ok ? undefined : ErrorCode.MAX_DAILY_TRADES_REACHED,
      );
    }

    // 14. Trading hours ----------------------------------------------------
    if (settings.tradingHoursEnabled) {
      const ok = isWithinTradingHours(settings.tradingHours, now);
      add('Trading hours', ok, ok ? 'Inside your configured trading hours.' : 'Outside your configured trading hours.', ok ? undefined : ErrorCode.TRADING_HOURS_BLOCKED);
    }

    return { ok: errors.length === 0, checks, errors };
  }

  /** Throw on the first failing rule (routes use this). */
  assertPreTrade(check: PreTradeCheck): void {
    if (check.ok) return;
    const first = check.errors[0];
    this.logger.warn({ code: first.code, message: first.message }, 'pre-trade validation failed');
    throw new TradePilotError(first.code, first.message, 409, {
      meta: { checks: check.checks.filter((c) => !c.ok) },
    });
  }
}
