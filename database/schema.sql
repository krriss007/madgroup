-- ===========================================================================
-- TradePilot — canonical PostgreSQL schema (18 tables)
-- ===========================================================================
--
-- This file is the SQL mirror of prisma/schema.prisma. It is applied
-- idempotently by the backend on boot (PostgresStore, AUTO_MIGRATE) and can be
-- applied manually with:
--
--   psql "$DATABASE_URL" -f database/schema.sql      # or: npm run db:setup
--
-- Design rules
--   • Column names are the snake_case form of the TypeScript row fields in
--     backend/src/db/types.ts — the store validates every column against
--     information_schema at boot, so the code and this file cannot drift
--     silently.
--   • Money uses NUMERIC(18,2); prices NUMERIC(18,8); volumes NUMERIC(18,4).
--     node-postgres parses NUMERIC back to JS numbers (see db/postgres.ts).
--   • Every trading record carries `mode` (DEMO | LIVE) and `source`
--     (MT5 | DEMO_SIMULATED) so demo simulation can never be mistaken for real
--     broker data.
--   • 15 tables carry the product data model (users, broker_accounts,
--     mt5_connections, symbols, watchlists, watchlist_items, orders, positions,
--     trades, price_alerts, risk_settings, portfolio_snapshots, trade_journal,
--     audit_logs, notifications); 3 more carry the MT5 bridge and the optional
--     strategy engine (bridge_commands, idempotency_keys, strategies).
--   • audit_logs is append-only: UPDATE/DELETE are neutralised by rules below.
--     An audit entry is written for every live action (and for every rejected
--     order), and the table is never pruned by the application.
--   • No broker password, terminal password or payment credential is stored
--     anywhere: mt5_connections holds only a device-token hash plus an
--     encrypted copy of the signing secret.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  live_trading_enabled BOOLEAN NOT NULL DEFAULT false,
  live_trading_enabled_at TIMESTAMPTZ,
  live_risk_acknowledged_at TIMESTAMPTZ,
  kill_switch_engaged BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  token_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS broker_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('DEMO','LIVE')),
  login TEXT NOT NULL,
  server TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  leverage INTEGER NOT NULL DEFAULT 100,
  balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  equity NUMERIC(18,2) NOT NULL DEFAULT 0,
  margin NUMERIC(18,2) NOT NULL DEFAULT 0,
  free_margin NUMERIC(18,2) NOT NULL DEFAULT 0,
  margin_level NUMERIC(18,2),
  profit NUMERIC(18,2) NOT NULL DEFAULT 0,
  starting_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  is_authorized BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_update TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mt5_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES broker_accounts(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL UNIQUE,
  device_name TEXT,
  token_hash TEXT NOT NULL,
  token_secret_enc TEXT,
  token_prefix TEXT NOT NULL,
  account_login TEXT,
  server TEXT,
  status TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('CONNECTED','DEGRADED','OFFLINE')),
  last_heartbeat TIMESTAMPTZ,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  terminal_connected BOOLEAN NOT NULL DEFAULT false,
  trade_allowed BOOLEAN NOT NULL DEFAULT false,
  ea_trade_allowed BOOLEAN NOT NULL DEFAULT false,
  algo_trading_enabled BOOLEAN NOT NULL DEFAULT false,
  terminal_build TEXT,
  ea_version TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES mt5_connections(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  canonical TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('MT5','DEMO_SIMULATED')),
  spec JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id TEXT PRIMARY KEY,
  watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  canonical TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('DEMO','LIVE')),
  ticket TEXT NOT NULL,
  broker_ticket TEXT,
  symbol TEXT NOT NULL,
  canonical TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  type TEXT NOT NULL CHECK (type IN ('MARKET','LIMIT','STOP','STOP_LIMIT')),
  volume NUMERIC(18,4) NOT NULL,
  price NUMERIC(18,8) NOT NULL,
  stop_limit_price NUMERIC(18,8),
  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  expiration TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','FILLED','CANCELLED','REJECTED','EXPIRED')),
  comment TEXT,
  magic BIGINT NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','STRATEGY')),
  strategy_id TEXT,
  client_request_id TEXT,
  command_id TEXT,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  source TEXT NOT NULL CHECK (source IN ('MT5','DEMO_SIMULATED'))
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('DEMO','LIVE')),
  ticket TEXT NOT NULL,
  broker_ticket TEXT,
  symbol TEXT NOT NULL,
  canonical TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  volume NUMERIC(18,4) NOT NULL,
  open_price NUMERIC(18,8) NOT NULL,
  current_price NUMERIC(18,8) NOT NULL,
  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  swap NUMERIC(18,2) NOT NULL DEFAULT 0,
  commission NUMERIC(18,2) NOT NULL DEFAULT 0,
  profit NUMERIC(18,2) NOT NULL DEFAULT 0,
  profit_percent NUMERIC(18,4) NOT NULL DEFAULT 0,
  magic BIGINT NOT NULL DEFAULT 0,
  comment TEXT,
  origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','STRATEGY')),
  strategy_id TEXT,
  risk_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  account_login TEXT NOT NULL,
  open_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL CHECK (source IN ('MT5','DEMO_SIMULATED')),
  meta JSONB
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('DEMO','LIVE')),
  ticket TEXT NOT NULL,
  deal_ticket TEXT,
  symbol TEXT NOT NULL,
  canonical TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  volume NUMERIC(18,4) NOT NULL,
  entry_price NUMERIC(18,8) NOT NULL,
  exit_price NUMERIC(18,8) NOT NULL,
  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  commission NUMERIC(18,2) NOT NULL DEFAULT 0,
  swap NUMERIC(18,2) NOT NULL DEFAULT 0,
  gross_profit NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_profit NUMERIC(18,2) NOT NULL DEFAULT 0,
  open_time TIMESTAMPTZ NOT NULL,
  close_time TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  magic BIGINT NOT NULL DEFAULT 0,
  comment TEXT,
  origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','STRATEGY')),
  strategy_id TEXT,
  account_login TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('MT5','DEMO_SIMULATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  canonical TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('ABOVE','BELOW')),
  price NUMERIC(18,8) NOT NULL,
  triggered BOOLEAN NOT NULL DEFAULT false,
  triggered_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  max_risk_per_trade_percent NUMERIC(6,3) NOT NULL DEFAULT 1,
  max_daily_loss_percent NUMERIC(6,3) NOT NULL DEFAULT 3,
  max_open_positions INTEGER NOT NULL DEFAULT 5,
  max_total_exposure_lots NUMERIC(18,4) NOT NULL DEFAULT 5,
  max_lot_size NUMERIC(18,4) NOT NULL DEFAULT 1,
  max_daily_trades INTEGER,
  max_consecutive_losses INTEGER NOT NULL DEFAULT 0,
  require_live_confirmation BOOLEAN NOT NULL DEFAULT true,
  max_slippage_points INTEGER NOT NULL DEFAULT 20,
  trading_hours_enabled BOOLEAN NOT NULL DEFAULT false,
  trading_hours JSONB NOT NULL DEFAULT '[]'::jsonb,
  strategy_engine_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('DEMO','LIVE')),
  balance NUMERIC(18,2) NOT NULL,
  equity NUMERIC(18,2) NOT NULL,
  margin NUMERIC(18,2) NOT NULL DEFAULT 0,
  free_margin NUMERIC(18,2) NOT NULL DEFAULT 0,
  open_pl NUMERIC(18,2) NOT NULL DEFAULT 0,
  time TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_journal (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id TEXT REFERENCES trades(id) ON DELETE SET NULL,
  ticket TEXT,
  symbol TEXT,
  setup TEXT,
  reason_for_entry TEXT,
  market_conditions TEXT,
  emotion TEXT,
  mistakes TEXT,
  lesson TEXT,
  notes TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  screenshot_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('DEMO','LIVE')),
  sequence BIGSERIAL,
  action TEXT NOT NULL,
  symbol TEXT,
  volume NUMERIC(18,4),
  price NUMERIC(18,8),
  stop_loss NUMERIC(18,8),
  take_profit NUMERIC(18,8),
  broker_ticket TEXT,
  result TEXT NOT NULL CHECK (result IN ('SUCCESS','FAILURE','REJECTED','PENDING')),
  error_code TEXT,
  error_message TEXT,
  ip TEXT,
  user_agent TEXT,
  device_id TEXT,
  command_id TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('info','success','warning','critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bridge_commands (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  action TEXT NOT NULL,
  symbol TEXT,
  envelope JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','DELIVERED','COMPLETED','FAILED','EXPIRED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result JSONB,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,
  symbol TEXT NOT NULL,
  canonical TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_per_trade_percent NUMERIC(6,3) NOT NULL DEFAULT 1,
  max_positions INTEGER NOT NULL DEFAULT 1,
  last_signal_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Indexes
-- ===========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx     ON users (lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS broker_accounts_user_mode_idx ON broker_accounts (user_id, mode);
CREATE INDEX IF NOT EXISTS broker_accounts_login_idx         ON broker_accounts (login);

CREATE INDEX IF NOT EXISTS mt5_connections_user_idx          ON mt5_connections (user_id);
CREATE INDEX IF NOT EXISTS mt5_connections_account_idx       ON mt5_connections (account_id);
CREATE INDEX IF NOT EXISTS mt5_connections_status_idx        ON mt5_connections (status);

CREATE UNIQUE INDEX IF NOT EXISTS symbols_connection_symbol_idx ON symbols (connection_id, symbol);
CREATE INDEX IF NOT EXISTS symbols_user_canonical_idx        ON symbols (user_id, canonical);

CREATE INDEX IF NOT EXISTS watchlists_user_idx               ON watchlists (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS watchlists_default_idx      ON watchlists (user_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS watchlist_items_unique_idx  ON watchlist_items (watchlist_id, canonical);
CREATE INDEX IF NOT EXISTS watchlist_items_position_idx      ON watchlist_items (watchlist_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS orders_ticket_mode_idx      ON orders (mode, ticket);
CREATE INDEX IF NOT EXISTS orders_account_status_idx         ON orders (account_id, status);
CREATE INDEX IF NOT EXISTS orders_user_placed_idx            ON orders (user_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS orders_client_request_idx         ON orders (client_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_client_request_unique_idx ON orders (user_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS positions_ticket_mode_idx   ON positions (mode, ticket);
CREATE INDEX IF NOT EXISTS positions_account_idx             ON positions (account_id);
CREATE INDEX IF NOT EXISTS positions_user_idx                ON positions (user_id);

CREATE INDEX IF NOT EXISTS trades_account_close_idx          ON trades (account_id, close_time DESC);
CREATE INDEX IF NOT EXISTS trades_user_idx                   ON trades (user_id);
CREATE INDEX IF NOT EXISTS trades_canonical_idx              ON trades (canonical);
CREATE UNIQUE INDEX IF NOT EXISTS trades_deal_ticket_idx      ON trades (mode, deal_ticket) WHERE deal_ticket IS NOT NULL;

CREATE INDEX IF NOT EXISTS price_alerts_user_idx             ON price_alerts (user_id, triggered);
CREATE INDEX IF NOT EXISTS price_alerts_symbol_idx           ON price_alerts (canonical);

CREATE INDEX IF NOT EXISTS portfolio_snapshots_account_time_idx ON portfolio_snapshots (account_id, time DESC);
CREATE INDEX IF NOT EXISTS portfolio_snapshots_user_mode_idx    ON portfolio_snapshots (user_id, mode, time DESC);

CREATE INDEX IF NOT EXISTS trade_journal_user_created_idx    ON trade_journal (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_journal_ticket_idx          ON trade_journal (ticket);

CREATE INDEX IF NOT EXISTS audit_logs_user_created_idx       ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx            ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_mode_action_idx        ON audit_logs (mode, action);
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_sequence_idx     ON audit_logs (sequence);

CREATE INDEX IF NOT EXISTS notifications_user_read_idx       ON notifications (user_id, read, created_at DESC);

CREATE INDEX IF NOT EXISTS bridge_commands_device_status_idx ON bridge_commands (device_id, status);
CREATE INDEX IF NOT EXISTS bridge_commands_user_created_idx  ON bridge_commands (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_user_scope_key_idx ON idempotency_keys (user_id, scope, key);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx            ON idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS strategies_user_enabled_idx       ON strategies (user_id, enabled);

-- ===========================================================================
-- Append-only audit log
-- ===========================================================================
-- The rules below make UPDATE and DELETE on audit_logs no-ops for every role,
-- including the application role. Rows can only be inserted. Removing this
-- protection requires an explicit ALTER TABLE by a database superuser, which is
-- exactly the kind of out-of-band change an audit trail is meant to expose.
CREATE OR REPLACE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

-- ===========================================================================
-- Documentation for operators
-- ===========================================================================
COMMENT ON TABLE users IS 'Trading users. Passwords are scrypt hashes; no broker credential is stored here.';
COMMENT ON TABLE broker_accounts IS 'One row per (user, mode). DEMO rows are simulated; LIVE rows mirror the user''s own MT5 account.';
COMMENT ON TABLE mt5_connections IS 'MT5 EA device registrations: token hash + encrypted signing secret only. Revocable.';
COMMENT ON TABLE symbols IS 'Broker symbol specifications exactly as reported by MT5 (or the demo profile). Never hard-coded.';
COMMENT ON TABLE orders IS 'Pending orders. status=FILLED rows become positions; the full lifecycle is kept for history.';
COMMENT ON TABLE positions IS 'Open positions with live P/L, stop loss and take profit, mirrored from MT5 in LIVE mode.';
COMMENT ON TABLE trades IS 'Closed trades (one row per closed position) with entry, exit, commission, swap and net P/L.';
COMMENT ON TABLE price_alerts IS 'Server-side price alerts evaluated against the streaming quote feed.';
COMMENT ON TABLE risk_settings IS 'Per-user risk limits enforced by the backend before any order reaches a broker.';
COMMENT ON TABLE portfolio_snapshots IS 'Recorded balance/equity samples used for the equity curve. No snapshot is invented.';
COMMENT ON TABLE trade_journal IS 'Trader notes attached to tickets. Private to the account owner.';
COMMENT ON TABLE audit_logs IS 'APPEND-ONLY. Every live action, rejection and configuration change is recorded here.';
COMMENT ON TABLE notifications IS 'In-app notifications (order fills, alerts, risk locks, bridge problems).';
COMMENT ON TABLE bridge_commands IS 'Signed commands sent to MT5 EAs, with delivery status and replay-protected ids.';
COMMENT ON TABLE idempotency_keys IS 'Idempotency keys so a retried order request can never execute twice.';
COMMENT ON TABLE strategies IS 'Optional strategy engine definitions. Disabled by default; signals only.';

COMMIT;

-- ===========================================================================
-- Notes
-- ===========================================================================
-- • audit_logs.sequence is a BIGSERIAL and must stay monotonic. Do not reset it.
-- • Deploying to a managed PostgreSQL (RDS, Supabase, Neon, Vercel Postgres) is
--   supported: this file only uses portable DDL. The cited type is TEXT with a
--   UNIQUE index on lower(email), so the citext extension is not required.
-- • The backend refuses to start against a database whose tables are missing
--   (PostgresStore.init throws "Table … is missing") unless USE_IN_MEMORY_DB is
--   set, so a half-applied schema surfaces immediately instead of failing later.
