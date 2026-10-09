/**
 * TradePilot — in-memory store.
 *
 * Semantics are identical to the PostgreSQL store (same filters, same ordering,
 * same immutability rules for the audit log) which lets the whole platform run
 * — demo trading included — without a database. Used by the local preview, the
 * test-suite and any deployment that has not configured DATABASE_URL yet.
 */

import type {
  AuditLogRow,
  Filter,
  FilterValue,
  FindOptions,
  Store,
  Table,
  Tables,
} from './types';

function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function matchesValue<T>(actual: unknown, expected: FilterValue<T> | undefined): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual == null;
  if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
    const op = expected as Record<string, unknown>;
    if ('eq' in op && actual !== op.eq) return false;
    if ('ne' in op && actual === op.ne) return false;
    if ('gt' in op && !(compareValues(actual, op.gt) > 0)) return false;
    if ('gte' in op && !(compareValues(actual, op.gte) >= 0)) return false;
    if ('lt' in op && !(compareValues(actual, op.lt) < 0)) return false;
    if ('lte' in op && !(compareValues(actual, op.lte) <= 0)) return false;
    if ('in' in op && Array.isArray(op.in) && !(op.in as unknown[]).some((v) => v === actual)) return false;
    if ('isNull' in op) {
      const shouldBeNull = Boolean(op.isNull);
      if (shouldBeNull && actual != null) return false;
      if (!shouldBeNull && actual == null) return false;
    }
    if ('like' in op && typeof op.like === 'string') {
      const needle = op.like.replace(/%/g, '').toLowerCase();
      if (!String(actual ?? '').toLowerCase().includes(needle)) return false;
    }
    return true;
  }
  return actual === expected;
}

function matchesFilter<T extends { id: string }>(row: T, filter?: Filter<T>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => matchesValue((row as Record<string, unknown>)[key], value as never));
}

function applyOptions<T extends { id: string }>(rows: T[], options?: FindOptions<T>): T[] {
  let out = rows;
  if (options?.orderBy?.length) {
    out = [...out].sort((a, b) => {
      for (const rule of options.orderBy!) {
        const comparison = compareValues((a as Record<string, unknown>)[rule.field], (b as Record<string, unknown>)[rule.field]);
        if (comparison !== 0) return rule.direction === 'desc' ? -comparison : comparison;
      }
      return 0;
    });
  }
  const offset = options?.offset ?? 0;
  const limit = options?.limit;
  if (limit != null) return out.slice(offset, offset + limit);
  if (offset > 0) return out.slice(offset);
  return out;
}

export class MemoryTable<T extends { id: string }> implements Table<T> {
  protected rows = new Map<string, T>();

  constructor(private readonly clone: (row: T) => T = (row) => structuredClone(row)) {}

  async insert(row: T): Promise<T> {
    if (this.rows.has(row.id)) throw new Error(`Duplicate primary key ${row.id}`);
    this.rows.set(row.id, this.clone(row));
    return this.clone(row);
  }

  async upsert(row: T): Promise<T> {
    this.rows.set(row.id, this.clone(row));
    return this.clone(row);
  }

  async update(id: string, patch: Partial<T>): Promise<T | null> {
    const existing = this.rows.get(id);
    if (!existing) return null;
    const next = { ...existing, ...patch } as T;
    this.rows.set(id, this.clone(next));
    return this.clone(next);
  }

  async findById(id: string): Promise<T | null> {
    const row = this.rows.get(id);
    return row ? this.clone(row) : null;
  }

  async findOne(filter: Filter<T>, options?: FindOptions<T>): Promise<T | null> {
    const found = await this.findMany(filter, { ...options, limit: 1 });
    return found[0] ?? null;
  }

  async findMany(filter?: Filter<T>, options?: FindOptions<T>): Promise<T[]> {
    const all = [...this.rows.values()].filter((row) => matchesFilter(row, filter));
    return applyOptions(all, options).map((row) => this.clone(row));
  }

  async count(filter?: Filter<T>): Promise<number> {
    return [...this.rows.values()].filter((row) => matchesFilter(row, filter)).length;
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    const targets = [...this.rows.values()].filter((row) => matchesFilter(row, filter));
    for (const row of targets) this.rows.delete(row.id);
    return targets.length;
  }
}

/** Audit log is append-only: updates and deletes are rejected, like in SQL. */
class AppendOnlyTable<T extends { id: string }> extends MemoryTable<T> {
  override async update(): Promise<T | null> {
    throw new Error('audit_logs is append-only: updates are not permitted');
  }

  override async delete(): Promise<boolean> {
    throw new Error('audit_logs is append-only: deletes are not permitted');
  }

  override async deleteMany(): Promise<number> {
    throw new Error('audit_logs is append-only: deletes are not permitted');
  }
}

type MemoryTables = {
  users: MemoryTable<Tables['users'] extends Table<infer R> ? R : never>;
};

type RowOf<K extends keyof Tables> = Tables[K] extends Table<infer R> ? R : never;

function table<K extends keyof Tables>(): MemoryTable<RowOf<K>> {
  return new MemoryTable<RowOf<K>>();
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  users = table<'users'>();
  brokerAccounts = table<'brokerAccounts'>();
  mt5Connections = table<'mt5Connections'>();
  symbols = table<'symbols'>();
  watchlists = table<'watchlists'>();
  watchlistItems = table<'watchlistItems'>();
  orders = table<'orders'>();
  positions = table<'positions'>();
  trades = table<'trades'>();
  priceAlerts = table<'priceAlerts'>();
  riskSettings = table<'riskSettings'>();
  portfolioSnapshots = table<'portfolioSnapshots'>();
  journal = table<'journal'>();
  auditLogs = new AppendOnlyTable<RowOf<'auditLogs'>>() as unknown as Table<RowOf<'auditLogs'>>;
  notifications = table<'notifications'>();
  bridgeCommands = table<'bridgeCommands'>();
  idempotencyKeys = table<'idempotencyKeys'>();
  strategies = table<'strategies'>();
  readonly backup = table<'strategies'>() as unknown as MemoryTable<RowOf<'strategies'>>;

  private auditSequence = 0;

  async init(): Promise<void> {
    // nothing to do for the in-memory store
  }

  async healthcheck(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'in-memory store (no DATABASE_URL configured)' };
  }

  async nextAuditSequence(): Promise<number> {
    this.auditSequence += 1;
    const persisted = await this.auditLogs.count();
    return Math.max(this.auditSequence, persisted + 1);
  }

  async cleanup(now: Date = new Date()): Promise<{ commands: number; idempotency: number }> {
    const iso = now.toISOString();
    const commands = await this.bridgeCommands.deleteMany({ expiresAt: { lt: iso }, status: { in: ['COMPLETED', 'FAILED', 'EXPIRED'] } });
    const idempotency = await this.idempotencyKeys.deleteMany({ expiresAt: { lt: iso } });
    return { commands, idempotency };
  }

  async close(): Promise<void> {
    // nothing to close
  }

  /** Test helper: wipe everything. */
  async reset(): Promise<void> {
    for (const key of [
      'users',
      'brokerAccounts',
      'mt5Connections',
      'symbols',
      'watchlists',
      'watchlistItems',
      'orders',
      'positions',
      'trades',
      'priceAlerts',
      'riskSettings',
      'portfolioSnapshots',
      'journal',
      'notifications',
      'bridgeCommands',
      'idempotencyKeys',
      'strategies',
    ] as const) {
      await (this[key] as MemoryTable<RowOf<typeof key>>).deleteMany({});
    }
    this.auditSequence = 0;
  }
}

export type { MemoryTables };
export { AppendOnlyTable };
export type { AuditLogRow };
