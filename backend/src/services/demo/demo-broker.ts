/**
 * TradePilot — DemoBroker.
 *
 * The built-in paper-trading implementation of `TradingBroker`. It behaves like
 * a real broker terminal (fills at bid/ask, charges commission, honours stops
 * levels, triggers SL/TP and pending orders on every tick) but it never touches
 * a broker, a network or real money.
 *
 * Design notes
 * ------------
 * • The demo book (positions/orders/trades) lives in the same tables the live
 *   bridge writes to, so the UI, risk engine, analytics and audit log have one
 *   code path for DEMO and LIVE.
 * • Everything created here is tagged `source: 'DEMO_SIMULATED'` and
 *   `mode: 'DEMO'`. Demo and live positions are never mixed: every read filters
 *   by account id.
 * • Prices come from MarketSimulator and are explicitly labelled simulated.
 */

import {
  ErrorCode,
  TradePilotError,
  calculatePositionPl,
  canonicalize,
  normalizeVolume,
  round,
  roundPrice,
  validateOrder,
  validateStopModification,
  type Candle,
  type OrderSide,
  type Position,
  type Quote,
  type SymbolInfo,
  type Timeframe,
  type TradeRecord,
  type PendingOrder,
  type BrokerAccount,
} from '@tradepilot/shared';
import type {
  BrokerContext,
  CancelOrderRequest,
  CloseAllPositionsRequest,
  ClosePositionRequest,
  ExecutionReport,
  ModifyOrderRequest,
  ModifyPositionRequest,
  PlaceMarketOrderRequest,
  PlacePendingOrderRequest,
  TradingBroker,
} from '@tradepilot/shared';
import type { Store } from '../../db/types';
import type { BrokerAccountRow, OrderRow, PositionRow, TradeRow } from '../../db/types';
import { newId, numericTicket } from '../../lib/ids';
import { MarketSimulator, type SimulatedQuote } from './market-simulator';
import { simulatedQuoteToQuote, simulatedQuoteToSymbolInfo } from '../market/converters';
import { demoProfile } from './profiles';

export const CLOSE_ALL_CONFIRMATION = 'CONFIRM CLOSE ALL';

export interface DemoBrokerOptions {
  store: Store;
  simulator: MarketSimulator;
  context: BrokerContext;
  account: BrokerAccountRow;
}

const MAGIC_DEMO = 700_100;

export class DemoBroker implements TradingBroker {
  readonly kind = 'DEMO' as const;
  readonly mode = 'DEMO' as const;
  readonly context: BrokerContext;

  constructor(private readonly options: DemoBrokerOptions) {
    this.context = options.context;
  }

  private get store(): Store {
    return this.options.store;
  }

  private get simulator(): MarketSimulator {
    return this.options.simulator;
  }

  private get account(): BrokerAccountRow {
    return this.options.account;
  }

  async isAvailable(): Promise<boolean> {
    return this.simulator.isRunning() || this.simulator.listSymbols().length > 0;
  }

  unavailableReason(): string | null {
    if (!this.simulator.listSymbols().length) return 'Demo market simulator is not initialised.';
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* read side                                                           */
  /* ------------------------------------------------------------------ */

  async getAccount(): Promise<BrokerAccount> {
    const positions = await this.rawPositions();
    const openPl = round(
      positions.reduce((acc, p) => acc + p.profit, 0),
      2,
    );
    const margin = round(
      positions.reduce((acc, p) => acc + this.marginForRow(p), 0),
      2,
    );
    const equity = round(this.account.balance + openPl, 2);
    return {
      id: this.account.id,
      userId: this.account.userId,
      mode: 'DEMO',
      login: this.account.login,
      server: this.account.server,
      currency: this.account.currency,
      leverage: this.account.leverage,
      balance: round(this.account.balance, 2),
      equity,
      margin,
      freeMargin: round(equity - margin, 2),
      marginLevel: margin > 0 ? round((equity / margin) * 100, 2) : null,
      profit: openPl,
      lastUpdate: new Date().toISOString(),
      isAuthorized: true,
    };
  }

  async getSymbolInfo(symbol?: string): Promise<SymbolInfo[]> {
    const canonical = symbol ? canonicalize(symbol) : null;
    const quotes = this.simulator.quotes();
    return quotes
      .filter((q) => !canonical || q.canonical === canonical)
      .map((q) => simulatedQuoteToSymbolInfo(q));
  }

  async getQuote(symbols: string[]): Promise<Quote[]> {
    const wanted = new Set(symbols.map((s) => canonicalize(s)));
    return this.simulator
      .quotes()
      .filter((q) => wanted.size === 0 || wanted.has(q.canonical))
      .map((q) => simulatedQuoteToQuote(q));
  }

  async getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    return this.simulator.candles(canonicalize(symbol), timeframe, count);
  }

  private async rawPositions(): Promise<PositionRow[]> {
    return this.store.positions.findMany({ accountId: { eq: this.account.id } });
  }

  async getPositions(): Promise<Position[]> {
    const rows = await this.rawPositions();
    return rows.map((row) => this.toPosition(row));
  }

  async getOrders(): Promise<PendingOrder[]> {
    const rows = await this.store.orders.findMany({
      accountId: { eq: this.account.id },
      status: { eq: 'PENDING' },
    });
    return rows.map((row) => this.toOrder(row));
  }

  async getHistory(from: Date, to: Date): Promise<TradeRecord[]> {
    const rows = await this.store.trades.findMany({
      accountId: { eq: this.account.id },
      closeTime: { gte: from.toISOString(), lte: to.toISOString() },
    });
    return rows.map((row) => this.toTrade(row));
  }

  /* ------------------------------------------------------------------ */
  /* write side                                                          */
  /* ------------------------------------------------------------------ */

  async placeMarketOrder(request: PlaceMarketOrderRequest): Promise<ExecutionReport> {
    const canonical = canonicalize(request.symbol);
    const quote = this.quoteFor(canonical);
    if (!quote) this.fail(ErrorCode.SYMBOL_NOT_FOUND, `Unknown symbol ${request.symbol}.`, request.clientRequestId);
    if (!quote.marketOpen) this.fail(ErrorCode.MARKET_CLOSED, 'Market is currently closed.', request.clientRequestId);

    const symbolInfo = simulatedQuoteToSymbolInfo(quote);
    const price = request.side === 'BUY' ? quote.ask : quote.bid;

    const validation = validateOrder({
      symbol: symbolInfo,
      side: request.side,
      type: 'MARKET',
      volume: request.volume,
      marketPrice: price,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      leverage: this.account.leverage,
      freeMargin: (await this.getAccount()).freeMargin,
    });
    if (!validation.valid) {
      const first = validation.errors[0];
      this.fail(first.code, first.message, request.clientRequestId, first.code);
    }
    if (validation.warnings.length) {
      // Warnings are returned but never block execution (e.g. R:R below 1:1).
    }

    const volume = validation.normalizedVolume;
    const commission = round((demoProfile(canonical)?.commissionPerLot ?? 0) / 2 * volume, 2);
    const ticket = numericTicket(`${this.account.id}:${request.clientRequestId}`);
    const now = new Date().toISOString();
    const riskAmount = this.riskAmountForRow(symbolInfo, volume, price, request.stopLoss ?? null);

    const row: PositionRow = {
      id: newId('pos'),
      userId: this.context.userId,
      accountId: this.account.id,
      mode: 'DEMO',
      ticket,
      brokerTicket: null,
      symbol: quote.symbol,
      canonical,
      side: request.side,
      volume,
      openPrice: price,
      currentPrice: price,
      stopLoss: request.stopLoss != null ? roundPrice(request.stopLoss, quote.digits) : null,
      takeProfit: request.takeProfit != null ? roundPrice(request.takeProfit, quote.digits) : null,
      swap: 0,
      commission,
      profit: 0,
      profitPercent: 0,
      magic: MAGIC_DEMO,
      comment: request.comment ?? 'TradePilot demo',
      origin: request.origin ?? 'MANUAL',
      strategyId: request.strategyId ?? null,
      riskAmount,
      accountLogin: this.account.login,
      openTime: now,
      updatedAt: now,
      source: 'DEMO_SIMULATED',
      meta: { clientRequestId: request.clientRequestId, spread: quote.spread },
    };

    await this.store.positions.insert(row);
    // Commission is charged on open (half of the round-turn fee), as MT5 does.
    await this.store.brokerAccounts.update(this.account.id, { balance: round(this.account.balance - commission, 2) });
    this.options.account.balance = round(this.account.balance - commission, 2);

    return {
      commandId: request.clientRequestId,
      idempotencyKey: request.clientRequestId,
      success: true,
      ticket,
      executionPrice: price,
      volume,
      errorCode: null,
      errorMessage: null,
      at: now,
      affected: 1,
      realizedPl: null,
    };
  }

  async placePendingOrder(request: PlacePendingOrderRequest): Promise<ExecutionReport> {
    const canonical = canonicalize(request.symbol);
    const quote = this.quoteFor(canonical);
    if (!quote) this.fail(ErrorCode.SYMBOL_NOT_FOUND, `Unknown symbol ${request.symbol}.`, request.clientRequestId);
    if (!quote.marketOpen) this.fail(ErrorCode.MARKET_CLOSED, 'Market is currently closed.', request.clientRequestId);

    const symbolInfo = simulatedQuoteToSymbolInfo(quote);
    const referencePrice = request.side === 'BUY' ? quote.ask : quote.bid;
    const validation = validateOrder({
      symbol: symbolInfo,
      side: request.side,
      type: request.type,
      volume: request.volume,
      marketPrice: referencePrice,
      price: request.price,
      stopLimitPrice: request.stopLimitPrice ?? null,
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
      expiration: request.expiration ?? null,
      leverage: this.account.leverage,
      freeMargin: (await this.getAccount()).freeMargin,
    });
    if (!validation.valid) {
      const first = validation.errors[0];
      this.fail(first.code, first.message, request.clientRequestId, first.code);
    }

    const ticket = numericTicket(`${this.account.id}:${request.clientRequestId}`);
    const now = new Date().toISOString();
    const row: OrderRow = {
      id: newId('ord'),
      userId: this.context.userId,
      accountId: this.account.id,
      mode: 'DEMO',
      ticket,
      brokerTicket: null,
      symbol: quote.symbol,
      canonical,
      side: request.side,
      type: request.type,
      volume: validation.normalizedVolume,
      price: roundPrice(request.price, quote.digits),
      stopLimitPrice: request.stopLimitPrice != null ? roundPrice(request.stopLimitPrice, quote.digits) : null,
      stopLoss: request.stopLoss != null ? roundPrice(request.stopLoss, quote.digits) : null,
      takeProfit: request.takeProfit != null ? roundPrice(request.takeProfit, quote.digits) : null,
      expiration: request.expiration ?? null,
      status: 'PENDING',
      comment: request.comment ?? 'TradePilot demo',
      magic: MAGIC_DEMO,
      origin: request.origin ?? 'MANUAL',
      strategyId: request.strategyId ?? null,
      clientRequestId: request.clientRequestId,
      commandId: null,
      placedAt: now,
      updatedAt: now,
      closedAt: null,
      source: 'DEMO_SIMULATED',
    };
    await this.store.orders.insert(row);

    return {
      commandId: request.clientRequestId,
      idempotencyKey: request.clientRequestId,
      success: true,
      ticket,
      executionPrice: row.price,
      volume: row.volume,
      errorCode: null,
      errorMessage: null,
      at: now,
      affected: 1,
      realizedPl: null,
    };
  }

  async modifyPosition(request: ModifyPositionRequest): Promise<ExecutionReport> {
    const row = await this.store.positions.findOne({ accountId: { eq: this.account.id }, ticket: { eq: request.ticket } });
    if (!row) this.fail(ErrorCode.POSITION_NOT_FOUND, `Position ${request.ticket} not found on the demo account.`, request.clientRequestId);

    const quote = this.quoteFor(row.canonical);
    if (!quote) this.fail(ErrorCode.SYMBOL_NOT_FOUND, `Unknown symbol ${row.symbol}.`, request.clientRequestId);

    const symbolInfo = simulatedQuoteToSymbolInfo(quote);
    const stopLoss = request.stopLoss === undefined ? row.stopLoss : request.stopLoss;
    const takeProfit = request.takeProfit === undefined ? row.takeProfit : request.takeProfit;
    const validation = validateStopModification(symbolInfo, row.side as OrderSide, row.openPrice, stopLoss, takeProfit);
    if (!validation.valid) {
      const first = validation.errors[0];
      this.fail(first.code, first.message, request.clientRequestId, first.code);
    }

    const updated = await this.store.positions.update(row.id, {
      stopLoss: stopLoss != null ? roundPrice(stopLoss, quote.digits) : null,
      takeProfit: takeProfit != null ? roundPrice(takeProfit, quote.digits) : null,
      updatedAt: new Date().toISOString(),
    });

    return {
      commandId: request.clientRequestId,
      idempotencyKey: request.clientRequestId,
      success: true,
      ticket: request.ticket,
      executionPrice: updated?.currentPrice ?? row.currentPrice,
      volume: row.volume,
      errorCode: null,
      errorMessage: null,
      at: new Date().toISOString(),
      affected: 1,
      realizedPl: null,
    };
  }

  async modifyOrder(request: ModifyOrderRequest): Promise<ExecutionReport> {
    const row = await this.store.orders.findOne({ accountId: { eq: this.account.id }, ticket: { eq: request.ticket } });
    if (!row) this.fail(ErrorCode.ORDER_NOT_FOUND, `Pending order ${request.ticket} not found.`, request.clientRequestId);
    if (row.status !== 'PENDING') this.fail(ErrorCode.ORDER_NOT_FOUND, `Order ${request.ticket} is ${row.status}.`, request.clientRequestId);

    const quote = this.quoteFor(row.canonical);
    if (!quote) this.fail(ErrorCode.SYMBOL_NOT_FOUND, `Unknown symbol ${row.symbol}.`, request.clientRequestId);

    const symbolInfo = simulatedQuoteToSymbolInfo(quote);
    const price = request.price ?? row.price;
    const validation = validateOrder({
      symbol: symbolInfo,
      side: row.side as OrderSide,
      type: row.type as 'LIMIT' | 'STOP' | 'STOP_LIMIT',
      volume: row.volume,
      marketPrice: row.side === 'BUY' ? quote.ask : quote.bid,
      price,
      stopLimitPrice: row.stopLimitPrice,
      stopLoss: request.stopLoss === undefined ? row.stopLoss : request.stopLoss,
      takeProfit: request.takeProfit === undefined ? row.takeProfit : request.takeProfit,
      expiration: request.expiration === undefined ? row.expiration : request.expiration,
    });
    if (!validation.valid) {
      const first = validation.errors[0];
      this.fail(first.code, first.message, request.clientRequestId, first.code);
    }

    await this.store.orders.update(row.id, {
      price: roundPrice(price, quote.digits),
      stopLoss: (request.stopLoss === undefined ? row.stopLoss : request.stopLoss) as number | null,
      takeProfit: (request.takeProfit === undefined ? row.takeProfit : request.takeProfit) as number | null,
      expiration: request.expiration === undefined ? row.expiration : request.expiration,
      updatedAt: new Date().toISOString(),
    });

    return {
      commandId: request.clientRequestId,
      idempotencyKey: request.clientRequestId,
      success: true,
      ticket: request.ticket,
      executionPrice: price,
      volume: row.volume,
      errorCode: null,
      errorMessage: null,
      at: new Date().toISOString(),
      affected: 1,
    };
  }

  async closePosition(request: ClosePositionRequest): Promise<ExecutionReport> {
    const row = await this.store.positions.findOne({ accountId: { eq: this.account.id }, ticket: { eq: request.ticket } });
    if (!row) this.fail(ErrorCode.POSITION_NOT_FOUND, `Position ${request.ticket} not found on the demo account.`, request.clientRequestId);

    const quote = this.quoteFor(row.canonical);
    if (!quote) this.fail(ErrorCode.SYMBOL_NOT_FOUND, `Unknown symbol ${row.symbol}.`, request.clientRequestId);

    const volume = request.volume && request.volume > 0 ? Math.min(request.volume, row.volume) : row.volume;
    const closePrice = row.side === 'BUY' ? quote.bid : quote.ask;
    const symbolInfo = simulatedQuoteToSymbolInfo(quote);
    const profit = calculatePositionPl(row.side as OrderSide, row.openPrice, closePrice, volume, symbolInfo);
    const profile = demoProfile(row.canonical);
    const commission = round(((profile?.commissionPerLot ?? 0) / 2) * volume, 2);
    const swap = round((row.swap / Math.max(row.volume, 1e-9)) * volume, 2);
    const net = round(profit - commission + swap, 2);
    const now = new Date().toISOString();

    await this.store.trades.insert({
      id: newId('trd'),
      userId: this.context.userId,
      accountId: this.account.id,
      mode: 'DEMO',
      ticket: row.ticket,
      dealTicket: numericTicket(`${row.ticket}:${now}`),
      symbol: row.symbol,
      canonical: row.canonical,
      side: row.side,
      volume,
      entryPrice: row.openPrice,
      exitPrice: closePrice,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      commission: round(row.commission + commission, 2),
      swap,
      grossProfit: profit,
      netProfit: net,
      openTime: row.openTime,
      closeTime: now,
      durationSeconds: Math.max(0, Math.round((Date.parse(now) - Date.parse(row.openTime)) / 1000)),
      magic: row.magic,
      comment: request.reason ?? row.comment,
      origin: row.origin,
      strategyId: row.strategyId,
      accountLogin: this.account.login,
      source: 'DEMO_SIMULATED',
      createdAt: now,
    });

    const newBalance = round(this.account.balance + net, 2);
    await this.store.brokerAccounts.update(this.account.id, { balance: newBalance });
    this.options.account.balance = newBalance;

    if (volume >= row.volume || Math.abs(volume - row.volume) < 1e-9) {
      await this.store.positions.delete(row.id);
    } else {
      await this.store.positions.update(row.id, { volume: round(row.volume - volume, 2), updatedAt: now });
    }

    return {
      commandId: request.clientRequestId,
      idempotencyKey: request.clientRequestId,
      success: true,
      ticket: row.ticket,
      executionPrice: closePrice,
      volume,
      errorCode: null,
      errorMessage: null,
      at: now,
      affected: 1,
      realizedPl: net,
    };
  }

  async closeAllPositions(request: CloseAllPositionsRequest): Promise<ExecutionReport> {
    if ((request.confirm ?? '').trim().toUpperCase() !== CLOSE_ALL_CONFIRMATION) {
      this.fail(
        ErrorCode.CONFIRMATION_MISMATCH,
        `Closing all positions requires the exact confirmation text "${CLOSE_ALL_CONFIRMATION}".`,
        request.clientRequestId,
      );
    }

    const rows = await this.rawPositions();
    const targets = request.symbol ? rows.filter((r) => r.canonical === canonicalize(request.symbol!)) : rows;
    let realized = 0;
    let affected = 0;
    const failures: string[] = [];

    for (const row of targets) {
      try {
        const report = await this.closePosition({
          ticket: row.ticket,
          reason: request.reason ?? 'Close all positions',
          clientRequestId: `${request.clientRequestId}:${row.ticket}`,
        });
        realized = round(realized + (report.realizedPl ?? 0), 2);
        affected += 1;
      } catch (error) {
        failures.push(`${row.ticket}: ${(error as Error).message}`);
      }
    }

    return {
      commandId: request.clientRequestId,
      idempotencyKey: request.clientRequestId,
      success: failures.length === 0,
      ticket: null,
      executionPrice: null,
      volume: null,
      errorCode: failures.length ? ErrorCode.EXECUTION_FAILED : null,
      errorMessage: failures.length ? failures.join(' | ') : null,
      at: new Date().toISOString(),
      affected,
      realizedPl: realized,
    };
  }

  async cancelOrder(request: CancelOrderRequest): Promise<ExecutionReport> {
    const row = await this.store.orders.findOne({ accountId: { eq: this.account.id }, ticket: { eq: request.ticket } });
    if (!row) this.fail(ErrorCode.ORDER_NOT_FOUND, `Pending order ${request.ticket} not found.`, request.clientRequestId);
    if (row.status !== 'PENDING') this.fail(ErrorCode.ORDER_NOT_FOUND, `Order ${request.ticket} is ${row.status}.`, request.clientRequestId);

    const now = new Date().toISOString();
    await this.store.orders.update(row.id, { status: 'CANCELLED', closedAt: now, updatedAt: now });
    return {
      commandId: request.clientRequestId,
      idempotencyKey: request.clientRequestId,
      success: true,
      ticket: request.ticket,
      executionPrice: null,
      volume: row.volume,
      errorCode: null,
      errorMessage: null,
      at: now,
      affected: 1,
    };
  }

  /* ------------------------------------------------------------------ */
  /* tick processing (broker-side events)                                */
  /* ------------------------------------------------------------------ */

  /**
   * Called by the demo engine on every simulator tick. Reproduces what a broker
   * does server-side: mark-to-market, stop-out, pending-order triggering.
   * Returns the events so the engine can broadcast them over the WebSocket.
   */
  async processTick(quotes: SimulatedQuote[]): Promise<{
    updated: PositionRow[];
    closed: { row: PositionRow; trade: TradeRecord; reason: string }[];
    filled: { order: OrderRow; position: PositionRow }[];
  }> {
    const byCanonical = new Map(quotes.map((q) => [q.canonical, q]));
    const positions = await this.rawPositions();
    const updated: PositionRow[] = [];
    const closed: { row: PositionRow; trade: TradeRecord; reason: string }[] = [];
    const filled: { order: OrderRow; position: PositionRow }[] = [];

    for (const row of positions) {
      const quote = byCanonical.get(row.canonical);
      if (!quote) continue;
      const symbolInfo = simulatedQuoteToSymbolInfo(quote);
      const current = row.side === 'BUY' ? quote.bid : quote.ask;
      const profit = calculatePositionPl(row.side as OrderSide, row.openPrice, current, row.volume, symbolInfo);
      const profitPercent = row.riskAmount > 0 ? round((profit / row.riskAmount) * 100, 2) : 0;

      const hitSl = row.stopLoss != null && (row.side === 'BUY' ? current <= row.stopLoss : current >= row.stopLoss);
      const hitTp = row.takeProfit != null && (row.side === 'BUY' ? current >= row.takeProfit : current <= row.takeProfit);

      if (hitSl || hitTp) {
        const reason = hitSl ? 'Stop Loss' : 'Take Profit';
        try {
          const report = await this.closePosition({
            ticket: row.ticket,
            reason,
            clientRequestId: `autoclose:${row.ticket}:${reason}`,
          });
          const tradeRow = await this.store.trades.findOne({ accountId: { eq: this.account.id }, ticket: { eq: row.ticket } });
          if (tradeRow) {
            closed.push({ row, trade: this.toTrade(tradeRow), reason });
          }
        } catch {
          // If closing fails we keep the position; the next tick retries.
        }
        continue;
      }

      const patch: Partial<PositionRow> = {
        currentPrice: current,
        profit,
        profitPercent,
        updatedAt: new Date().toISOString(),
      };
      const next = await this.store.positions.update(row.id, patch);
      if (next) updated.push(next);
    }

    // Pending order triggering ------------------------------------------------
    const orders = await this.store.orders.findMany({ accountId: { eq: this.account.id }, status: { eq: 'PENDING' } });
    for (const order of orders) {
      const quote = byCanonical.get(order.canonical);
      if (!quote) continue;
      if (order.expiration && Date.parse(order.expiration) <= Date.now()) {
        await this.store.orders.update(order.id, { status: 'EXPIRED', closedAt: new Date().toISOString() });
        continue;
      }
      const ask = quote.ask;
      const bid = quote.bid;
      let trigger = false;
      switch (order.type) {
        case 'LIMIT':
          trigger = order.side === 'BUY' ? ask <= order.price : bid >= order.price;
          break;
        case 'STOP':
          trigger = order.side === 'BUY' ? ask >= order.price : bid <= order.price;
          break;
        case 'STOP_LIMIT':
          // Two-stage: the stop level must be touched before the limit becomes active.
          trigger = order.side === 'BUY' ? ask >= order.price : bid <= order.price;
          break;
        default:
          trigger = false;
      }
      if (!trigger) continue;

      const symbolInfo = simulatedQuoteToSymbolInfo(quote);
      const fillPrice = order.type === 'LIMIT' || (order.type === 'STOP_LIMIT' && order.stopLimitPrice != null)
        ? order.type === 'LIMIT'
          ? order.price
          : (order.stopLimitPrice ?? order.price)
        : order.side === 'BUY'
          ? ask
          : bid;
      const now = new Date().toISOString();
      const positionRow: PositionRow = {
        id: newId('pos'),
        userId: order.userId,
        accountId: this.account.id,
        mode: 'DEMO',
        ticket: numericTicket(`${order.ticket}:filled`),
        brokerTicket: null,
        symbol: order.symbol,
        canonical: order.canonical,
        side: order.side,
        volume: order.volume,
        openPrice: roundPrice(fillPrice, quote.digits),
        currentPrice: roundPrice(fillPrice, quote.digits),
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        swap: 0,
        commission: round(((demoProfile(order.canonical)?.commissionPerLot ?? 0) / 2) * order.volume, 2),
        profit: 0,
        profitPercent: 0,
        magic: order.magic,
        comment: `${order.comment ?? 'TradePilot demo'} (pending fill)`,
        origin: order.origin,
        strategyId: order.strategyId,
        riskAmount: this.riskAmountForRow(symbolInfo, order.volume, fillPrice, order.stopLoss),
        accountLogin: this.account.login,
        openTime: now,
        updatedAt: now,
        source: 'DEMO_SIMULATED',
        meta: { filledFrom: order.ticket },
      };
      await this.store.positions.insert(positionRow);
      await this.store.orders.update(order.id, { status: 'FILLED', closedAt: now, updatedAt: now, brokerTicket: positionRow.ticket });
      filled.push({ order, position: positionRow });
    }

    return { updated, closed, filled };
  }

  /** Simulator handle for the engine's quote stream. */
  getSimulator(): MarketSimulator {
    return this.simulator;
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  private quoteFor(canonical: string): SimulatedQuote | null {
    return this.simulator.quote(canonical);
  }

  private marginForRow(row: PositionRow): number {
    const currency = this.account.currency;
    const leverage = this.account.leverage > 0 ? this.account.leverage : 100;
    const notional = row.volume * this.symbolContractSize(row.canonical) * row.currentPrice;
    const inQuote = notional / leverage;
    const profile = demoProfile(row.canonical);
    if (!profile || profile.quoteCurrency === currency) return round(inQuote, 2);
    // Convert through the simulated FX rate (approximation, demo only).
    const priceMap = new Map<string, number>();
    for (const q of this.simulator.quotes()) priceMap.set(q.canonical, q.close);
    const rate = profile.quoteCurrency === 'USD' ? 1 : 1 / (priceMap.get(`USD${profile.quoteCurrency}`) ?? 1);
    return round(inQuote * rate, 2);
  }

  private symbolContractSize(canonical: string): number {
    return demoProfile(canonical)?.contractSize ?? 100_000;
  }

  private riskAmountForRow(symbolInfo: SymbolInfo, volume: number, price: number, stopLoss: number | null): number {
    if (stopLoss == null) {
      return round(volume * symbolInfo.contractSize * price, 2);
    }
    const distance = Math.abs(price - stopLoss);
    const ticks = symbolInfo.tickSize > 0 ? distance / symbolInfo.tickSize : 0;
    return round(ticks * symbolInfo.tickValueLoss * volume, 2);
  }

  private toPosition(row: PositionRow): Position {
    return {
      id: row.id,
      accountId: row.accountId,
      mode: row.mode,
      ticket: row.ticket,
      symbol: row.symbol,
      canonical: row.canonical,
      side: row.side,
      volume: row.volume,
      openPrice: row.openPrice,
      currentPrice: row.currentPrice,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      swap: row.swap,
      commission: row.commission,
      profit: row.profit,
      profitPercent: row.profitPercent,
      magic: row.magic,
      comment: row.comment,
      openTime: row.openTime,
      updatedAt: row.updatedAt,
      origin: row.origin,
      strategyId: row.strategyId,
      accountLogin: row.accountLogin,
      source: row.source,
    };
  }

  private toOrder(row: OrderRow): PendingOrder {
    return {
      id: row.id,
      accountId: row.accountId,
      mode: row.mode,
      ticket: row.ticket,
      symbol: row.symbol,
      canonical: row.canonical,
      type: row.type,
      side: row.side,
      volume: row.volume,
      price: row.price,
      stopLimitPrice: row.stopLimitPrice,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      expiration: row.expiration,
      status: row.status,
      placedAt: row.placedAt,
      comment: row.comment,
      magic: row.magic,
      accountLogin: '',
      source: row.source,
    };
  }

  private toTrade(row: TradeRow): TradeRecord {
    return {
      id: row.id,
      accountId: row.accountId,
      mode: row.mode,
      ticket: row.ticket,
      dealTicket: row.dealTicket,
      symbol: row.symbol,
      canonical: row.canonical,
      side: row.side,
      volume: row.volume,
      entryPrice: row.entryPrice,
      exitPrice: row.exitPrice,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      commission: row.commission,
      swap: row.swap,
      grossProfit: row.grossProfit,
      netProfit: row.netProfit,
      openTime: row.openTime,
      closeTime: row.closeTime,
      durationSeconds: row.durationSeconds,
      magic: row.magic,
      comment: row.comment,
      origin: row.origin,
      strategyId: row.strategyId,
      accountLogin: row.accountLogin,
      source: row.source,
    };
  }

  private fail(code: string, message: string, clientRequestId: string, errorCode?: string): never {
    throw new TradePilotError(code, message, 400, {
      meta: { commandId: clientRequestId, errorCode: errorCode ?? code },
    });
  }

  /** Exposed for tests: turn an arbitrary simulated price into a quote. */
  static normalizeVolumeFor(volume: number, step: number, digits?: number): number {
    return normalizeVolume(volume, step, digits);
  }
}
