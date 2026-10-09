#!/usr/bin/env node
/**
 * TradePilot — apply database/schema.sql to PostgreSQL.
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/tradepilot npm run db:setup
 *
 * The schema is idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
 * EXISTS / CREATE OR REPLACE RULE), so running this repeatedly is safe. The
 * backend also applies it automatically on boot unless AUTO_MIGRATE=false.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../database/schema.sql');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    [
      'DATABASE_URL is not set.',
      '',
      'TradePilot runs without PostgreSQL (in-memory store) for local demo use,',
      'but nothing is persisted in that mode. To use PostgreSQL:',
      '',
      '  export DATABASE_URL="postgres://tradepilot:secret@127.0.0.1:5432/tradepilot"',
      '  npm run db:setup',
      '  npm run seed',
    ].join('\n'),
  );
  process.exit(1);
}

let pg;
try {
  pg = await import('pg');
} catch {
  console.error('The "pg" package is missing. Run `npm install` from the repository root first.');
  process.exit(1);
}

const sql = await readFile(schemaPath, 'utf8');
const { Pool } = pg.default ?? pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });

try {
  const client = await pool.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    console.log(`Applied ${schemaPath}`);
    console.log(`Tables now present (${rows.length}): ${rows.map((row) => row.table_name).join(', ')}`);
    console.log('Next: npm run seed');
  } finally {
    client.release();
  }
} catch (error) {
  console.error(`Failed to apply the schema: ${error.message}`);
  process.exit(1);
} finally {
  await pool.end();
}
