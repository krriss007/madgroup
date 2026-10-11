// Shared types used by the server (trading engine, market data, agent) and the web terminal.

export type Category = 'forex' | 'metals' | 'indices' | 'crypto';
export type Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';
export type Side = 'buy' | 'sell';
/** 'market' executes immediately; 'limit' and 'stop' are pending orders. */
export type OrderType = 'market' | 'limit' | 'stop';
export type PendingType = 'limit' | 'stop';
export type AccountType = 'standard' | 'pro' | 'raw' | 'zero';
export type OrderSource = 'manual' | 'agent';
export type CloseReason = 'manual' | 'sl' | 'tp' | 'stop_out' | 'agent' | 'agent_flip' | 'close_all';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected' | 'closed';
export type AgentMode = 'rules' | 'llm';
export type StrategyId = 'ema_cross' | 'rsi_reversion' | 'breakout' | 'consensus';

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

export const TIMEFRAMES = Object.keys(TIMEFRAME_MS) as Timeframe[];

export const LEVERAGE_OPTIONS = [1, 2, 5, 10, 20, 30, 50, 100, 200, 500, 1000, 2000] as const;

/** Demo parameters for each account type (approximations, not Exness' actual pricing). */
export const ACCOUNT_TYPES: Record<AccountType, { label: string; spreadMultiplier: number; commissionPerLot: number; description: string }> = {
  standard: { label: 'Standard', spreadMultiplier: 1.0, commissionPerLot: 0, description: 'Wider spreads, no commission' },
  pro: { label: 'Pro', spreadMultiplier: 0.6, commissionPerLot: 0, description: 'Tighter spreads, no commission' },
  raw: { label: 'Raw Spread', spreadMultiplier: 0.25, commissionPerLot: 3.5, description: 'Raw interbank-style spreads + $3.50 per lot per side' },
  zero: { label: 'Zero', spreadMultiplier: 0.05, commissionPerLot: 2.0, description: 'Near-zero spreads + $2.00 per lot per side' },
};

export interface InstrumentSpec {
  symbol: string;
  name: string;
  category: Category;
  baseCcy: string;
  quoteCcy: string;
  digits: number;
  /** Typical spread in price units for the Standard account (scaled by the account type multiplier). */
  spread: number;
  contractSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  /** Overnight swap as a % of notional per day (negative = you pay). */
  swapLongPct: number;
  swapShortPct: number;
  /** Typical daily volatility in % (drives the simulator). */
  dailyVolPct: number;
  /** Starting price used by the simulator when no live feed is available. */
  simBasePrice: number;
  /** Binance symbol if this instrument has a live crypto feed. */
  binanceSymbol?: string;
  /** Finnhub symbol (e.g. "OANDA:EUR_USD", "BINANCE:BTCUSDT") if Finnhub streams it. */
  finnhubSymbol?: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  digits: number;
  dayOpen: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  /** 'live' = fed by an exchange stream, 'sim' = simulated. */
  source: 'live' | 'sim';
  time: number;
}

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Position {
  id: number;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  /** Margin reserved when the position was opened (USD). */
  margin: number;
  /** Cumulative commission charged on this position's open leg (USD, negative). */
  commission: number;
  /** Cumulative swap charged (USD, may be negative or positive). */
  swap: number;
  source: OrderSource;
  comment: string;
}

export interface PositionView extends Position {
  currentPrice: number;
  profit: number;
  roe: number;
}

export interface PendingOrder {
  id: number;
  symbol: string;
  side: Side;
  type: PendingType;
  volume: number;
  price: number;
  sl: number | null;
  tp: number | null;
  createdAt: number;
  source: OrderSource;
  comment: string;
}

export interface ClosedTrade {
  id: number;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  closePrice: number;
  openTime: number;
  closeTime: number;
  /** Net profit in USD (gross P/L + commission + swap). */
  profit: number;
  commission: number;
  swap: number;
  reason: CloseReason;
  source: OrderSource;
  comment: string;
}

export interface OrderRecord {
  id: number;
  time: number;
  updatedAt: number;
  symbol: string;
  side: Side;
  type: OrderType;
  volume: number;
  /** Requested price for pending orders, or the executed price for market orders. */
  price: number | null;
  fillPrice: number | null;
  sl: number | null;
  tp: number | null;
  status: OrderStatus;
  message: string;
  source: OrderSource;
  comment: string;
}

export interface LedgerEntry {
  id: number;
  time: number;
  type: 'deposit' | 'withdrawal' | 'trade' | 'commission' | 'swap' | 'reset';
  amount: number;
  balanceAfter: number;
  note: string;
}

export interface AccountSettings {
  accountType: AccountType;
  leverage: number;
}

export interface AccountSummary {
  accountId: string;
  currency: 'USD';
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  /** null when there is no used margin. */
  marginLevel: number | null;
  floatingPnl: number;
  marginCallLevel: number;
  stopOutLevel: number;
  settings: AccountSettings;
  dayStartEquity: number;
  dayPnl: number;
  startingBalance: number;
}

export interface AccountStateLive {
  summary: AccountSummary;
  positions: PositionView[];
  pending: PendingOrder[];
}

export interface AccountStateFull extends AccountStateLive {
  history: ClosedTrade[];
  orders: OrderRecord[];
  ledger: LedgerEntry[];
}

export interface AgentConfig {
  enabled: boolean;
  mode: AgentMode;
  symbols: string[];
  timeframe: Timeframe;
  strategy: StrategyId;
  /** % of equity risked per trade (distance to stop loss). */
  riskPercent: number;
  /** Stop loss distance in ATR multiples. */
  slAtr: number;
  /** Take profit distance in ATR multiples. */
  tpAtr: number;
  maxOpenPositions: number;
  maxDailyLossPercent: number;
  /** Close agent positions in the opposite direction when a new signal appears. */
  allowFlip: boolean;
  /** Minimum seconds between LLM calls for the same symbol. */
  llmIntervalSec: number;
}

export interface AgentLogEntry {
  id: number;
  time: number;
  symbol: string | null;
  level: 'info' | 'trade' | 'warn' | 'error';
  message: string;
}

export interface AgentStatus {
  config: AgentConfig;
  running: boolean;
  halted: boolean;
  haltReason: string | null;
  llm: { configured: boolean; model: string | null; baseUrl: string | null };
  lastDecisions: Record<string, { time: number; action: string; reason: string; confidence?: number }>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  time: number;
}

export interface FeedStatusView {
  name: 'finnhub' | 'binance' | 'simulator';
  enabled: boolean;
  connected: boolean;
  error: string | null;
  symbols: string[];
}

export interface MarketStatus {
  mode: 'auto' | 'sim';
  /** Symbols whose prices are streaming from a live feed right now. */
  live: string[];
  /** Symbols priced by the simulator. */
  simulated: string[];
  feeds: FeedStatusView[];
}

/** Messages the server pushes to the browser over WebSocket. */
export type ServerMessage =
  | { type: 'hello'; instruments: InstrumentSpec[]; accountTypes: typeof ACCOUNT_TYPES; leverageOptions: readonly number[]; market: MarketStatus }
  | { type: 'quotes'; quotes: Quote[] }
  | { type: 'account'; state: AccountStateLive }
  | { type: 'account_full'; state: AccountStateFull }
  | { type: 'bar'; symbol: string; tf: Timeframe; bar: Bar }
  | { type: 'agent'; status: AgentStatus }
  | { type: 'agent_log'; entry: AgentLogEntry }
  | { type: 'agent_logs'; entries: AgentLogEntry[] }
  | { type: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; message: string }
  | { type: 'market'; market: MarketStatus };

/** Messages the browser sends over WebSocket. */
export type ClientMessage = { type: 'subscribe'; symbol: string; tf: Timeframe };

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  volume: number;
  price?: number | null;
  sl?: number | null;
  tp?: number | null;
  comment?: string;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}
