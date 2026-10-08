/**
 * TradePilot — core domain types.
 *
 * These types are shared by the frontend, the backend API, the demo engine and
 * (through the bridge protocol) the MT5 Expert Advisor.
 *
 * IMPORTANT: a "quote" is only ever produced by a real price source
 * (MT5 terminal through the EA) or by the explicitly labelled DEMO simulator.
 * Nothing in the platform is allowed to invent a live price.
 */

export type TradingMode = 'DEMO' | 'LIVE';

/** Where a piece of market data came from. Surfaced in the UI so the user is never misled. */
export type DataSource = 'MT5' | 'DEMO_SIMULATED';

export type OrderSide = 'BUY' | 'SELL';

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

export type Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1' | 'W1';

export type ConnectionStatus = 'CONNECTED' | 'DEGRADED' | 'OFFLINE';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  liveTradingEnabled: boolean;
  liveTradingEnabledAt?: string | null;
}

export interface BrokerAccount {
  id: string;
  userId: string;
  mode: TradingMode;
  /** MT5 login for live accounts, or a synthetic id for the demo account. */
  login: string;
  server: string;
  currency: string;
  leverage: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  profit: number;
  lastUpdate: string;
  /** Demo accounts are provisioned automatically; live ones must be linked to a verified EA. */
  isAuthorized: boolean;
}

export interface Mt5Connection {
  id: string;
  userId: string;
  deviceId: string;
  /** First characters of the device token, safe to display */
  tokenPrefix?: string | null;
  deviceName: string | null;
  accountLogin: string | null;
  server: string | null;
  status: ConnectionStatus;
  lastHeartbeat: string | null;
  latencyMs: number | null;
  terminalConnected: boolean;
  tradeAllowed: boolean;
  eaTradeAllowed: boolean;
  algoTradingEnabled: boolean;
  terminalBuild: string | null;
  eaVersion: string | null;
  createdAt: string;
  revokedAt?: string | null;
}

/**
 * Broker symbol specification. Values mirror the MQL5 SYMBOL_* properties so
 * that nothing has to be hard-coded in the web app — the calculator always
 * works from the specifications reported by the connected MT5 terminal.
 */
export interface SymbolInfo {
  /** Broker's actual symbol name, e.g. XAUUSDm or EURUSD.pro */
  symbol: string;
  /** Canonical/registry name the UI groups symbols by, e.g. XAUUSD */
  canonical: string;
  description: string;
  category: 'metal' | 'forex' | 'index' | 'crypto' | 'other';
  currencyBase: string;
  currencyProfit: string;
  currencyMargin: string;
  digits: number;
  /** Price step, SYMBOL_POINT */
  point: number;
  /** SYMBOL_TRADE_TICK_SIZE */
  tickSize: number;
  /** SYMBOL_TRADE_TICK_VALUE — value of one tick for 1.00 lot in account currency */
  tickValue: number;
  tickValueProfit: number;
  tickValueLoss: number;
  /** SYMBOL_TRADE_CONTRACT_SIZE */
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  /** SYMBOL_TRADE_STOPS_LEVEL in points */
  stopsLevel: number;
  /** SYMBOL_TRADE_FREEZE_LEVEL in points */
  freezeLevel: number;
  /** 0 disabled, 1 long only, 2 short only, 3 close only, 4 full */
  tradeMode: number;
  tradeAllowed: boolean;
  swapLong: number;
  swapShort: number;
  /** Symbol trading sessions (server time, "HH:MM-HH:MM" per weekday, empty = 24/7) */
  sessions: string[];
  /** Last time the terminal refreshed the specification */
  updatedAt: string;
  source: DataSource;
}

export interface Quote {
  symbol: string;
  canonical: string;
  bid: number;
  ask: number;
  /** Ask - Bid, in price units */
  spread: number;
  /** Spread expressed in points */
  spreadPoints: number;
  digits: number;
  high: number;
  low: number;
  open: number;
  close: number;
  /** Session change in percent */
  changePercent: number;
  time: string;
  source: DataSource;
}

export interface Candle {
  /** Open time, unix seconds */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type PositionOrigin = 'MANUAL' | 'STRATEGY';

export interface Position {
  id: string;
  accountId: string;
  mode: TradingMode;
  ticket: string;
  /** internal broker symbol name */
  symbol: string;
  canonical: string;
  side: OrderSide;
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  swap: number;
  commission: number;
  profit: number;
  /** profit as a percentage of the position's initial risk */
  profitPercent: number;
  magic: number;
  comment: string | null;
  openTime: string;
  updatedAt: string;
  origin: PositionOrigin;
  strategyId: string | null;
  /** Broker account login this position lives on (never a password). */
  accountLogin: string;
  source: DataSource;
}

export interface PendingOrder {
  id: string;
  accountId: string;
  mode: TradingMode;
  ticket: string;
  symbol: string;
  canonical: string;
  type: OrderType;
  side: OrderSide;
  volume: number;
  price: number;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiration: string | null;
  status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
  placedAt: string;
  comment: string | null;
  magic: number;
  accountLogin: string;
  source: DataSource;
}

export interface TradeRecord {
  id: string;
  accountId: string;
  mode: TradingMode;
  ticket: string;
  /** Closing deal ticket for live MT5 history */
  dealTicket: string | null;
  symbol: string;
  canonical: string;
  side: OrderSide;
  volume: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  commission: number;
  swap: number;
  /** Gross profit from the broker, before commission and swap */
  grossProfit: number;
  /** Net = gross + commission + swap (commission/swap are negative costs) */
  netProfit: number;
  openTime: string;
  closeTime: string;
  durationSeconds: number;
  magic: number;
  comment: string | null;
  origin: PositionOrigin;
  strategyId: string | null;
  accountLogin: string;
  source: DataSource;
}

export interface RiskSettings {
  userId: string;
  maxRiskPerTradePercent: number;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  maxTotalExposureLots: number;
  maxLotSize: number;
  /** null = unlimited */
  maxDailyTrades: number | null;
  /** Block new trades after this many consecutive losses (0 = disabled) */
  maxConsecutiveLosses: number;
  /** Require typed confirmation for every live order */
  requireLiveConfirmation: boolean;
  /** Slippage guard, in points, applied to market orders */
  maxSlippagePoints: number;
  tradingHoursEnabled: boolean;
  /** "HH:MM-HH:MM" windows in UTC */
  tradingHours: { start: string; end: string }[];
  strategyEngineEnabled: boolean;
  updatedAt: string;
}

export interface RiskStatus {
  /** Trading is currently allowed at all (kill switch, daily loss, MT5 link). */
  tradingEnabled: boolean;
  liveTradingEnabled: boolean;
  locked: boolean;
  lockReasons: string[];
  dailyLossLimitAmount: number;
  dailyRealizedLoss: number;
  dailyRealizedProfit: number;
  dailyNetPl: number;
  dailyTradesCount: number;
  openPositionsCount: number;
  totalExposureLots: number;
  consecutiveLosses: number;
  remainingRiskToday: number;
  /** Local day the counters refer to */
  day: string;
}

export interface PortfolioSnapshot {
  id: string;
  accountId: string;
  mode: TradingMode;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  openPl: number;
  time: string;
}

export interface AnalyticsSummary {
  mode: TradingMode;
  hasData: boolean;
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number | null;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  averageWin: number | null;
  averageLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  largestWin: number | null;
  largestLoss: number | null;
  totalCommission: number;
  totalSwap: number;
  averageDurationSeconds: number | null;
  equityCurve: { time: string; balance: number; equity: number }[];
  dailyPl: { date: string; pl: number; trades: number }[];
  monthlyPl: { month: string; pl: number; trades: number }[];
  distribution: {
    buckets: { label: string; count: number }[];
    winLoss: { wins: number; losses: number; breakEven: number };
  };
  bySymbol: { symbol: string; trades: number; netProfit: number; winRate: number | null }[];
  disclaimer: string;
}

export interface JournalEntry {
  id: string;
  userId: string;
  tradeId: string | null;
  ticket: string | null;
  symbol: string | null;
  setup: string | null;
  reasonForEntry: string | null;
  marketConditions: string | null;
  emotion: string | null;
  mistakes: string | null;
  lesson: string | null;
  notes: string | null;
  tags: string[];
  rating: number | null;
  screenshotUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  mode: TradingMode;
  /** Immutable sequence number (append-only table) */
  sequence: number;
  action: string;
  symbol: string | null;
  volume: number | null;
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  brokerTicket: string | null;
  result: 'SUCCESS' | 'FAILURE' | 'REJECTED' | 'PENDING';
  errorCode: string | null;
  errorMessage: string | null;
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
  commandId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  level: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  meta?: Record<string, unknown> | null;
}

export interface PriceAlert {
  id: string;
  userId: string;
  symbol: string;
  canonical: string;
  condition: 'ABOVE' | 'BELOW';
  price: number;
  triggered: boolean;
  triggeredAt: string | null;
  createdAt: string;
  note: string | null;
}

export interface Watchlist {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  items: WatchlistItem[];
  createdAt: string;
}

export interface WatchlistItem {
  id: string;
  watchlistId: string;
  symbol: string;
  canonical: string;
  position: number;
}

export interface StrategyConfig {
  id: string;
  userId: string;
  name: string;
  engine: 'ema_cross' | 'rsi_reversion' | 'bollinger_breakout';
  symbol: string;
  timeframe: Timeframe;
  enabled: boolean;
  parameters: Record<string, number>;
  riskPerTradePercent: number;
  maxPositions: number;
  createdAt: string;
  updatedAt: string;
  lastSignalAt: string | null;
}

export interface AuthSession {
  user: UserProfile;
  activeAccount: BrokerAccount;
  mode: TradingMode;
}
