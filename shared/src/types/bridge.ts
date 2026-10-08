/**
 * TradePilot — Web ⇄ MT5 bridge protocol.
 *
 * The web application never holds broker credentials. It enqueues signed
 * commands that the TradePilotBridge.mq5 Expert Advisor picks up from the
 * backend and executes inside the user's own MT5 terminal. The EA reports
 * results back through the same protocol.
 *
 * Every command carries: command_id, timestamp, user_id, account_id, symbol,
 * action, parameters — plus a nonce and an HMAC signature for replay
 * protection (see docs/SECURITY.md).
 */

export const BRIDGE_PROTOCOL_VERSION = '1.0.0';

/** Commands the web layer may send to the EA. */
export const BRIDGE_ACTIONS = [
  'OPEN_MARKET_ORDER',
  'PLACE_PENDING_ORDER',
  'MODIFY_POSITION',
  'MODIFY_ORDER',
  'CLOSE_POSITION',
  'CLOSE_ALL_POSITIONS',
  'CANCEL_ORDER',
  'CANCEL_ALL_ORDERS',
  'GET_ACCOUNT',
  'GET_POSITIONS',
  'GET_ORDERS',
  'GET_SYMBOL_INFO',
  'GET_HISTORY',
  'GET_CANDLES',
  'PING',
] as const;

export type BridgeAction = (typeof BRIDGE_ACTIONS)[number];

export type PendingOrderKind = 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP' | 'BUY_STOP_LIMIT' | 'SELL_STOP_LIMIT';

export interface BridgeCommandEnvelope {
  command_id: string;
  /** ISO-8601 UTC */
  timestamp: string;
  user_id: string;
  account_id: string;
  /** Broker symbol name as reported by the terminal; empty for account-wide commands */
  symbol: string;
  action: BridgeAction;
  parameters: Record<string, unknown>;
  /** Idempotency key — the EA must ignore a command_id it has already executed */
  idempotency_key: string;
  /** Single-use random value, used to defeat replay attacks */
  nonce: string;
  /** HMAC-SHA256(secret, canonical_payload) hex */
  signature: string;
  protocol_version: string;
}

export interface OpenMarketOrderParams {
  side: 'BUY' | 'SELL';
  volume: number;
  stop_loss?: number | null;
  take_profit?: number | null;
  deviation_points?: number;
  comment?: string;
  magic?: number;
}

export interface PlacePendingOrderParams {
  kind: PendingOrderKind;
  volume: number;
  price: number;
  stop_limit_price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  expiration?: string | null;
  comment?: string;
  magic?: number;
}

export interface ModifyPositionParams {
  ticket: string;
  stop_loss?: number | null;
  take_profit?: number | null;
}

export interface ModifyOrderParams {
  ticket: string;
  price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  expiration?: string | null;
}

export interface ClosePositionParams {
  ticket: string;
  /** partial close volume, omit to close fully */
  volume?: number | null;
  deviation_points?: number;
}

export interface CloseAllPositionsParams {
  /** Safety switch: an emergency close-all must always be explicit. */
  confirm: 'CONFIRM CLOSE ALL';
  reason?: string;
  /** Restrict to positions opened by this magic number (0 = only non-magic orders) */
  magic?: number | null;
  symbol?: string | null;
}

export interface CancelOrderParams {
  ticket: string;
}

export interface GetSymbolInfoParams {
  symbol?: string;
}

export interface GetCandlesParams {
  symbol: string;
  timeframe: string;
  count: number;
}

export interface GetHistoryParams {
  from: string;
  to: string;
}

/* ------------------------------------------------------------------------- */
/* EA → Web payloads                                                          */
/* ------------------------------------------------------------------------- */

export interface EaHeartbeat {
  device_id: string;
  /** Monotonic per-device sequence number; out-of-order payloads are dropped. */
  sequence?: number;
  account: string;
  server: string;
  timestamp: string;
  terminal_connected: boolean;
  trade_allowed: boolean;
  ea_trade_allowed: boolean;
  algo_trading_enabled: boolean;
  ping_ms?: number;
  terminal_build?: string;
  ea_version?: string;
  /** number of commands currently queued for this device */
  queued_commands?: number;
}

export interface EaAccountPayload {
  login: number;
  server: string;
  currency: string;
  leverage: number;
  balance: number;
  equity: number;
  margin: number;
  free_margin: number;
  margin_level: number;
  profit: number;
  trade_allowed: boolean;
  trade_expert: boolean;
  /** Time the snapshot was taken inside the terminal */
  timestamp: string;
}

export interface EaSymbolPayload {
  symbol: string;
  description: string;
  path: string;
  currency_base: string;
  currency_profit: string;
  currency_margin: string;
  digits: number;
  point: number;
  tick_size: number;
  tick_value: number;
  tick_value_profit: number;
  tick_value_loss: number;
  contract_size: number;
  volume_min: number;
  volume_max: number;
  volume_step: number;
  stops_level: number;
  freeze_level: number;
  trade_mode: number;
  trade_allowed: boolean;
  swap_long: number;
  swap_short: number;
  sessions: string[];
}

export interface EaTickPayload {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  spread_points: number;
  time: string;
  /** Daily (D1) statistics reported by the terminal, optional */
  day_open?: number;
  day_high?: number;
  day_low?: number;
}

export interface EaRatePayload {
  symbol: string;
  timeframe: string;
  rates: {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
}

export interface EaPositionPayload {
  ticket: number;
  symbol: string;
  type: 0 | 1; // POSITION_TYPE_BUY | POSITION_TYPE_SELL
  volume: number;
  open_price: number;
  current_price: number;
  stop_loss: number;
  take_profit: number;
  profit: number;
  swap: number;
  commission: number;
  magic: number;
  comment: string;
  open_time: string;
}

export interface EaOrderPayload {
  ticket: number;
  symbol: string;
  type: number; // ORDER_TYPE_* constant
  volume: number;
  price: number;
  stop_limit_price: number;
  stop_loss: number;
  take_profit: number;
  expiration: string;
  state: number;
  magic: number;
  comment: string;
  setup_time: string;
}

export interface EaDealPayload {
  ticket: number;
  position_id: number;
  symbol: string;
  type: number;
  entry: number; // DEAL_ENTRY_IN | DEAL_ENTRY_OUT
  volume: number;
  price: number;
  commission: number;
  swap: number;
  profit: number;
  time: string;
  magic: number;
  comment: string;
}

export interface EaExecutionResult {
  command_id: string;
  success: boolean;
  broker_ticket: number | null;
  execution_price: number | null;
  volume: number | null;
  /** raw MQL5 retcode, e.g. 10009 TRADE_RETCODE_DONE */
  retcode: number | null;
  error_code: string | null;
  error_message: string | null;
  timestamp: string;
  /** order/position state after execution */
  state?: string | null;
  /**
   * Payload for data commands (GET_ACCOUNT, GET_POSITIONS, GET_ORDERS,
   * GET_SYMBOL_INFO, GET_HISTORY, GET_CANDLES). Trading commands leave it out.
   */
  data?: Record<string, unknown> | null;
}

/** Request body the EA POSTs to /bridge/* endpoints. */
export interface EaEnvelope<T> {
  device_id: string;
  device_token: string;
  protocol_version: string;
  /** ISO timestamp inside the terminal */
  sent_at: string;
  /** Monotonic sequence per device, used to drop replayed payloads */
  sequence: number;
  payload: T;
}
