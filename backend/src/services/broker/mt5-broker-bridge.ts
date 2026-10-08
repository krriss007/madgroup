/**
 * TradePilot — MT5BrokerBridge.
 *
 * Implements `TradingBroker` for LIVE accounts by routing every operation to
 * the user's own MT5 terminal through the TradePilotBridge.mq5 Expert Advisor.
 *
 * The web layer never sees broker credentials: the EA is authenticated with a
 * device token and the terminal owns the broker session. If the EA is not
 * connected, every method fails fast with MT5_OFFLINE and trading stays
 * disabled — no order is ever assumed or faked.
 */

import {
  ErrorCode,
  TradePilotError,
  type BrokerAccount,
  type Candle,
  type ExecutionReport,
  type OrderSide,
  type PendingOrder,
  type Position,
  type Quote,
  type SymbolInfo,
  type Timeframe,
  type TradeRecord,
} from '@tradepilot/shared';
import type {
  BrokerContext,
  CancelOrderRequest,
  CloseAllPositionsRequest,
  ClosePositionRequest,
  ModifyOrderRequest,
  ModifyPositionRequest,
  PlaceMarketOrderRequest,
  PlacePendingOrderRequest,
  TradingBroker,
} from '@tradepilot/shared';
import type { BridgeAction, EaAccountPayload, EaDealPayload, EaOrderPayload, EaPositionPayload } from '@tradepilot/shared';
import type { Store } from '../../db/types';
import type { Mt5ConnectionRow, PositionRow } from '../../db/types';
import type { DeviceService } from '../bridge/device.service';
import type { CommandQueueService } from '../bridge/command-queue.service';
import type { MarketService } from '../market.service';
import type { Logger } from '../../lib/logger';
import { newId } from '../../lib/ids';

export interface MT5BridgeOptions {
  store: Store;
  devices: DeviceService;
  queue: CommandQueueService;
  market: MarketService;
  logger: Logger;
  context: BrokerContext;
  connection: Mt5ConnectionRow;
}

/**
 * MT5 ORDER_TYPE_* → TradePilot pending order type.
 *
 * ORDER_TYPE_BUY_LIMIT(2) / ORDER_TYPE_SELL_LIMIT(3) are LIMIT orders: they wait
 * for price to come back to them. ORDER_TYPE_BUY_STOP(4) / ORDER_TYPE_SELL_STOP(5)
 * are STOP orders: they trigger when price breaks through. Mapping 3 to STOP (as
 * this table did) showed a broker-side sell limit as a stop order and, worse,
 * made a later modify send the wrong MT5 type back to the terminal.
 */
const PENDING_TYPE_MAP: Record<number, PendingOrder['type']> = {
  2: 'LIMIT', // ORDER_TYPE_BUY_LIMIT
  3: 'LIMIT', // ORDER_TYPE_SELL_LIMIT
  4: 'STOP', // ORDER_TYPE_BUY_STOP
  5: 'STOP', // ORDER_TYPE_SELL_STOP
  6: 'STOP_LIMIT', // ORDER_TYPE_BUY_STOP_LIMIT
  7: 'STOP_LIMIT', // ORDER_TYPE_SELL_STOP_LIMIT
};

const DEAL_ENTRY_IN = 0;
const DEAL_ENTRY_OUT = 1;
const DEAL_ENTRY_INOUT = 2;
const DEAL_ENTRY_OUT_BY = 3;

export class MT5BrokerBridge implements TradingBroker {
  readonly kind = 'MT5' as const;
  readonly mode = 'LIVE' as const;
  readonly context: BrokerContext;

  constructor(private readonly options: MT5BridgeOptions) {
    this.context = options.context;
  }

  private get connection(): Mt5ConnectionRow {
    return this.options.connection;
  }

  async isAvailable(): Promise<boolean> {
    const fresh = await this.options.devices.getConnectionById(this.connection.id);
    return this.options.devices.isOnline(fresh);
  }

  unavailableReason(): string | null {
    if (!this.options.devices.isOnline(this.connection)) {
      return 'MT5 is offline. Connect the TradePilotBridge EA and keep Algo Trading enabled.';
    }
    if (!this.connection.tradeAllowed) return 'The MT5 terminal reports that trading is not allowed for this account.';
    if (!this.connection.eaTradeAllowed) return 'Automated trading is disabled in MT5 (the EA is not allowed to trade).';
    return null;
  }

  private async assertOnline(): Promise<void> {
    const fresh = await this.options.devices.getConnectionById(this.connection.id);
    if (!this.options.devices.isOnline(fresh)) {
      throw new TradePilotError(
        ErrorCode.MT5_OFFLINE,
        'MT5 is offline. Live trading is disabled.',
        503,
        { meta: { deviceId: this.connection.deviceId, lastHeartbeat: fresh?.lastHeartbeat ?? null } },
      );
    }
    if (!fresh?.tradeAllowed) {
      throw new TradePilotError(ErrorCode.MT5_TRADE_DISABLED, 'The MT5 terminal reports trading is disabled for this account.', 409);
    }
  }

  /**
   * Send a command to the EA and wait for its verdict.
   * `expectData` keeps data commands and trading commands apart so callers can
   * never mistake an empty payload for a successful trade.
   */
  private async send(
    action: BridgeAction,
    symbol: string,
    parameters: Record<string, unknown>,
    idempotencyKey: string,
    expectData = false,
  ): Promise<{ report: ExecutionReport; data: Record<string, unknown> | null }> {
    await this.assertOnline();
    const queued = await this.options.queue.enqueue({
      userId: this.context.userId,
      accountId: this.context.accountId,
      deviceId: this.connection.deviceId,
      symbol,
      action,
      parameters,
      idempotencyKey,
    });

    const finished = await this.options.queue.awaitResult(queued.commandId);
    const payload = this.options.queue.toResultPayload(finished);
    const data = ((finished.result ?? {}) as { data?: Record<string, unknown> }).data ?? null;

    const report: ExecutionReport = {
      commandId: queued.commandId,
      idempotencyKey,
      success: payload.success,
      ticket: payload.brokerTicket != null ? String(payload.brokerTicket) : null,
      executionPrice: payload.executionPrice,
      volume: payload.volume,
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
      at: finished.completedAt ?? new Date().toISOString(),
      affected: 1,
      realizedPl: (data?.realized_pl as number | undefined) ?? null,
    };

    if (expectData && !report.success) {
      this.options.logger.warn({ action, errorCode: report.errorCode }, 'MT5 data command failed');
    }
    if (!expectData && !report.success) {
      throw new TradePilotError(
        report.errorCode ?? ErrorCode.EXECUTION_FAILED,
        report.errorMessage ?? 'The MT5 terminal rejected this order.',
        409,
        { meta: { commandId: report.commandId, retcode: (finished.result as { retcode?: number } | null)?.retcode ?? null } },
      );
    }

    return { report, data };
  }

  /* ------------------------------------------------------------------ */
  /* account & market data                                              */
  /* ------------------------------------------------------------------ */

  async getAccount(): Promise<BrokerAccount> {
    const { data } = await this.send('GET_ACCOUNT', '', {}, `account:${this.context.accountId}:${Date.now()}`, true);
    const payload = (data?.account ?? null) as EaAccountPayload | null;

    const row = await this.options.store.brokerAccounts.findById(this.context.accountId);
    if (!row) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Live account not found.', 404);

    if (!payload) {
      // Terminal did not answer with account data: report the last known state
      // but keep the timestamp honest.
      return {
        id: row.id,
        userId: row.userId,
        mode: 'LIVE',
        login: row.login,
        server: row.server,
        currency: row.currency,
        leverage: row.leverage,
        balance: row.balance,
        equity: row.equity,
        margin: row.margin,
        freeMargin: row.freeMargin,
        marginLevel: row.marginLevel,
        profit: row.profit,
        lastUpdate: row.lastUpdate,
        isAuthorized: row.isAuthorized,
      };
    }

    const updated = await this.options.store.brokerAccounts.update(row.id, {
      login: String(payload.login),
      server: payload.server,
      currency: payload.currency,
      leverage: payload.leverage,
      balance: payload.balance,
      equity: payload.equity,
      margin: payload.margin,
      freeMargin: payload.free_margin,
      marginLevel: payload.margin_level,
      profit: payload.profit,
      lastUpdate: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const final = updated ?? row;
    return {
      id: final.id,
      userId: final.userId,
      mode: 'LIVE',
      login: final.login,
      server: final.server,
      currency: final.currency,
      leverage: final.leverage,
      balance: final.balance,
      equity: final.equity,
      margin: final.margin,
      freeMargin: final.freeMargin,
      marginLevel: final.marginLevel,
      profit: final.profit,
      lastUpdate: final.lastUpdate,
      isAuthorized: final.isAuthorized,
    };
  }

  async getSymbolInfo(symbol?: string): Promise<SymbolInfo[]> {
    const cached = this.options.market.liveSymbolsFor(this.context.userId, this.connection.deviceId);
    if (cached.length) {
      if (!symbol) return cached;
      return cached.filter((s) => s.symbol === symbol || s.canonical === symbol);
    }
    const { data } = await this.send('GET_SYMBOL_INFO', symbol ?? '', symbol ? { symbol } : {}, `symbols:${Date.now()}`, true);
    const list = (data?.symbols ?? []) as never[];
    if (list.length) {
      await this.options.market.ingestSymbols(this.context.userId, this.connection.deviceId, this.connection.id, list);
    }
    return this.options.market.liveSymbolsFor(this.context.userId, this.connection.deviceId);
  }

  async getQuote(symbols: string[]): Promise<Quote[]> {
    const all = this.options.market.liveQuotesFor(this.context.userId, this.connection.deviceId);
    const wanted = new Set(symbols);
    return all.filter((q) => wanted.has(q.symbol) || wanted.has(q.canonical));
  }

  async getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const { data } = await this.send(
      'GET_CANDLES',
      symbol,
      { symbol, timeframe, count },
      `candles:${symbol}:${timeframe}:${Math.floor(Date.now() / 5_000)}`,
      true,
    );
    const rates = (data?.rates ?? []) as { time: string; open: number; high: number; low: number; close: number; volume: number }[];
    return rates
      .map((rate) => ({
        time: Math.floor(Date.parse(rate.time) / 1000),
        open: rate.open,
        high: rate.high,
        low: rate.low,
        close: rate.close,
        volume: rate.volume,
      }))
      .filter((candle) => Number.isFinite(candle.time))
      .sort((a, b) => a.time - b.time);
  }

  /* ------------------------------------------------------------------ */
  /* positions / orders / history                                       */
  /* ------------------------------------------------------------------ */

  async getPositions(): Promise<Position[]> {
    const { data } = await this.send('GET_POSITIONS', '', {}, `positions:${Date.now()}`, true);
    const list = (data?.positions ?? []) as EaPositionPayload[];
    return list.map((p) => this.mapPosition(p));
  }

  async getOrders(): Promise<PendingOrder[]> {
    const { data } = await this.send('GET_ORDERS', '', {}, `orders:${Date.now()}`, true);
    const list = (data?.orders ?? []) as EaOrderPayload[];
    return list.map((o) => this.mapOrder(o));
  }

  async getHistory(from: Date, to: Date): Promise<TradeRecord[]> {
    const { data } = await this.send(
      'GET_HISTORY',
      '',
      { from: from.toISOString(), to: to.toISOString() },
      `history:${from.toISOString()}:${to.toISOString()}`,
      true,
    );
    const deals = (data?.deals ?? []) as EaDealPayload[];
    return aggregateDeals(deals, this.context);
  }

  /* ------------------------------------------------------------------ */
  /* trading                                                            */
  /* ------------------------------------------------------------------ */

  async placeMarketOrder(request: PlaceMarketOrderRequest): Promise<ExecutionReport> {
    const { report } = await this.send(
      'OPEN_MARKET_ORDER',
      request.symbol,
      {
        side: request.side,
        volume: request.volume,
        stop_loss: request.stopLoss ?? null,
        take_profit: request.takeProfit ?? null,
        deviation_points: request.deviationPoints ?? 20,
        comment: request.comment ?? `TradePilot ${request.side}`,
        magic: 700_200,
        origin: request.origin ?? 'MANUAL',
        strategy_id: request.strategyId ?? null,
      },
      request.clientRequestId,
    );
    return report;
  }

  async placePendingOrder(request: PlacePendingOrderRequest): Promise<ExecutionReport> {
    const kind = `${request.side}_${request.type}`; // BUY_LIMIT, SELL_STOP, …
    const { report } = await this.send(
      'PLACE_PENDING_ORDER',
      request.symbol,
      {
        kind,
        volume: request.volume,
        price: request.price,
        stop_limit_price: request.stopLimitPrice ?? null,
        stop_loss: request.stopLoss ?? null,
        take_profit: request.takeProfit ?? null,
        expiration: request.expiration ?? null,
        comment: request.comment ?? `TradePilot ${kind}`,
        magic: 700_200,
      },
      request.clientRequestId,
    );
    return report;
  }

  async modifyPosition(request: ModifyPositionRequest): Promise<ExecutionReport> {
    const { report } = await this.send(
      'MODIFY_POSITION',
      '',
      {
        ticket: request.ticket,
        stop_loss: request.stopLoss ?? null,
        take_profit: request.takeProfit ?? null,
      },
      request.clientRequestId,
    );
    return report;
  }

  async modifyOrder(request: ModifyOrderRequest): Promise<ExecutionReport> {
    const { report } = await this.send(
      'MODIFY_ORDER',
      '',
      {
        ticket: request.ticket,
        price: request.price ?? null,
        stop_loss: request.stopLoss ?? null,
        take_profit: request.takeProfit ?? null,
        expiration: request.expiration ?? null,
      },
      request.clientRequestId,
    );
    return report;
  }

  async closePosition(request: ClosePositionRequest): Promise<ExecutionReport> {
    const { report } = await this.send(
      'CLOSE_POSITION',
      '',
      {
        ticket: request.ticket,
        volume: request.volume ?? null,
        deviation_points: 20,
        reason: request.reason ?? 'Close requested from TradePilot',
      },
      request.clientRequestId,
    );
    return report;
  }

  async closeAllPositions(request: CloseAllPositionsRequest): Promise<ExecutionReport> {
    const { report, data } = await this.send(
      'CLOSE_ALL_POSITIONS',
      request.symbol ?? '',
      {
        confirm: request.confirm,
        symbol: request.symbol ?? null,
        reason: request.reason ?? 'Emergency close-all from TradePilot',
      },
      request.clientRequestId,
    );
    return {
      ...report,
      affected: (data?.closed_count as number | undefined) ?? report.affected,
      realizedPl: (data?.realized_pl as number | undefined) ?? report.realizedPl ?? null,
      errorMessage: (data?.failures as string | undefined) ?? report.errorMessage,
    };
  }

  async cancelOrder(request: CancelOrderRequest): Promise<ExecutionReport> {
    const { report } = await this.send('CANCEL_ORDER', '', { ticket: request.ticket }, request.clientRequestId);
    return report;
  }

  /* ------------------------------------------------------------------ */
  /* mapping helpers                                                    */
  /* ------------------------------------------------------------------ */

  private mapPosition(payload: EaPositionPayload): Position {
    const side: OrderSide = payload.type === 0 ? 'BUY' : 'SELL';
    const canonical = this.canonicalFor(payload.symbol);
    // MT5 has no per-position margin property, so the payload carries none and
    // there is nothing to divide by. Rather than invent a base (account margin?
    // leverage guess?), the figure stays 0 and the UI shows P/L in currency
    // instead of a fabricated percentage.
    const profitPercent = 0;
    return {
      id: `mt5_${payload.ticket}`,
      accountId: this.context.accountId,
      mode: 'LIVE',
      ticket: String(payload.ticket),
      symbol: payload.symbol,
      canonical,
      side,
      volume: payload.volume,
      openPrice: payload.open_price,
      currentPrice: payload.current_price,
      stopLoss: payload.stop_loss || null,
      takeProfit: payload.take_profit || null,
      swap: payload.swap,
      commission: payload.commission,
      profit: payload.profit,
      profitPercent,
      magic: payload.magic,
      comment: payload.comment || null,
      openTime: payload.open_time,
      updatedAt: new Date().toISOString(),
      origin: payload.magic === 700_200 ? 'MANUAL' : 'MANUAL',
      strategyId: null,
      accountLogin: this.connection.accountLogin ?? '',
      source: 'MT5',
    };
  }

  private mapOrder(payload: EaOrderPayload): PendingOrder {
    const type = PENDING_TYPE_MAP[payload.type] ?? 'LIMIT';
    const side: OrderSide = [2, 4, 6].includes(payload.type) ? 'BUY' : 'SELL';
    return {
      id: `mt5_order_${payload.ticket}`,
      accountId: this.context.accountId,
      mode: 'LIVE',
      ticket: String(payload.ticket),
      symbol: payload.symbol,
      canonical: this.canonicalFor(payload.symbol),
      type,
      side,
      volume: payload.volume,
      price: payload.price,
      stopLimitPrice: payload.stop_limit_price || null,
      stopLoss: payload.stop_loss || null,
      takeProfit: payload.take_profit || null,
      expiration: payload.expiration || null,
      status: 'PENDING',
      placedAt: payload.setup_time,
      comment: payload.comment || null,
      magic: payload.magic,
      accountLogin: this.connection.accountLogin ?? '',
      source: 'MT5',
    };
  }

  private canonicalFor(symbol: string): string {
    const found = this.options.market
      .liveSymbolsFor(this.context.userId, this.connection.deviceId)
      .find((s) => s.symbol === symbol);
    return found?.canonical ?? symbol;
  }

  /** Persist EA-reported positions so analytics can run offline later. */
  async mirrorPositions(positions: EaPositionPayload[]): Promise<void> {
    const rows: PositionRow[] = positions.map((p) => ({
      id: `mt5_${p.ticket}`,
      userId: this.context.userId,
      accountId: this.context.accountId,
      mode: 'LIVE',
      ticket: String(p.ticket),
      brokerTicket: String(p.ticket),
      symbol: p.symbol,
      canonical: this.canonicalFor(p.symbol),
      side: p.type === 0 ? 'BUY' : 'SELL',
      volume: p.volume,
      openPrice: p.open_price,
      currentPrice: p.current_price,
      stopLoss: p.stop_loss || null,
      takeProfit: p.take_profit || null,
      swap: p.swap,
      commission: p.commission,
      profit: p.profit,
      profitPercent: 0,
      magic: p.magic,
      comment: p.comment || null,
      origin: 'MANUAL',
      strategyId: null,
      riskAmount: 0,
      accountLogin: this.connection.accountLogin ?? '',
      openTime: p.open_time,
      updatedAt: new Date().toISOString(),
      source: 'MT5',
      meta: null,
    }));

    const known = new Set(rows.map((r) => r.ticket));
    const existing = await this.options.store.positions.findMany({ accountId: { eq: this.context.accountId } });
    for (const row of rows) await this.options.store.positions.upsert(row);
    for (const row of existing) {
      if (!known.has(row.ticket)) await this.options.store.positions.delete(row.id);
    }

  }

  static newCommandId(): string {
    return newId('cmd');
  }
}

/**
 * Turn MT5 deals into closed-trade records.
 * A position may be closed by several deals (partial closes); they are grouped
 * by position_id and reported as one trade with weighted-average prices.
 */
export function aggregateDeals(deals: EaDealPayload[], context: BrokerContext): TradeRecord[] {
  const byPosition = new Map<string, EaDealPayload[]>();
  for (const deal of deals) {
    const key = String(deal.position_id || deal.ticket);
    const bucket = byPosition.get(key) ?? [];
    bucket.push(deal);
    byPosition.set(key, bucket);
  }

  const trades: TradeRecord[] = [];
  for (const [positionId, group] of byPosition) {
    const entries = group.filter((d) => d.entry === DEAL_ENTRY_IN || d.entry === DEAL_ENTRY_INOUT);
    const exits = group.filter((d) => d.entry === DEAL_ENTRY_OUT || d.entry === DEAL_ENTRY_OUT_BY);
    if (!entries.length || !exits.length) continue;

    const volumeIn = entries.reduce((acc, d) => acc + d.volume, 0);
    const volumeOut = exits.reduce((acc, d) => acc + d.volume, 0);
    const volume = Math.min(volumeIn, volumeOut);
    const entryPrice = weightAverage(entries);
    const exitPrice = weightAverage(exits);
    const grossProfit = exits.reduce((acc, d) => acc + d.profit, 0);
    const commission = group.reduce((acc, d) => acc + d.commission, 0);
    const swap = group.reduce((acc, d) => acc + d.swap, 0);
    const openTime = new Date(Math.min(...entries.map((d) => Date.parse(d.time))));
    const closeTime = new Date(Math.max(...exits.map((d) => Date.parse(d.time))));
    const firstEntry = entries[0];

    trades.push({
      id: `mt5_trade_${positionId}`,
      accountId: context.accountId,
      mode: 'LIVE',
      ticket: String(positionId),
      dealTicket: String(exits[exits.length - 1].ticket),
      symbol: firstEntry.symbol,
      canonical: firstEntry.symbol,
      side: entries[0].type === 0 ? 'BUY' : 'SELL',
      volume,
      entryPrice,
      exitPrice,
      stopLoss: null,
      takeProfit: null,
      commission,
      swap,
      grossProfit,
      netProfit: grossProfit + commission + swap,
      openTime: openTime.toISOString(),
      closeTime: closeTime.toISOString(),
      durationSeconds: Math.max(0, Math.round((closeTime.getTime() - openTime.getTime()) / 1000)),
      magic: firstEntry.magic,
      comment: firstEntry.comment || null,
      origin: 'MANUAL',
      strategyId: null,
      accountLogin: '',
      source: 'MT5',
    });
  }

  return trades.sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
}

function weightAverage(deals: EaDealPayload[]): number {
  const totalVolume = deals.reduce((acc, d) => acc + d.volume, 0);
  if (totalVolume <= 0) return deals[0]?.price ?? 0;
  return deals.reduce((acc, d) => acc + d.price * d.volume, 0) / totalVolume;
}
