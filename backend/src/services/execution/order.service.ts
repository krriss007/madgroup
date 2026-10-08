/**
 * TradePilot — order execution service.
 *
 * The single funnel every order goes through, DEMO and LIVE alike:
 *
 *   request → authentication (route) → validation → risk checks → broker
 *           → audit log → notification → WebSocket broadcast → response
 *
 * Guarantees that matter for a trading platform:
 *   • Idempotency: one `clientRequestId` can never create two orders, even if
 *     the browser retries or the network drops the first response.
 *   • Fail-safe: if MT5 is offline or trading is locked, LIVE orders are never
 *     sent — the caller receives the exact reason.
 *   • Auditability: every live action is written to the append-only audit log
 *     with the broker ticket, result and error.
 */

import {
  ErrorCode,
  TradePilotError,
  canonicalize,
  round,
  calculateLotSize,
  normalizeVolume,
  validateOrder,
  type ExecutionReport,
  type OrderSide,
  type OrderType,
  type TradingMode,
  type Candle,
  type Quote,
} from '@tradepilot/shared';
import type { Store } from '../../db/types';
import type { BrokerAccountRow, OrderRow, PositionRow, UserRow } from '../../db/types';
import type { Env } from '../../config/env';
import type { Logger } from '../../lib/logger';
import type { AccountService } from '../account.service';
import type { RiskService } from '../risk.service';
import type { MarketService } from '../market.service';
import type { AuditService } from '../audit.service';
import type { NotificationService } from '../notification.service';
import type { BrokerRegistry } from '../broker/registry';
import type { DeviceService } from '../bridge/device.service';
import { newId } from '../../lib/ids';

export const CLOSE_ALL_CONFIRMATION = 'CONFIRM CLOSE ALL';

export interface OrderRequestContext {
  userId: string;
  mode: TradingMode;
  ip: string | null;
  userAgent: string | null;
  deviceId?: string | null;
}

export interface PlaceOrderInput {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  volume: number;
  price?: number | null;
  stopLimitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  expiration?: string | null;
  comment?: string | null;
  /** Idempotency key from the client (UUID). */
  clientRequestId: string;
  /** Required for LIVE orders when requireLiveConfirmation is on. */
  confirmed?: boolean;
  /** Optional: size the order from a risk percentage instead of a fixed volume */
  useRiskBasedSize?: boolean;
  riskPercent?: number | null;
  origin?: 'MANUAL' | 'STRATEGY';
  strategyId?: string | null;
}

export interface OrderResult {
  report: ExecutionReport;
  mode: TradingMode;
  accountId: string;
  /** Position/order rows created or affected (for the immediate UI update). */
  position?: PositionRow | null;
  order?: OrderRow | null;
  /** Everything the UI needs to render the confirmation dialog before sending. */
  risk?: ReturnType<typeof calculateLotSize> | null;
}

export interface OrderPreview {
  symbol: string;
  canonical: string;
  mode: TradingMode;
  side: OrderSide;
  type: OrderType;
  price: number;
  volume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  spread: number;
  spreadPoints: number;
  maxRiskAmount: number;
  estimatedRisk: number;
  estimatedReward: number;
  riskReward: number | null;
  riskPercentOfBalance: number;
  lots: ReturnType<typeof calculateLotSize>;
  warnings: string[];
  errors: { code: string; message: string }[];
  requiresConfirmation: boolean;
  confirmationText: string | null;
  liveWarning: string | null;
  checks: { rule: string; ok: boolean; detail: string }[];
}

export class OrderService {
  constructor(
    private readonly deps: {
      store: Store;
      env: Env;
      logger: Logger;
      accounts: AccountService;
      risk: RiskService;
      market: MarketService;
      audit: AuditService;
      notifications: NotificationService;
      brokers: BrokerRegistry;
      devices: DeviceService;
    },
  ) {}

  private get store(): Store {
    return this.deps.store;
  }

  /* ------------------------------------------------------------------ */
  /* preview / validation                                               */
  /* ------------------------------------------------------------------ */

  /** Pre-flight: everything the confirmation dialog needs, nothing is sent. */
  async preview(input: PlaceOrderInput, context: OrderRequestContext): Promise<OrderPreview> {
    const { account, symbol, quote } = await this.resolveTradingContext(input.symbol, context);
    const side = input.side;
    const type = input.type;
    const marketPrice = side === 'BUY' ? quote.ask : quote.bid;
    const price = type === 'MARKET' ? marketPrice : Number(input.price ?? marketPrice);

    const settings = await this.deps.risk.getSettings(context.userId);
    const balance = account.balance;

    const sizing = calculateLotSize({
      balance,
      riskPercent: input.useRiskBasedSize && input.riskPercent ? input.riskPercent : settings.maxRiskPerTradePercent,
      entryPrice: price,
      stopLoss: input.stopLoss ?? price - (side === 'BUY' ? 1 : -1) * (symbol.stopsLevel || 1) * symbol.point,
      takeProfit: input.takeProfit ?? null,
      symbol,
      maxLotSize: settings.maxLotSize,
    });

    const validation = validateOrder({
      symbol,
      side,
      type,
      volume: input.volume,
      marketPrice,
      price: type === 'MARKET' ? null : price,
      stopLimitPrice: input.stopLimitPrice ?? null,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      expiration: input.expiration ?? null,
      leverage: account.leverage,
      freeMargin: account.freeMargin,
      maxLotSize: settings.maxLotSize,
    });

    const volume = validation.normalizedVolume;
    const riskAmount = input.stopLoss != null ? Math.abs(price - input.stopLoss) / (symbol.tickSize || symbol.point || 1) * symbol.tickValueLoss * volume : null;
    const rewardAmount = input.takeProfit != null ? Math.abs(input.takeProfit - price) / (symbol.tickSize || symbol.point || 1) * symbol.tickValueProfit * volume : null;

    const positions = await this.store.positions.findMany({ accountId: { eq: account.id } });
    const exposure = positions.reduce((acc, p) => acc + p.volume, 0);
    const user = await this.store.users.findById(context.userId);
    const connection = context.mode === 'LIVE' ? await this.deps.devices.connectionForAccount(account.id) : null;
    const brokerOnline = context.mode === 'DEMO' ? true : this.deps.devices.isOnline(connection);

    const preTrade = await this.deps.risk.preTradeCheck(context.userId, {
      mode: context.mode,
      account,
      symbol,
      side,
      volume,
      price,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      openPositionsCount: positions.length,
      openExposureLots: round(exposure, 2),
      brokerOnline,
      estimatedRiskAmount: riskAmount,
    });

    const errors = [
      ...validation.errors.map((e) => ({ code: e.code, message: e.message })),
      ...preTrade.errors.filter((e) => !validation.errors.some((v) => v.message === e.message)),
    ];

    const requiresConfirmation = context.mode === 'LIVE' && (settings.requireLiveConfirmation || true);

    return {
      symbol: symbol.symbol,
      canonical: symbol.canonical,
      mode: context.mode,
      side,
      type,
      price,
      volume,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      spread: quote.spread,
      spreadPoints: quote.spreadPoints,
      maxRiskAmount: sizing.maxRiskAmount,
      estimatedRisk: round(riskAmount ?? 0, 2),
      estimatedReward: round(rewardAmount ?? 0, 2),
      riskReward: riskAmount && rewardAmount ? round(rewardAmount / riskAmount, 2) : null,
      riskPercentOfBalance: balance > 0 && riskAmount ? round((riskAmount / balance) * 100, 3) : 0,
      lots: sizing,
      warnings: [...validation.warnings, ...sizing.warnings],
      errors,
      requiresConfirmation,
      confirmationText: context.mode === 'LIVE' ? 'THIS ORDER WILL USE REAL MONEY.' : null,
      liveWarning:
        context.mode === 'LIVE'
          ? 'THIS ORDER WILL USE REAL MONEY. It will be sent to your MT5 terminal for execution by your broker.'
          : null,
      checks: preTrade.checks,
    };
  }

  /* ------------------------------------------------------------------ */
  /* placement                                                          */
  /* ------------------------------------------------------------------ */

  async placeOrder(input: PlaceOrderInput, context: OrderRequestContext): Promise<OrderResult> {
    const duplicate = await this.findIdempotentResult(context.userId, 'place_order', input.clientRequestId);
    if (duplicate) {
      this.deps.logger.info({ clientRequestId: input.clientRequestId }, 'duplicate order request ignored (idempotency key)');
      return duplicate;
    }

    const { broker, account, symbol, quote } = await this.resolveTradingContext(input.symbol, context);
    const settings = await this.deps.risk.getSettings(context.userId);
    const user = await this.store.users.findById(context.userId);

    if (context.mode === 'LIVE') {
      if (!user?.liveTradingEnabled) {
        throw new TradePilotError(
          ErrorCode.LIVE_TRADING_DISABLED,
          'Live trading is disabled. Enable it in Settings → Live Trading after connecting your MT5 account.',
          403,
        );
      }
      if (settings.requireLiveConfirmation && input.confirmed !== true) {
        throw new TradePilotError(
          ErrorCode.CONFIRMATION_REQUIRED,
          'Live orders require an explicit confirmation. Confirm the order dialog to continue (THIS ORDER WILL USE REAL MONEY).',
          409,
        );
      }
    }

    const marketPrice = input.side === 'BUY' ? quote.ask : quote.bid;
    const type = input.type;
    const entryPrice = type === 'MARKET' ? marketPrice : Number(input.price ?? marketPrice);

    const validation = validateOrder({
      symbol,
      side: input.side,
      type,
      volume: input.volume,
      marketPrice,
      price: type === 'MARKET' ? null : entryPrice,
      stopLimitPrice: input.stopLimitPrice ?? null,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      expiration: input.expiration ?? null,
      leverage: account.leverage,
      freeMargin: account.freeMargin,
      maxLotSize: settings.maxLotSize,
    });

    const volume = validation.normalizedVolume || normalizeVolume(input.volume, symbol.volumeStep || 0.01);
    const riskAmount =
      input.stopLoss != null
        ? (Math.abs(entryPrice - input.stopLoss) / (symbol.tickSize || symbol.point || 1)) * symbol.tickValueLoss * volume
        : null;

    const positions = await this.store.positions.findMany({ accountId: { eq: account.id } });
    const exposure = positions.reduce((acc, p) => acc + p.volume, 0);
    const connection = context.mode === 'LIVE' ? await this.deps.devices.connectionForAccount(account.id) : null;
    const brokerOnline = context.mode === 'DEMO' ? true : this.deps.devices.isOnline(connection);

    const preTrade = await this.deps.risk.preTradeCheck(context.userId, {
      mode: context.mode,
      account,
      symbol,
      side: input.side,
      volume,
      price: entryPrice,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      openPositionsCount: positions.length,
      openExposureLots: round(exposure, 2),
      brokerOnline,
      estimatedRiskAmount: riskAmount,
    });

    const rejections = [...validation.errors];
    for (const error of preTrade.errors) {
      if (!rejections.some((r) => r.message === error.message)) {
        rejections.push({ code: error.code, field: 'preTrade', message: error.message });
      }
    }

    if (rejections.length) {
      const first = rejections[0];
      await this.deps.audit.record({
        userId: context.userId,
        mode: context.mode,
        action: `ORDER_REJECTED:${type}`,
        symbol: symbol.symbol,
        volume,
        price: entryPrice,
        stopLoss: input.stopLoss ?? null,
        takeProfit: input.takeProfit ?? null,
        result: 'REJECTED',
        errorCode: first.code,
        errorMessage: first.message,
        ip: context.ip,
        userAgent: context.userAgent,
        deviceId: context.deviceId ?? null,
        commandId: input.clientRequestId,
        detail: { rejections, checks: preTrade.checks.filter((c) => !c.ok) },
      });
      throw new TradePilotError(first.code, first.message, 409, {
        details: Object.fromEntries(rejections.map((r) => [r.field, r.message])),
        meta: { checks: preTrade.checks.filter((c) => !c.ok) },
      });
    }

    // ---------------------------------------------------------------- send
    let report: ExecutionReport;
    try {
      report =
        type === 'MARKET'
          ? await broker.placeMarketOrder({
              symbol: symbol.symbol,
              side: input.side,
              volume,
              stopLoss: input.stopLoss ?? null,
              takeProfit: input.takeProfit ?? null,
              comment: input.comment ?? null,
              clientRequestId: input.clientRequestId,
              deviationPoints: settings.maxSlippagePoints,
              origin: input.origin ?? 'MANUAL',
              strategyId: input.strategyId ?? null,
            })
          : await broker.placePendingOrder({
              symbol: symbol.symbol,
              side: input.side,
              type: type as Exclude<OrderType, 'MARKET'>,
              volume,
              price: entryPrice,
              stopLimitPrice: input.stopLimitPrice ?? null,
              stopLoss: input.stopLoss ?? null,
              takeProfit: input.takeProfit ?? null,
              expiration: input.expiration ?? null,
              comment: input.comment ?? null,
              clientRequestId: input.clientRequestId,
              origin: input.origin ?? 'MANUAL',
              strategyId: input.strategyId ?? null,
            });
    } catch (error) {
      const tpError = error instanceof TradePilotError ? error : new TradePilotError(ErrorCode.EXECUTION_FAILED, (error as Error).message, 502);
      await this.deps.audit.record({
        userId: context.userId,
        mode: context.mode,
        action: `ORDER_FAILED:${type}`,
        symbol: symbol.symbol,
        volume,
        price: entryPrice,
        stopLoss: input.stopLoss ?? null,
        takeProfit: input.takeProfit ?? null,
        result: 'FAILURE',
        errorCode: tpError.code,
        errorMessage: tpError.message,
        ip: context.ip,
        userAgent: context.userAgent,
        deviceId: context.deviceId ?? null,
        commandId: input.clientRequestId,
      });
      throw tpError;
    }

    // ------------------------------------------------------------- record
    const position =
      report.ticket && type === 'MARKET'
        ? await this.store.positions.findOne({ accountId: { eq: account.id }, ticket: { eq: report.ticket } })
        : null;
    const order =
      report.ticket && type !== 'MARKET'
        ? await this.store.orders.findOne({ accountId: { eq: account.id }, ticket: { eq: report.ticket } })
        : null;

    await this.deps.audit.record({
      userId: context.userId,
      mode: context.mode,
      action: type === 'MARKET' ? `OPEN_MARKET_ORDER:${input.side}` : `PLACE_PENDING_ORDER:${input.side}_${type}`,
      symbol: symbol.symbol,
      volume,
      price: report.executionPrice ?? entryPrice,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      brokerTicket: report.ticket,
      result: report.success ? 'SUCCESS' : 'FAILURE',
      errorCode: report.errorCode,
      errorMessage: report.errorMessage,
      ip: context.ip,
      userAgent: context.userAgent,
      deviceId: context.deviceId ?? null,
      commandId: report.commandId,
      detail: {
        sparkline: quote.bid,
        spreadPoints: quote.spreadPoints,
        riskAmount: riskAmount != null ? round(riskAmount, 2) : null,
        mode: context.mode,
        source: symbol.source,
      },
    });

    await this.deps.notifications.create(context.userId, {
      level: report.success ? 'success' : 'warning',
      title: report.success
        ? `${context.mode} ${input.side} ${symbol.canonical} ${volume}`
        : `Order rejected: ${symbol.canonical}`,
      message: report.success
        ? `${
            type === 'MARKET' ? 'Market order filled' : `${type} order placed`
          } at ${report.executionPrice ?? entryPrice} • ticket ${report.ticket ?? '—'}${context.mode === 'DEMO' ? ' (simulated)' : ''}.`
        : report.errorMessage ?? 'The broker rejected the order.',
      meta: { symbol: symbol.symbol, ticket: report.ticket, mode: context.mode, action: type },
    });

    void user;

    const result: OrderResult = { report, mode: context.mode, accountId: account.id, position, order };
    await this.rememberResult(context.userId, 'place_order', input.clientRequestId, result);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* position / order management                                        */
  /* ------------------------------------------------------------------ */

  async modifyPosition(
    context: OrderRequestContext,
    input: { ticket: string; stopLoss?: number | null; takeProfit?: number | null; clientRequestId: string },
  ): Promise<OrderResult> {
    const { broker, account, symbol, quote } = await this.resolveContextForTicket(context, input.ticket, 'position');
    const position = await this.store.positions.findOne({ accountId: { eq: account.id }, ticket: { eq: input.ticket } });

    // Stops are validated against the position's OWN direction and the price the
    // broker will actually check: a SELL position keeps its stop above the market
    // and its target below it. Getting this wrong rejected perfectly valid edits
    // on short positions.
    const side: OrderSide = position?.side === 'SELL' ? 'SELL' : 'BUY';
    const reference =
      position && position.currentPrice > 0 ? position.currentPrice : quote ? (quote.ask + quote.bid) / 2 : 0;
    const validation = validateOrder({
      symbol,
      side,
      type: 'MARKET',
      volume: position?.volume ?? (symbol.volumeMin || 0.01),
      marketPrice: reference,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
    });
    const relevant = validation.errors.filter((e) => {
      if (e.field === 'stopLoss') return input.stopLoss != null;
      if (e.field === 'takeProfit') return input.takeProfit != null;
      if (e.field === 'volume' || e.field === 'symbol') return false;
      return true;
    });
    if (relevant.length) {
      const first = relevant[0];
      await this.deps.audit.record({
        userId: context.userId,
        mode: context.mode,
        action: 'MODIFY_POSITION_REJECTED',
        symbol: symbol.symbol,
        volume: position?.volume ?? null,
        price: reference,
        stopLoss: input.stopLoss ?? null,
        takeProfit: input.takeProfit ?? null,
        result: 'REJECTED',
        errorCode: first.code,
        errorMessage: first.message,
        ip: context.ip,
        userAgent: context.userAgent,
        commandId: input.clientRequestId,
      });
      throw new TradePilotError(first.code, first.message, 400);
    }

    const report = await withAudit(() => broker.modifyPosition({
      ticket: input.ticket,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      clientRequestId: input.clientRequestId,
    }), context, 'MODIFY_POSITION', symbol.symbol, input.clientRequestId, this.deps.audit);

    const updated = await this.store.positions.findOne({ accountId: { eq: account.id }, ticket: { eq: input.ticket } });
    return { report, mode: context.mode, accountId: account.id, position: updated };
  }

  async modifyOrder(
    context: OrderRequestContext,
    input: { ticket: string; price?: number | null; stopLoss?: number | null; takeProfit?: number | null; expiration?: string | null; clientRequestId: string },
  ): Promise<OrderResult> {
    const { broker, account, symbol } = await this.resolveContextForTicket(context, input.ticket, 'order');
    const order = await this.store.orders.findOne({ accountId: { eq: account.id }, ticket: { eq: input.ticket } });
    const side: OrderSide = order?.side === 'SELL' ? 'SELL' : 'BUY';

    // The backend revalidates every edit too — the EA is the last gate, not the
    // only one. Stops are checked against the price the pending order will use.
    const reference = input.price ?? order?.price ?? 0;
    if (reference > 0) {
      const validation = validateOrder({
        symbol,
        side,
        type: 'MARKET',
        volume: order?.volume ?? (symbol.volumeMin || 0.01),
        marketPrice: reference,
        stopLoss: input.stopLoss ?? null,
        takeProfit: input.takeProfit ?? null,
      });
      const relevant = validation.errors.filter((error) => {
        if (error.field === 'stopLoss') return input.stopLoss != null;
        if (error.field === 'takeProfit') return input.takeProfit != null;
        if (error.field === 'price' || error.field === 'volume' || error.field === 'symbol') return false;
        return true;
      });
      if (relevant.length) {
        const first = relevant[0];
        await this.deps.audit.record({
          userId: context.userId,
          mode: context.mode,
          action: 'MODIFY_ORDER_REJECTED',
          symbol: symbol.symbol,
          volume: order?.volume ?? null,
          price: reference,
          stopLoss: input.stopLoss ?? null,
          takeProfit: input.takeProfit ?? null,
          result: 'REJECTED',
          errorCode: first.code,
          errorMessage: first.message,
          ip: context.ip,
          userAgent: context.userAgent,
          commandId: input.clientRequestId,
        });
        throw new TradePilotError(first.code, first.message, 400);
      }
    }

    const report = await withAudit(() => broker.modifyOrder({
      ticket: input.ticket,
      price: input.price ?? null,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      expiration: input.expiration ?? null,
      clientRequestId: input.clientRequestId,
    }), context, 'MODIFY_ORDER', symbol.symbol, input.clientRequestId, this.deps.audit);

    const updated = await this.store.orders.findOne({ accountId: { eq: account.id }, ticket: { eq: input.ticket } });
    return { report, mode: context.mode, accountId: account.id, order: updated };
  }

  async closePosition(
    context: OrderRequestContext,
    input: { ticket: string; volume?: number | null; reason?: string | null; clientRequestId: string },
  ): Promise<OrderResult> {
    const duplicate = await this.findIdempotentResult(context.userId, 'close_position', input.clientRequestId);
    if (duplicate) return duplicate;
    const { broker, account, symbol } = await this.resolveContextForTicket(context, input.ticket, 'position');
    const position = await this.store.positions.findOne({ accountId: { eq: account.id }, ticket: { eq: input.ticket } });

    const report = await withAudit(
      () =>
        broker.closePosition({
          ticket: input.ticket,
          volume: input.volume ?? null,
          reason: input.reason ?? 'Closed from TradePilot',
          clientRequestId: input.clientRequestId,
        }),
      context,
      'CLOSE_POSITION',
      symbol?.symbol ?? '',
      input.clientRequestId,
      this.deps.audit,
      {
        volume: position?.volume ?? null,
        price: position?.currentPrice ?? null,
        detail: { side: position?.side, openPrice: position?.openPrice, mode: context.mode },
      },
    );

    await this.deps.notifications.create(context.userId, {
      level: (report.realizedPl ?? 0) >= 0 ? 'success' : 'warning',
      title: `Closed ${symbol?.canonical ?? input.ticket}`,
      message: `Ticket ${input.ticket} closed at ${report.executionPrice ?? '—'} • P/L ${round(report.realizedPl ?? 0, 2)}${context.mode === 'DEMO' ? ' (simulated)' : ''}.`,
      meta: { ticket: input.ticket, mode: context.mode },
    });

    const result: OrderResult = { report, mode: context.mode, accountId: account.id, position: null };
    await this.rememberResult(context.userId, 'close_position', input.clientRequestId, result);
    return result;
  }

  async closeAllPositions(
    context: OrderRequestContext,
    input: { confirm: string; symbol?: string | null; reason?: string | null; clientRequestId: string },
  ): Promise<OrderResult> {
    if ((input.confirm ?? '').trim().toUpperCase() !== CLOSE_ALL_CONFIRMATION) {
      throw new TradePilotError(
        ErrorCode.CONFIRMATION_MISMATCH,
        `Closing all positions requires the exact confirmation text "${CLOSE_ALL_CONFIRMATION}".`,
        400,
      );
    }
    const { broker, account } = await this.deps.brokers.forMode(context.userId, context.mode);
    const positions = await this.store.positions.findMany({ accountId: { eq: account.id } });

    const report = await withAudit(() => broker.closeAllPositions({
      confirm: input.confirm,
      symbol: input.symbol ?? null,
      reason: input.reason ?? 'Emergency close all positions',
      clientRequestId: input.clientRequestId,
    }), context, 'CLOSE_ALL_POSITIONS', input.symbol ?? '', input.clientRequestId, this.deps.audit, {
      detail: { requested: positions.length },
    });

    await this.deps.notifications.create(context.userId, {
      level: 'critical',
      title: context.mode === 'LIVE' ? 'CLOSE ALL POSITIONS executed' : 'DEMO CLOSE ALL POSITIONS executed',
      message: `${report.affected ?? 0} position(s) closed. Realised P/L ${round(report.realizedPl ?? 0, 2)}.`,
      meta: { mode: context.mode, affected: report.affected ?? 0 },
    });

    return { report, mode: context.mode, accountId: account.id };
  }

  async cancelOrder(
    context: OrderRequestContext,
    input: { ticket: string; clientRequestId: string },
  ): Promise<OrderResult> {
    const { broker, account } = await this.resolveContextForTicket(context, input.ticket, 'order');
    const report = await withAudit(
      () => broker.cancelOrder({ ticket: input.ticket, clientRequestId: input.clientRequestId }),
      context,
      'CANCEL_ORDER',
      '',
      input.clientRequestId,
      this.deps.audit,
    );
    const updated = await this.store.orders.findOne({ accountId: { eq: account.id }, ticket: { eq: input.ticket } });
    return { report, mode: context.mode, accountId: account.id, order: updated };
  }

  async cancelAllOrders(context: OrderRequestContext, input: { clientRequestId: string }): Promise<OrderResult> {
    const { account } = await this.deps.brokers.forMode(context.userId, context.mode);
    const orders = await this.store.orders.findMany({ accountId: { eq: account.id }, status: { eq: 'PENDING' } });
    let cancelled = 0;
    const failures: string[] = [];
    for (const order of orders) {
      try {
        await this.cancelOrder(context, { ticket: order.ticket, clientRequestId: `${input.clientRequestId}:${order.ticket}` });
        cancelled += 1;
      } catch (error) {
        failures.push(`${order.ticket}: ${(error as Error).message}`);
      }
    }
    await this.deps.audit.record({
      userId: context.userId,
      mode: context.mode,
      action: 'CANCEL_ALL_ORDERS',
      result: failures.length ? 'FAILURE' : 'SUCCESS',
      errorMessage: failures.length ? failures.join(' | ') : null,
      ip: context.ip,
      userAgent: context.userAgent,
      commandId: input.clientRequestId,
      detail: { cancelled, total: orders.length },
    });
    return {
      report: {
        commandId: input.clientRequestId,
        idempotencyKey: input.clientRequestId,
        success: failures.length === 0,
        ticket: null,
        executionPrice: null,
        volume: null,
        errorCode: failures.length ? ErrorCode.EXECUTION_FAILED : null,
        errorMessage: failures.length ? failures.join(' | ') : null,
        at: new Date().toISOString(),
        affected: cancelled,
      },
      mode: context.mode,
      accountId: account.id,
    };
  }

  /** Emergency kill switch: disables live trading and blocks new live orders. */
  async disableLiveTrading(context: OrderRequestContext, reason: string): Promise<{ disabled: boolean }> {
    await this.store.users.update(context.userId, { liveTradingEnabled: false, killSwitchEngaged: true });
    await this.deps.audit.record({
      userId: context.userId,
      mode: 'LIVE',
      action: 'DISABLE_LIVE_TRADING',
      result: 'SUCCESS',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { reason },
    });
    await this.deps.notifications.create(context.userId, {
      level: 'critical',
      title: 'Live trading disabled',
      message: reason,
    });
    return { disabled: true };
  }

  async enableLiveTrading(context: OrderRequestContext, acknowledged: boolean): Promise<{ enabled: boolean }> {
    if (!acknowledged) {
      throw new TradePilotError(
        ErrorCode.CONFIRMATION_REQUIRED,
        'You must acknowledge the live trading risk warning before enabling live trading.',
        400,
      );
    }
    const connection = await this.deps.devices.connectionForUser(context.userId);
    if (!connection || !this.deps.devices.isOnline(connection)) {
      throw new TradePilotError(
        ErrorCode.MT5_OFFLINE,
        'Connect your MT5 terminal (TradePilotBridge EA) before enabling live trading.',
        409,
      );
    }
    const account = await this.deps.accounts.getAccount(context.userId, 'LIVE');
    if (!account) {
      throw new TradePilotError(ErrorCode.MT5_NOT_AUTHORIZED, 'No authorized MT5 account is linked yet.', 409);
    }
    const now = new Date().toISOString();
    await this.store.users.update(context.userId, {
      liveTradingEnabled: true,
      liveTradingEnabledAt: now,
      liveRiskAcknowledgedAt: now,
      killSwitchEngaged: false,
    });
    await this.deps.audit.record({
      userId: context.userId,
      mode: 'LIVE',
      action: 'ENABLE_LIVE_TRADING',
      result: 'SUCCESS',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { account: account.login, server: account.server, deviceId: connection.deviceId },
    });
    await this.deps.notifications.create(context.userId, {
      level: 'warning',
      title: '🔴 LIVE TRADING ENABLED',
      message: `Orders will now be sent to your MT5 account ${account.login} (${account.server}) and executed with real money.`,
    });
    return { enabled: true };
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  private async resolveTradingContext(
    symbolInput: string,
    context: OrderRequestContext,
  ): Promise<{ broker: Awaited<ReturnType<BrokerRegistry['forAccount']>>; account: BrokerAccountRow; symbol: Awaited<ReturnType<MarketService['getSymbolSpec']>>; quote: Quote }> {
    const { broker, account } = await this.deps.brokers.forMode(context.userId, context.mode);
    const connection = context.mode === 'LIVE' ? await this.deps.devices.connectionForAccount(account.id) : null;
    const symbol = await this.deps.market.getSymbolSpec(context.mode, context.userId, symbolInput, connection?.deviceId ?? null);
    const quotes = await this.deps.market.getQuotes(context.mode, context.userId, [symbol.symbol], connection?.deviceId ?? null);
    const quote = quotes.find((q) => q.symbol === symbol.symbol) ?? quotes[0];
    if (!quote) {
      throw new TradePilotError(
        context.mode === 'LIVE' ? ErrorCode.MT5_OFFLINE : ErrorCode.NO_QUOTE,
        context.mode === 'LIVE'
          ? 'MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE'
          : `No quote available for ${symbol.canonical}.`,
        503,
      );
    }
    return { broker, account, symbol, quote };
  }

  private async resolveContextForTicket(
    context: OrderRequestContext,
    ticket: string,
    kind: 'position' | 'order',
  ): Promise<{
    broker: Awaited<ReturnType<BrokerRegistry['forAccount']>>;
    account: BrokerAccountRow;
    symbol: Awaited<ReturnType<MarketService['getSymbolSpec']>>;
    quote: Quote | null;
  }> {
    const { broker, account } = await this.deps.brokers.forMode(context.userId, context.mode);
    const row =
      kind === 'position'
        ? await this.store.positions.findOne({ accountId: { eq: account.id }, ticket: { eq: ticket } })
        : await this.store.orders.findOne({ accountId: { eq: account.id }, ticket: { eq: ticket } });
    if (!row) {
      throw new TradePilotError(
        kind === 'position' ? ErrorCode.POSITION_NOT_FOUND : ErrorCode.ORDER_NOT_FOUND,
        `${kind === 'position' ? 'Position' : 'Pending order'} ${ticket} was not found on this account.`,
        404,
      );
    }
    const connection = context.mode === 'LIVE' ? await this.deps.devices.connectionForAccount(account.id) : null;
    const symbol = await this.deps.market.getSymbolSpec(context.mode, context.userId, row.symbol, connection?.deviceId ?? null);
    const quotes = await this.deps.market.getQuotes(context.mode, context.userId, [row.symbol], connection?.deviceId ?? null);
    return { broker, account, symbol, quote: quotes[0] ?? null };
  }

  /**
   * Idempotency: a repeated `clientRequestId` returns the original result
   * instead of sending a second order to the broker.
   */
  private async findIdempotentResult(userId: string, scope: string, key: string): Promise<OrderResult | null> {
    const row = await this.store.idempotencyKeys.findOne({
      userId: { eq: userId },
      scope: { eq: scope },
      key: { eq: key },
      expiresAt: { gt: new Date().toISOString() },
    });
    if (!row) return null;
    return row.response as unknown as OrderResult;
  }

  private async rememberResult(userId: string, scope: string, key: string, result: OrderResult): Promise<void> {
    const now = Date.now();
    await this.store.idempotencyKeys.insert({
      id: newId('idm'),
      userId,
      scope,
      key,
      response: result as unknown as Record<string, unknown>,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    }).catch(() => undefined);
  }

  /** Candles for the charts, routed to the correct source. */
  async candles(
    context: OrderRequestContext,
    symbol: string,
    timeframe: Parameters<MarketService['getCandles']>[3],
    count: number,
  ): Promise<Candle[]> {
    const { account } = await this.deps.brokers.forMode(context.userId, context.mode);
    const connection = context.mode === 'LIVE' ? await this.deps.devices.connectionForAccount(account.id) : null;
    return this.deps.market.getCandles(context.mode, context.userId, canonicalize(symbol), timeframe, count, async (sym, tf, n) => {
      const broker = await this.deps.brokers.forAccount(context.userId, account);
      const spec = await this.deps.market.getSymbolSpec('LIVE', context.userId, sym, connection?.deviceId ?? null).catch(() => null);
      return broker.getCandles(spec?.symbol ?? sym, tf, n);
    });
  }
}

/** Wrap a broker call so both success and failure land in the audit log. */
async function withAudit(
  action: () => Promise<ExecutionReport>,
  context: OrderRequestContext,
  auditAction: string,
  symbol: string,
  commandId: string,
  audit: AuditService,
  extra?: { volume?: number | null; price?: number | null; detail?: Record<string, unknown> },
): Promise<ExecutionReport> {
  try {
    const report = await action();
    await audit.record({
      userId: context.userId,
      mode: context.mode,
      action: auditAction,
      symbol: symbol || null,
      volume: report.volume ?? extra?.volume ?? null,
      price: report.executionPrice ?? extra?.price ?? null,
      brokerTicket: report.ticket,
      result: report.success ? 'SUCCESS' : 'FAILURE',
      errorCode: report.errorCode,
      errorMessage: report.errorMessage,
      ip: context.ip,
      userAgent: context.userAgent,
      deviceId: context.deviceId ?? null,
      commandId,
      detail: { affected: report.affected ?? 1, realizedPl: report.realizedPl ?? null, ...(extra?.detail ?? {}) },
    });
    return report;
  } catch (error) {
    const tpError = error instanceof TradePilotError ? error : new TradePilotError(ErrorCode.EXECUTION_FAILED, (error as Error).message, 502);
    await audit.record({
      userId: context.userId,
      mode: context.mode,
      action: auditAction,
      symbol: symbol || null,
      volume: extra?.volume ?? null,
      price: extra?.price ?? null,
      result: 'FAILURE',
      errorCode: tpError.code,
      errorMessage: tpError.message,
      ip: context.ip,
      userAgent: context.userAgent,
      deviceId: context.deviceId ?? null,
      commandId,
      detail: extra?.detail ?? null,
    });
    throw tpError;
  }
}

export type { UserRow };
