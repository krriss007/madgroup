/**
 * TradePilot — broker abstraction.
 *
 * The backend services only ever talk to this interface, so the frontend and
 * the trading logic never need to know whether orders end up in the built-in
 * demo engine or in a real MT5 terminal through the bridge.
 *
 * Implementations shipped in this repository:
 *   • DemoBroker            — built-in paper-trading engine (no broker contact)
 *   • MT5BrokerBridge       — routes commands to the user's MT5 EA
 *   • ExnessDirectAPI (future) — a documented placeholder, not implemented
 */

import type {
  BrokerAccount,
  Candle,
  OrderSide,
  OrderType,
  PendingOrder,
  Position,
  Quote,
  SymbolInfo,
  Timeframe,
  TradeRecord,
} from './domain';

export interface BrokerContext {
  userId: string;
  accountId: string;
  mode: 'DEMO' | 'LIVE';
}

export interface PlaceMarketOrderRequest {
  symbol: string;
  side: OrderSide;
  volume: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  comment?: string | null;
  /** idempotency key — identical keys must never create two broker orders */
  clientRequestId: string;
  deviationPoints?: number;
  origin?: 'MANUAL' | 'STRATEGY';
  strategyId?: string | null;
}

export interface PlacePendingOrderRequest {
  symbol: string;
  side: OrderSide;
  type: Exclude<OrderType, 'MARKET'>;
  volume: number;
  price: number;
  stopLimitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  expiration?: string | null;
  comment?: string | null;
  clientRequestId: string;
  origin?: 'MANUAL' | 'STRATEGY';
  strategyId?: string | null;
}

export interface ModifyPositionRequest {
  ticket: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
  clientRequestId: string;
}

export interface ModifyOrderRequest {
  ticket: string;
  price?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  expiration?: string | null;
  clientRequestId: string;
}

export interface ClosePositionRequest {
  ticket: string;
  volume?: number | null;
  reason?: string | null;
  clientRequestId: string;
}

export interface CloseAllPositionsRequest {
  confirm: string;
  symbol?: string | null;
  reason?: string | null;
  clientRequestId: string;
}

export interface CancelOrderRequest {
  ticket: string;
  clientRequestId: string;
}

export interface ExecutionReport {
  commandId: string;
  idempotencyKey: string;
  success: boolean;
  /** broker ticket of the resulting position/order, when available */
  ticket: string | null;
  executionPrice: number | null;
  volume: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  at: string;
  /** number of positions/orders affected (close-all reports > 1) */
  affected?: number;
  /** aggregate realised profit for close operations */
  realizedPl?: number | null;
}

export interface AccountSnapshotRequest {
  /** force the EA to refresh account data before replying */
  refresh?: boolean;
}

export interface TradingBroker {
  /** Broker implementation identifier, surfaced in diagnostics. */
  readonly kind: 'DEMO' | 'MT5' | 'DIRECT_API';
  readonly mode: 'DEMO' | 'LIVE';
  readonly context: BrokerContext;

  /** Health of the underlying execution channel. */
  isAvailable(): Promise<boolean>;
  /** Human readable reason when isAvailable() is false. */
  unavailableReason(): string | null;

  getAccount(request?: AccountSnapshotRequest): Promise<BrokerAccount>;
  getSymbolInfo(symbol: string): Promise<SymbolInfo[]>;
  getQuote(symbols: string[]): Promise<Quote[]>;
  getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]>;
  getPositions(): Promise<Position[]>;
  getOrders(): Promise<PendingOrder[]>;
  getHistory(from: Date, to: Date): Promise<TradeRecord[]>;

  placeMarketOrder(request: PlaceMarketOrderRequest): Promise<ExecutionReport>;
  placePendingOrder(request: PlacePendingOrderRequest): Promise<ExecutionReport>;
  modifyPosition(request: ModifyPositionRequest): Promise<ExecutionReport>;
  modifyOrder(request: ModifyOrderRequest): Promise<ExecutionReport>;
  closePosition(request: ClosePositionRequest): Promise<ExecutionReport>;
  closeAllPositions(request: CloseAllPositionsRequest): Promise<ExecutionReport>;
  cancelOrder(request: CancelOrderRequest): Promise<ExecutionReport>;
}
