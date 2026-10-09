/**
 * TradePilot — WebSocket protocol.
 *
 * Realtime channels carry: market prices, account updates, position updates,
 * order updates, execution reports and the MT5 heartbeat.
 * REST (see docs/API.md) carries: authentication, historical data, settings,
 * trade history and reports.
 */

import type {
  BrokerAccount,
  ConnectionStatus,
  Mt5Connection,
  Notification,
  PendingOrder,
  Position,
  Quote,
  RiskStatus,
  Timeframe,
  TradeRecord,
  TradingMode,
} from './domain';

export type ServerMessageType =
  | 'hello'
  | 'quote'
  | 'quotes'
  | 'account'
  | 'positions'
  | 'orders'
  | 'trade'
  | 'execution'
  | 'risk'
  | 'connection'
  | 'notification'
  | 'alert'
  | 'subscribed'
  | 'pong'
  | 'error';

export interface HelloMessage {
  type: 'hello';
  serverTime: string;
  userId: string;
  sessionId: string;
  mode: TradingMode;
  subscriptions: { symbols: string[]; timeframes: Timeframe[]; channels: string[] };
}

export interface QuoteMessage {
  type: 'quote';
  quote: Quote;
}

export interface QuotesMessage {
  type: 'quotes';
  quotes: Quote[];
}

export interface AccountMessage {
  type: 'account';
  account: BrokerAccount;
  risk: RiskStatus;
}

export interface PositionsMessage {
  type: 'positions';
  /** Positions still open. Closed positions arrive through `trade`. */
  positions: Position[];
  /** Account these positions belong to (demo and live are never mixed). */
  mode: TradingMode;
}

export interface OrdersMessage {
  type: 'orders';
  orders: PendingOrder[];
  mode: TradingMode;
}

export interface TradeMessage {
  type: 'trade';
  trade: TradeRecord;
}

export interface ExecutionMessage {
  type: 'execution';
  commandId: string;
  action: string;
  success: boolean;
  ticket?: string;
  price?: number;
  volume?: number;
  errorCode?: string;
  errorMessage?: string;
  mode: TradingMode;
  at: string;
}

export interface RiskMessage {
  type: 'risk';
  risk: RiskStatus;
}

export interface ConnectionMessage {
  type: 'connection';
  mt5: Mt5Connection | null;
  status: ConnectionStatus;
  /** Seconds since the last EA heartbeat, null when never connected. */
  lastHeartbeatAgeSeconds: number | null;
  message: string | null;
}

export interface NotificationMessage {
  type: 'notification';
  notification: Notification;
}

export interface AlertMessage {
  type: 'alert';
  alertId: string;
  symbol: string;
  price: number;
  condition: 'ABOVE' | 'BELOW';
  message: string;
}

export interface SubscribedMessage {
  type: 'subscribed';
  channels: string[];
  symbols: string[];
}

export interface PongMessage {
  type: 'pong';
  at: string;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  | HelloMessage
  | QuoteMessage
  | QuotesMessage
  | AccountMessage
  | PositionsMessage
  | OrdersMessage
  | TradeMessage
  | ExecutionMessage
  | RiskMessage
  | ConnectionMessage
  | NotificationMessage
  | AlertMessage
  | SubscribedMessage
  | PongMessage
  | ErrorMessage;

export type ClientMessageType = 'subscribe' | 'unsubscribe' | 'ping' | 'switch_mode' | 'request_snapshot';

export interface SubscribeMessage {
  type: 'subscribe';
  /** symbols the client wants quotes for (canonical or broker names) */
  symbols?: string[];
  timeframes?: Timeframe[];
  channels?: string[];
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  symbols?: string[];
  channels?: string[];
}

export interface PingMessage {
  type: 'ping';
}

export interface SwitchModeMessage {
  type: 'switch_mode';
  mode: TradingMode;
}

export interface SnapshotMessage {
  type: 'request_snapshot';
}

export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | PingMessage
  | SwitchModeMessage
  | SnapshotMessage;
