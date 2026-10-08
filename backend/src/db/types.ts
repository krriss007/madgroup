/**
 * TradePilot — persistence abstraction.
 *
 * The Prisma schema in /prisma/schema.prisma and the SQL DDL in
 * /database/schema.sql are the canonical definitions of the data model.
 * At runtime the backend talks to this small typed store interface, which is
 * implemented twice:
 *
 *   • PostgresStore — real SQL against the tables defined in database/schema.sql
 *   • MemoryStore   — same semantics, process memory (local demo / tests)
 *
 * This keeps the trading services free of SQL while still allowing the
 * deployment described in the README (PostgreSQL + Prisma tooling).
 */

export type FilterValue<T> =
  | T
  | {
      eq?: T;
      ne?: T;
      gt?: T;
      gte?: T;
      lt?: T;
      lte?: T;
      in?: T[];
      isNull?: boolean;
      like?: string;
    };

export type Filter<T> = { [K in keyof T]?: FilterValue<T[K]> };

export interface FindOptions<T> {
  orderBy?: { field: keyof T & string; direction?: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export interface Table<T extends { id: string }> {
  insert(row: T): Promise<T>;
  upsert(row: T): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T | null>;
  findById(id: string): Promise<T | null>;
  findOne(filter: Filter<T>, options?: FindOptions<T>): Promise<T | null>;
  findMany(filter?: Filter<T>, options?: FindOptions<T>): Promise<T[]>;
  count(filter?: Filter<T>): Promise<number>;
  delete(id: string): Promise<boolean>;
  deleteMany(filter: Filter<T>): Promise<number>;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  /**
   * scrypt password hash ("scrypt$N$r$p$salt$hash"). Never logged, never
   * exposed through the API, never sent to the browser.
   */
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  liveTradingEnabled: boolean;
  liveTradingEnabledAt: string | null;
  liveRiskAcknowledgedAt: string | null;
  killSwitchEngaged: boolean;
  lastLoginAt: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
  /** Incremented to invalidate all previously issued JWTs for this user. */
  tokenVersion: number;
}

export interface BrokerAccountRow {
  id: string;
  userId: string;
  mode: 'DEMO' | 'LIVE';
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
  startingBalance: number;
  isAuthorized: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastUpdate: string;
}

export interface Mt5ConnectionRow {
  id: string;
  userId: string;
  accountId: string | null;
  deviceId: string;
  deviceName: string | null;
  /** SHA-256 of the device secret. The plaintext token is shown to the user once. */
  tokenHash: string;
  /** AES-256-GCM ciphertext of the secret, used to sign bridge commands. */
  tokenSecretEnc: string | null;
  tokenPrefix: string;
  accountLogin: string | null;
  server: string | null;
  status: 'CONNECTED' | 'DEGRADED' | 'OFFLINE';
  lastHeartbeat: string | null;
  lastSequence: number;
  latencyMs: number | null;
  terminalConnected: boolean;
  tradeAllowed: boolean;
  eaTradeAllowed: boolean;
  algoTradingEnabled: boolean;
  terminalBuild: string | null;
  eaVersion: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SymbolRow {
  id: string;
  userId: string | null;
  connectionId: string | null;
  symbol: string;
  canonical: string;
  source: 'MT5' | 'DEMO_SIMULATED';
  spec: Record<string, unknown>;
  updatedAt: string;
}

export interface WatchlistRow {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
}

export interface WatchlistItemRow {
  id: string;
  watchlistId: string;
  userId: string;
  symbol: string;
  canonical: string;
  position: number;
  createdAt: string;
}

export interface OrderRow {
  id: string;
  userId: string;
  accountId: string;
  mode: 'DEMO' | 'LIVE';
  ticket: string;
  brokerTicket: string | null;
  symbol: string;
  canonical: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  volume: number;
  price: number;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  expiration: string | null;
  status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
  comment: string | null;
  magic: number;
  origin: 'MANUAL' | 'STRATEGY';
  strategyId: string | null;
  clientRequestId: string | null;
  commandId: string | null;
  placedAt: string;
  updatedAt: string;
  closedAt: string | null;
  source: 'MT5' | 'DEMO_SIMULATED';
}

export interface PositionRow {
  id: string;
  userId: string;
  accountId: string;
  mode: 'DEMO' | 'LIVE';
  ticket: string;
  brokerTicket: string | null;
  symbol: string;
  canonical: string;
  side: 'BUY' | 'SELL';
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  swap: number;
  commission: number;
  profit: number;
  profitPercent: number;
  magic: number;
  comment: string | null;
  origin: 'MANUAL' | 'STRATEGY';
  strategyId: string | null;
  /** Value at risk when the position was opened (used for P/L % display). */
  riskAmount: number;
  accountLogin: string;
  openTime: string;
  updatedAt: string;
  source: 'MT5' | 'DEMO_SIMULATED';
  /** extra demo-engine bookkeeping (fees already applied, partial closes, …) */
  meta: Record<string, unknown> | null;
}

export interface TradeRow {
  id: string;
  userId: string;
  accountId: string;
  mode: 'DEMO' | 'LIVE';
  ticket: string;
  dealTicket: string | null;
  symbol: string;
  canonical: string;
  side: 'BUY' | 'SELL';
  volume: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  commission: number;
  swap: number;
  grossProfit: number;
  netProfit: number;
  openTime: string;
  closeTime: string;
  durationSeconds: number;
  magic: number;
  comment: string | null;
  origin: 'MANUAL' | 'STRATEGY';
  strategyId: string | null;
  accountLogin: string;
  source: 'MT5' | 'DEMO_SIMULATED';
  createdAt: string;
}

export interface PriceAlertRow {
  id: string;
  userId: string;
  symbol: string;
  canonical: string;
  condition: 'ABOVE' | 'BELOW';
  price: number;
  triggered: boolean;
  triggeredAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface RiskSettingsRow {
  id: string;
  userId: string;
  maxRiskPerTradePercent: number;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  maxTotalExposureLots: number;
  maxLotSize: number;
  maxDailyTrades: number | null;
  maxConsecutiveLosses: number;
  requireLiveConfirmation: boolean;
  maxSlippagePoints: number;
  tradingHoursEnabled: boolean;
  tradingHours: { start: string; end: string }[];
  strategyEngineEnabled: boolean;
  updatedAt: string;
}

export interface PortfolioSnapshotRow {
  id: string;
  userId: string;
  accountId: string;
  mode: 'DEMO' | 'LIVE';
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  openPl: number;
  time: string;
}

export interface JournalRow {
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

/**
 * Append-only audit log. The Postgres schema enforces this with a rule that
 * rejects UPDATE/DELETE (see database/schema.sql), so entries cannot be
 * silently removed — not by the app, not by an operator.
 */
export interface AuditLogRow {
  id: string;
  userId: string | null;
  mode: 'DEMO' | 'LIVE';
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

export interface NotificationRow {
  id: string;
  userId: string;
  level: 'info' | 'success' | 'warning' | 'critical';
  title: string;
  message: string;
  read: boolean;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface BridgeCommandRow {
  id: string;
  commandId: string;
  userId: string;
  accountId: string;
  deviceId: string;
  action: string;
  symbol: string;
  /** Signed envelope handed to the EA, verbatim. */
  envelope: Record<string, unknown>;
  idempotencyKey: string;
  status: 'QUEUED' | 'DELIVERED' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  attempts: number;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

export interface IdempotencyRow {
  id: string;
  userId: string;
  scope: string;
  key: string;
  /** Response body that was returned the first time this key was seen. */
  response: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export interface StrategyRow {
  id: string;
  userId: string;
  accountId: string;
  name: string;
  engine: 'ema_cross' | 'rsi_reversion' | 'bollinger_breakout';
  symbol: string;
  canonical: string;
  timeframe: string;
  enabled: boolean;
  parameters: Record<string, number>;
  riskPerTradePercent: number;
  maxPositions: number;
  lastSignalAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Tables {
  users: Table<UserRow>;
  brokerAccounts: Table<BrokerAccountRow>;
  mt5Connections: Table<Mt5ConnectionRow>;
  symbols: Table<SymbolRow>;
  watchlists: Table<WatchlistRow>;
  watchlistItems: Table<WatchlistItemRow>;
  orders: Table<OrderRow>;
  positions: Table<PositionRow>;
  trades: Table<TradeRow>;
  priceAlerts: Table<PriceAlertRow>;
  riskSettings: Table<RiskSettingsRow>;
  portfolioSnapshots: Table<PortfolioSnapshotRow>;
  journal: Table<JournalRow>;
  auditLogs: Table<AuditLogRow>;
  notifications: Table<NotificationRow>;
  bridgeCommands: Table<BridgeCommandRow>;
  idempotencyKeys: Table<IdempotencyRow>;
  strategies: Table<StrategyRow>;
}

export interface Store extends Tables {
  readonly kind: 'postgres' | 'memory';
  init(): Promise<void>;
  healthcheck(): Promise<{ ok: boolean; detail: string }>;
  /** Append-only sequence for the audit log (never re-used, never gaps). */
  nextAuditSequence(): Promise<number>;
  /** Remove ephemeral rows (expired commands, expired idempotency keys). */
  cleanup(now?: Date): Promise<{ commands: number; idempotency: number }>;
  close(): Promise<void>;
}

export type { Table as TableRepo };
