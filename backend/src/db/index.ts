/**
 * Store factory: PostgreSQL when DATABASE_URL is configured (and reachable),
 * otherwise the in-memory store so the platform can boot for local demo use.
 */

import { MemoryStore } from './memory';
import { PostgresStore, defaultSchemaPath } from './postgres';
import type { Store } from './types';
import type { Env } from '../config/env';
import type { Logger } from '../lib/logger';

export * from './types';
export { MemoryStore } from './memory';
export { PostgresStore } from './postgres';

export interface CreateStoreResult {
  store: Store;
  /** True when PostgreSQL was requested but could not be used. */
  fellBack: boolean;
  detail: string;
}

export async function createStore(env: Env, logger: Logger): Promise<CreateStoreResult> {
  const wantsPostgres = Boolean(env.DATABASE_URL) && !env.USE_IN_MEMORY_DB;

  if (!wantsPostgres) {
    const store = new MemoryStore();
    await store.init();
    logger.warn(
      { reason: env.USE_IN_MEMORY_DB ? 'USE_IN_MEMORY_DB=true' : 'DATABASE_URL not set' },
      'running on the in-memory store — data will not survive a restart (set DATABASE_URL for persistence)',
    );
    return { store, fellBack: false, detail: 'in-memory' };
  }

  const postgres = new PostgresStore({
    connectionString: env.DATABASE_URL!,
    poolMax: env.DATABASE_POOL_MAX,
    logger,
    schemaPath: defaultSchemaPath(),
  });

  try {
    await postgres.init();
    logger.info({ store: 'postgresql' }, 'connected to PostgreSQL');
    return { store: postgres, fellBack: false, detail: 'postgresql' };
  } catch (error) {
    logger.error(
      { error: (error as Error).message },
      'PostgreSQL unavailable — falling back to the in-memory store. Trading history will NOT be persisted.',
    );
    await postgres.close().catch(() => undefined);
    const store = new MemoryStore();
    await store.init();
    return { store, fellBack: true, detail: (error as Error).message };
  }
}
