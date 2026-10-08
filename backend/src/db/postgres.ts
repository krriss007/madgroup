/**
 * TradePilot — PostgreSQL store.
 *
 * Thin, typed SQL layer over the tables defined in database/schema.sql (the SQL
 * mirror of prisma/schema.prisma). All statements are parameterised; column
 * names are validated against the live information_schema at boot, so a typo or
 * an unexpected field can never turn into injectable SQL.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type {
  Filter,
  FilterValue,
  FindOptions,
  Store,
  Table,
} from './types';
import type { Logger } from '../lib/logger';

const { Pool } = pg;

// NUMERIC/BIGINT come back as strings from node-postgres; the domain works with
// numbers. Money columns are declared NUMERIC(18,2) so precision is preserved.
pg.types.setTypeParser(1700, (value: string) => (value == null ? null : Number.parseFloat(value)));
pg.types.setTypeParser(20, (value: string) => (value == null ? null : Number.parseInt(value, 10)));

const TABLE_NAMES = {
  users: 'users',
  brokerAccounts: 'broker_accounts',
  mt5Connections: 'mt5_connections',
  symbols: 'symbols',
  watchlists: 'watchlists',
  watchlistItems: 'watchlist_items',
  orders: 'orders',
  positions: 'positions',
  trades: 'trades',
  priceAlerts: 'price_alerts',
  riskSettings: 'risk_settings',
  portfolioSnapshots: 'portfolio_snapshots',
  journal: 'trade_journal',
  auditLogs: 'audit_logs',
  notifications: 'notifications',
  bridgeCommands: 'bridge_commands',
  idempotencyKeys: 'idempotency_keys',
  strategies: 'strategies',
} as const;

type LogicalName = keyof typeof TABLE_NAMES;
type Row = Record<string, unknown> & { id: string };

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function normaliseOutgoing(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normaliseIncoming(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

export class PostgresTable<T extends { id: string }> implements Table<T> {
  constructor(
    private readonly pool: pg.Pool,
    readonly tableName: string,
    private readonly columns: Set<string>,
    private readonly immutable = false,
  ) {}

  private columnFor(field: string): string | null {
    const column = camelToSnake(field);
    return this.columns.has(column) ? column : null;
  }

  private toRow(record: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const column = this.columnFor(key);
      if (!column) continue;
      out[column] = normaliseOutgoing(value);
    }
    return out;
  }

  private fromRow(row: Record<string, unknown>): T {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[snakeToCamel(key)] = normaliseIncoming(value);
    }
    return out as T;
  }

  async insert(row: T): Promise<T> {
    const data = this.toRow(row as unknown as Record<string, unknown>);
    const keys = Object.keys(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${this.tableName} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const result = await this.pool.query(sql, Object.values(data));
    return this.fromRow(result.rows[0] as Record<string, unknown>);
  }

  async upsert(row: T): Promise<T> {
    const data = this.toRow(row as unknown as Record<string, unknown>);
    const keys = Object.keys(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const updates = keys.filter((k) => k !== 'id').map((k) => `"${k}" = EXCLUDED."${k}"`).join(', ');
    const sql = `INSERT INTO ${this.tableName} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders})
      ON CONFLICT (id) DO UPDATE SET ${updates} RETURNING *`;
    const result = await this.pool.query(sql, Object.values(data));
    return this.fromRow(result.rows[0] as Record<string, unknown>);
  }

  async update(id: string, patch: Partial<T>): Promise<T | null> {
    if (this.immutable) throw new Error(`${this.tableName} is append-only: updates are not permitted`);
    const data = this.toRow(patch as Record<string, unknown>);
    const keys = Object.keys(data).filter((k) => k !== 'id');
    if (!keys.length) return this.findById(id);
    const assignments = keys.map((key, i) => `"${key}" = $${i + 1}`).join(', ');
    const sql = `UPDATE ${this.tableName} SET ${assignments} WHERE id = $${keys.length + 1} RETURNING *`;
    const result = await this.pool.query(sql, [...keys.map((k) => data[k]), id]);
    const row = result.rows[0];
    return row ? this.fromRow(row as Record<string, unknown>) : null;
  }

  async findById(id: string): Promise<T | null> {
    const result = await this.pool.query(`SELECT * FROM ${this.tableName} WHERE id = $1 LIMIT 1`, [id]);
    const row = result.rows[0];
    return row ? this.fromRow(row as Record<string, unknown>) : null;
  }

  private buildWhere(filter?: Filter<T>): { clause: string; values: unknown[] } {
    if (!filter) return { clause: '', values: [] };
    const conditions: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, expression: (placeholder: string) => string, value: unknown): void => {
      values.push(value);
      conditions.push(expression(`$${values.length}`));
    };

    for (const [field, raw] of Object.entries(filter as Record<string, unknown>)) {
      const column = this.columnFor(field);
      if (!column) continue;
      const expected = raw as FilterValue<never>;
      if (expected === null) {
        conditions.push(`"${column}" IS NULL`);
        continue;
      }
      if (typeof expected === 'object' && expected !== null && !Array.isArray(expected) && !(expected instanceof Date)) {
        const op = expected as Record<string, unknown>;
        if ('eq' in op) push(column, (p) => `"${column}" = ${p}`, op.eq);
        if ('ne' in op) push(column, (p) => `"${column}" <> ${p}`, op.ne);
        if ('gt' in op) push(column, (p) => `"${column}" > ${p}`, op.gt);
        if ('gte' in op) push(column, (p) => `"${column}" >= ${p}`, op.gte);
        if ('lt' in op) push(column, (p) => `"${column}" < ${p}`, op.lt);
        if ('lte' in op) push(column, (p) => `"${column}" <= ${p}`, op.lte);
        if ('in' in op && Array.isArray(op.in)) push(column, (p) => `"${column}" = ANY(${p})`, op.in);
        if ('isNull' in op) conditions.push(`"${column}" IS ${op.isNull ? '' : 'NOT '}NULL`);
        if ('like' in op && typeof op.like === 'string') push(column, (p) => `"${column}" ILIKE ${p}`, op.like.replace(/\*/g, '%'));
        continue;
      }
      push(column, (p) => `"${column}" = ${p}`, normaliseOutgoing(expected));
    }

    return {
      clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      values,
    };
  }

  private buildOrderAndPage(options?: FindOptions<T>): string {
    const parts: string[] = [];
    if (options?.orderBy?.length) {
      const clauses = options.orderBy
        .map((rule) => {
          const column = this.columnFor(rule.field);
          if (!column) return null;
          return `"${column}" ${rule.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
        })
        .filter((v): v is string => v != null);
      if (clauses.length) parts.push(`ORDER BY ${clauses.join(', ')}`);
    }
    if (options?.limit != null) parts.push(`LIMIT ${Math.max(0, Math.floor(options.limit))}`);
    if (options?.offset != null) parts.push(`OFFSET ${Math.max(0, Math.floor(options.offset))}`);
    return parts.join(' ');
  }

  async findOne(filter: Filter<T>, options?: FindOptions<T>): Promise<T | null> {
    const { clause, values } = this.buildWhere(filter);
    const sql = `SELECT * FROM ${this.tableName} ${clause} ${this.buildOrderAndPage({ ...options, limit: 1 })}`;
    const result = await this.pool.query(sql, values);
    const row = result.rows[0];
    return row ? this.fromRow(row as Record<string, unknown>) : null;
  }

  async findMany(filter?: Filter<T>, options?: FindOptions<T>): Promise<T[]> {
    const { clause, values } = this.buildWhere(filter);
    const sql = `SELECT * FROM ${this.tableName} ${clause} ${this.buildOrderAndPage(options)}`;
    const result = await this.pool.query(sql, values);
    return result.rows.map((row) => this.fromRow(row as Record<string, unknown>));
  }

  async count(filter?: Filter<T>): Promise<number> {
    const { clause, values } = this.buildWhere(filter);
    const result = await this.pool.query(`SELECT COUNT(*)::int AS count FROM ${this.tableName} ${clause}`, values);
    return Number((result.rows[0] as { count: number }).count ?? 0);
  }

  async delete(id: string): Promise<boolean> {
    if (this.immutable) throw new Error(`${this.tableName} is append-only: deletes are not permitted`);
    const result = await this.pool.query(`DELETE FROM ${this.tableName} WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    if (this.immutable) throw new Error(`${this.tableName} is append-only: deletes are not permitted`);
    const { clause, values } = this.buildWhere(filter);
    const result = await this.pool.query(`DELETE FROM ${this.tableName} ${clause}`, values);
    return result.rowCount ?? 0;
  }
}

export interface PostgresStoreOptions {
  connectionString: string;
  poolMax?: number;
  logger: Logger;
  /** Run database/schema.sql on boot (idempotent, CREATE TABLE IF NOT EXISTS). */
  autoMigrate?: boolean;
  schemaPath?: string;
}

export function defaultSchemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../database/schema.sql');
}

export function createPostgresPool(options: PostgresStoreOptions): pg.Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'tradepilot-backend',
  });
}

export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;
  readonly pool: pg.Pool;

  users!: Table<(Tables['users'] extends Table<infer R> ? R : never)>;
  brokerAccounts!: Store['brokerAccounts'];
  mt5Connections!: Store['mt5Connections'];
  symbols!: Store['symbols'];
  watchlists!: Store['watchlists'];
  watchlistItems!: Store['watchlistItems'];
  orders!: Store['orders'];
  positions!: Store['positions'];
  trades!: Store['trades'];
  priceAlerts!: Store['priceAlerts'];
  riskSettings!: Store['riskSettings'];
  portfolioSnapshots!: Store['portfolioSnapshots'];
  journal!: Store['journal'];
  auditLogs!: Store['auditLogs'];
  notifications!: Store['notifications'];
  bridgeCommands!: Store['bridgeCommands'];
  idempotencyKeys!: Store['idempotencyKeys'];
  strategies!: Store['strategies'];

  private columnCache = new Map<string, Set<string>>();

  constructor(private readonly options: PostgresStoreOptions) {
    this.pool = createPostgresPool(options);
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }

    if (this.options.autoMigrate !== false) {
      const schemaPath = this.options.schemaPath ?? defaultSchemaPath();
      try {
        const sql = await readFile(schemaPath, 'utf8');
        await this.pool.query(sql);
        this.options.logger.info({ schemaPath }, 'database schema ensured');
      } catch (error) {
        this.options.logger.warn(
          { error: (error as Error).message, schemaPath },
          'could not apply database/schema.sql automatically — run `npm run db:setup`',
        );
      }
    }

    const { rows } = await this.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`,
    );
    for (const row of rows) {
      const set = this.columnCache.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      this.columnCache.set(row.table_name, set);
    }

    const build = <K extends LogicalName>(name: K, immutable = false): Store[K] => {
      const tableName = TABLE_NAMES[name];
      const columns = this.columnCache.get(tableName);
      if (!columns) {
        throw new Error(`Table ${tableName} is missing — apply database/schema.sql (npm run db:setup)`);
      }
      return new PostgresTable<Row>(this.pool, tableName, columns, immutable) as unknown as Store[K];
    };

    this.users = build('users') as Store['users'];
    this.brokerAccounts = build('brokerAccounts');
    this.mt5Connections = build('mt5Connections');
    this.symbols = build('symbols');
    this.watchlists = build('watchlists');
    this.watchlistItems = build('watchlistItems');
    this.orders = build('orders');
    this.positions = build('positions');
    this.trades = build('trades');
    this.priceAlerts = build('priceAlerts');
    this.riskSettings = build('riskSettings');
    this.portfolioSnapshots = build('portfolioSnapshots');
    this.journal = build('journal');
    this.auditLogs = build('auditLogs', true);
    this.notifications = build('notifications');
    this.bridgeCommands = build('bridgeCommands');
    this.idempotencyKeys = build('idempotencyKeys');
    this.strategies = build('strategies');
  }

  async healthcheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, detail: 'postgresql' };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  async nextAuditSequence(): Promise<number> {
    const result = await this.pool.query<{ nextval: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS nextval FROM audit_logs`,
    );
    return Number(result.rows[0]?.nextval ?? 1);
  }

  async cleanup(now: Date = new Date()): Promise<{ commands: number; idempotency: number }> {
    const iso = now.toISOString();
    const commands = await this.pool.query(
      `DELETE FROM bridge_commands WHERE expires_at < $1 AND status IN ('COMPLETED','FAILED','EXPIRED')`,
      [iso],
    );
    const idempotency = await this.pool.query(`DELETE FROM idempotency_keys WHERE expires_at < $1`, [iso]);
    return { commands: commands.rowCount ?? 0, idempotency: idempotency.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Local type import kept at the bottom to avoid a circular reference at runtime.
import type { Tables } from './types';
