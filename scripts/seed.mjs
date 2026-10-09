#!/usr/bin/env node
/**
 * TradePilot — seed the database (demo user, demo account, watchlist, risk
 * settings). Thin wrapper so the root `npm run seed` works without knowing the
 * workspace layout; the actual logic lives in backend/src/db/seed.ts.
 *
 *   npm run seed                     # in-memory store (demo only)
 *   DATABASE_URL=… npm run seed      # persistent PostgreSQL
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsx', resolve(root, 'backend/src/db/seed.ts')],
  { cwd: root, stdio: 'inherit', env: process.env },
);

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (error) => {
  console.error(`Could not start the seed: ${error.message}`);
  process.exit(1);
});
