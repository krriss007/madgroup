/**
 * TradePilot — OPTIONAL automated strategy engine.
 *
 * Disabled by default and gated behind two switches:
 *   1. global: risk_settings.strategy_engine_enabled
 *   2. per strategy: strategies.enabled
 *
 * The engine is deliberately simple and transparent: a signal engine
 * (EMA cross / RSI reversion / Bollinger breakout), a risk manager that sizes
 * every trade from the broker's own symbol specification, and an execution
 * engine that goes through the very same OrderService the manual buttons use
 * (so all validations, audit logging and idempotency apply).
 *
 * It never promises performance and never displays a win rate.
 */

import {
  ErrorCode,
  TradePilotError,
  atr,
  bollinger,
  calculateLotSize,
  ema,
  rsi,
  type Candle,
  type StrategyConfig,
  type Timeframe,
} from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { StrategyRow } from '../db/types';
import type { Logger } from '../lib/logger';
import type { OrderService } from './execution/order.service';
import type { RiskService } from './risk.service';
import type { MarketService } from './market.service';
import type { AccountService } from './account.service';
import type { AuditService } from './audit.service';
import type { NotificationService } from './notification.service';
import { newId } from '../lib/ids';

export interface Signal {
  action: 'BUY' | 'SELL' | 'NONE';
  reason: string;
  strength: number;
}

export interface StrategyTickResult {
  strategyId: string;
  symbol: string;
  signal: Signal;
  executed: boolean;
  message: string;
}

export class StrategyService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      store: Store;
      logger: Logger;
      orders: OrderService;
      risk: RiskService;
      market: MarketService;
      accounts: AccountService;
      audit: AuditService;
      notifications: NotificationService;
    },
  ) {}

  /* ------------------------------------------------------------------ */
  /* CRUD                                                               */
  /* ------------------------------------------------------------------ */

  async list(userId: string): Promise<StrategyConfig[]> {
    const rows = await this.deps.store.strategies.findMany(
      { userId: { eq: userId } },
      { orderBy: [{ field: 'createdAt', direction: 'asc' }] },
    );
    return rows.map((row) => this.toDomain(row));
  }

  async create(userId: string, input: Partial<StrategyConfig> & { name: string; engine: StrategyRow['engine']; symbol: string }): Promise<StrategyConfig> {
    const account = await this.deps.accounts.ensureDemoAccount(userId);
    const now = new Date().toISOString();
    const row: StrategyRow = {
      id: newId('stg'),
      userId,
      accountId: account.id,
      name: input.name.slice(0, 60),
      engine: input.engine,
      symbol: input.symbol,
      canonical: input.symbol.toUpperCase(),
      timeframe: input.timeframe ?? 'M15',
      // Always created disabled: enabling is an explicit, separate action.
      enabled: false,
      parameters: input.parameters ?? defaultParameters(input.engine),
      riskPerTradePercent: input.riskPerTradePercent ?? 0.5,
      maxPositions: input.maxPositions ?? 1,
      lastSignalAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.strategies.insert(row);
    return this.toDomain(row);
  }

  async update(userId: string, id: string, patch: Partial<StrategyConfig> & { enabled?: boolean }): Promise<StrategyConfig> {
    const row = await this.deps.store.strategies.findById(id);
    if (!row || row.userId !== userId) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Strategy not found.', 404);

    if (patch.enabled === true) {
      const settings = await this.deps.risk.getSettings(userId);
      if (!settings.strategyEngineEnabled) {
        throw new TradePilotError(
          ErrorCode.FORBIDDEN,
          'The strategy engine is disabled. Enable it in Settings → Automated Strategies before enabling a strategy.',
          409,
        );
      }
    }

    const updated = await this.deps.store.strategies.update(id, {
      name: patch.name?.slice(0, 60) ?? row.name,
      enabled: patch.enabled ?? row.enabled,
      symbol: patch.symbol ?? row.symbol,
      timeframe: (patch.timeframe as string) ?? row.timeframe,
      parameters: patch.parameters ?? row.parameters,
      riskPerTradePercent: patch.riskPerTradePercent ?? row.riskPerTradePercent,
      maxPositions: patch.maxPositions ?? row.maxPositions,
      updatedAt: new Date().toISOString(),
    });
    if (!updated) throw new TradePilotError(ErrorCode.INTERNAL, 'Failed to update the strategy.', 500);
    return this.toDomain(updated);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const row = await this.deps.store.strategies.findById(id);
    if (!row || row.userId !== userId) return false;
    return this.deps.store.strategies.delete(id);
  }

  /* ------------------------------------------------------------------ */
  /* signal engine                                                      */
  /* ------------------------------------------------------------------ */

  evaluate(engine: StrategyRow['engine'], candles: Candle[], parameters: Record<string, number>): Signal {
    if (candles.length < 60) return { action: 'NONE', reason: 'Not enough history to evaluate.', strength: 0 };
    const closes = candles.map((c) => c.close);
    const last = candles.length - 1;

    switch (engine) {
      case 'ema_cross': {
        const fast = ema(closes, parameters.fast ?? 9);
        const slow = ema(closes, parameters.slow ?? 21);
        const fastPrev = fast[last - 1];
        const slowPrev = slow[last - 1];
        const fastNow = fast[last];
        const slowNow = slow[last];
        if (fastNow == null || slowNow == null || fastPrev == null || slowPrev == null) {
          return { action: 'NONE', reason: 'EMA values not available yet.', strength: 0 };
        }
        if (fastPrev <= slowPrev && fastNow > slowNow) {
          return { action: 'BUY', reason: `EMA ${parameters.fast ?? 9} crossed above EMA ${parameters.slow ?? 21}.`, strength: 1 };
        }
        if (fastPrev >= slowPrev && fastNow < slowNow) {
          return { action: 'SELL', reason: `EMA ${parameters.fast ?? 9} crossed below EMA ${parameters.slow ?? 21}.`, strength: 1 };
        }
        return { action: 'NONE', reason: 'No EMA cross on the last closed candle.', strength: 0 };
      }
      case 'rsi_reversion': {
        const values = rsi(closes, parameters.period ?? 14);
        const now = values[last];
        const prev = values[last - 1];
        if (now == null || prev == null) return { action: 'NONE', reason: 'RSI not available yet.', strength: 0 };
        const oversold = parameters.oversold ?? 30;
        const overbought = parameters.overbought ?? 70;
        if (prev < oversold && now >= oversold) {
          return { action: 'BUY', reason: `RSI crossed back above ${oversold} (${now.toFixed(1)}).`, strength: 1 };
        }
        if (prev > overbought && now <= overbought) {
          return { action: 'SELL', reason: `RSI crossed back below ${overbought} (${now.toFixed(1)}).`, strength: 1 };
        }
        return { action: 'NONE', reason: 'RSI not at an actionable level.', strength: 0 };
      }
      case 'bollinger_breakout': {
        const bands = bollinger(closes, parameters.period ?? 20, parameters.deviation ?? 2);
        const upper = bands.upper[last];
        const lower = bands.lower[last];
        const closePrev = closes[last - 1];
        const closeNow = closes[last];
        const upperPrev = bands.upper[last - 1];
        const lowerPrev = bands.lower[last - 1];
        if (upper == null || lower == null || upperPrev == null || lowerPrev == null) {
          return { action: 'NONE', reason: 'Bands not available yet.', strength: 0 };
        }
        if (closePrev <= upperPrev && closeNow > upper) {
          return { action: 'BUY', reason: 'Close broke above the upper Bollinger band.', strength: 1 };
        }
        if (closePrev >= lowerPrev && closeNow < lower) {
          return { action: 'SELL', reason: 'Close broke below the lower Bollinger band.', strength: 1 };
        }
        return { action: 'NONE', reason: 'No Bollinger breakout on the last closed candle.', strength: 0 };
      }
      default:
        return { action: 'NONE', reason: 'Unknown engine.', strength: 0 };
    }
  }

  /* ------------------------------------------------------------------ */
  /* execution engine                                                   */
  /* ------------------------------------------------------------------ */

  async runOnce(userId: string, strategyId: string, mode: 'DEMO' | 'LIVE' = 'DEMO'): Promise<StrategyTickResult> {
    const row = await this.deps.store.strategies.findById(strategyId);
    if (!row || row.userId !== userId) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Strategy not found.', 404);

    const settings = await this.deps.risk.getSettings(userId);
    if (!settings.strategyEngineEnabled || !row.enabled) {
      return { strategyId, symbol: row.symbol, signal: { action: 'NONE', reason: 'Strategy disabled.', strength: 0 }, executed: false, message: 'Strategy engine or strategy disabled.' };
    }

    const account = await this.deps.accounts.requireActiveAccount(userId, mode);
    const timeframe = row.timeframe as Timeframe;
    const candles = await this.deps.orders.candles(
      { userId, mode, ip: null, userAgent: 'strategy-engine' },
      row.symbol,
      timeframe,
      Math.max(120, (row.parameters.slow ?? 21) + 60),
    );
    const signal = this.evaluate(row.engine, candles, row.parameters ?? {});

    await this.deps.store.strategies.update(row.id, {
      lastSignalAt: new Date().toISOString(),
      lastError: signal.action === 'NONE' ? row.lastError : null,
    });

    if (signal.action === 'NONE') {
      return { strategyId, symbol: row.symbol, signal, executed: false, message: signal.reason };
    }

    const positions = await this.deps.store.positions.findMany({ accountId: { eq: account.id }, strategyId: { eq: row.id } });
    if (positions.length >= row.maxPositions) {
      return { strategyId, symbol: row.symbol, signal, executed: false, message: `Strategy already holds ${positions.length} of ${row.maxPositions} allowed positions.` };
    }

    // Risk manager: stop distance from ATR, size from the broker specification.
    const atrValues = atr(candles, row.parameters.atr ?? 14);
    const lastAtr = [...atrValues].reverse().find((v) => v != null) ?? null;
    const lastClose = candles[candles.length - 1].close;
    if (!lastAtr) {
      return { strategyId, symbol: row.symbol, signal, executed: false, message: 'ATR unavailable — refusing to size the trade.' };
    }
    const stopDistance = lastAtr * (row.parameters.atrMultiple ?? 1.5);
    const stopLoss = signal.action === 'BUY' ? lastClose - stopDistance : lastClose + stopDistance;
    const takeProfit = signal.action === 'BUY' ? lastClose + stopDistance * 2 : lastClose - stopDistance * 2;

    const symbol = await this.deps.market.getSymbolSpec(mode, userId, row.symbol);
    const sizing = calculateLotSize({
      balance: account.balance,
      riskPercent: row.riskPerTradePercent,
      entryPrice: lastClose,
      stopLoss,
      takeProfit,
      symbol,
      maxLotSize: settings.maxLotSize,
    });
    if (sizing.status === 'invalid' || sizing.volume <= 0) {
      const message = sizing.reasons.join(' ') || 'Position size could not be computed.';
      await this.deps.store.strategies.update(row.id, { lastError: message });
      return { strategyId, symbol: row.symbol, signal, executed: false, message };
    }

    const candleTime = candles[candles.length - 1].time;
    try {
      await this.deps.orders.placeOrder(
        {
          symbol: row.symbol,
          side: signal.action,
          type: 'MARKET',
          volume: sizing.volume,
          stopLoss,
          takeProfit,
          comment: `Strategy ${row.name}`,
          // Deterministic idempotency key: one entry per strategy per candle.
          clientRequestId: `strat:${row.id}:${candleTime}:${signal.action}`,
          origin: 'STRATEGY',
          strategyId: row.id,
          confirmed: mode === 'DEMO',
        },
        { userId, mode, ip: null, userAgent: 'strategy-engine' },
      );
      await this.deps.notifications.create(userId, {
        level: 'info',
        title: `Strategy ${row.name}: ${signal.action} ${row.canonical}`,
        message: `${signal.reason} Volume ${sizing.volume} lots, SL ${stopLoss.toFixed(symbol.digits)}. Mode: ${mode}.`,
        meta: { strategyId: row.id, mode },
      });
      return { strategyId, symbol: row.symbol, signal, executed: true, message: `Order sent: ${signal.reason}` };
    } catch (error) {
      const message = (error as Error).message;
      await this.deps.store.strategies.update(row.id, { lastError: message });
      await this.deps.audit.record({
        userId,
        mode,
        action: 'STRATEGY_ORDER_REJECTED',
        symbol: row.symbol,
        volume: sizing.volume,
        price: lastClose,
        stopLoss,
        takeProfit,
        result: 'REJECTED',
        errorMessage: message,
        detail: { strategyId: row.id, engine: row.engine },
      });
      return { strategyId, symbol: row.symbol, signal, executed: false, message };
    }
  }

  /** Background loop — only runs when at least one strategy is enabled. */
  start(mode: 'DEMO' | 'LIVE' = 'DEMO', intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tickAll(mode), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tickAll(mode: 'DEMO' | 'LIVE' = 'DEMO'): Promise<StrategyTickResult[]> {
    const enabled = await this.deps.store.strategies.findMany({ enabled: { eq: true } });
    const results: StrategyTickResult[] = [];
    for (const strategy of enabled) {
      try {
        const settings = await this.deps.risk.getSettings(strategy.userId);
        if (!settings.strategyEngineEnabled) continue;
        results.push(await this.runOnce(strategy.userId, strategy.id, mode));
      } catch (error) {
        this.deps.logger.warn({ strategyId: strategy.id, error: (error as Error).message }, 'strategy tick failed');
      }
    }
    return results;
  }

  toDomain(row: StrategyRow): StrategyConfig {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      engine: row.engine,
      symbol: row.symbol,
      timeframe: row.timeframe as Timeframe,
      enabled: row.enabled,
      parameters: row.parameters ?? {},
      riskPerTradePercent: row.riskPerTradePercent,
      maxPositions: row.maxPositions,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastSignalAt: row.lastSignalAt,
    };
  }
}

function defaultParameters(engine: StrategyRow['engine']): Record<string, number> {
  switch (engine) {
    case 'ema_cross':
      return { fast: 9, slow: 21, atr: 14, atrMultiple: 1.5 };
    case 'rsi_reversion':
      return { period: 14, oversold: 30, overbought: 70, atr: 14, atrMultiple: 1.5 };
    case 'bollinger_breakout':
      return { period: 20, deviation: 2, atr: 14, atrMultiple: 1.5 };
    default:
      return {};
  }
}
