#!/usr/bin/env node
/**
 * TradePilot — publish the MQL5 Expert Advisor into the frontend's static assets.
 *
 * The dashboard's MT5 setup page links to `/mt5/TradePilotBridge.mq5`,
 * `/mt5/include/TradePilot/*.mq5` and `/mt5/README.md` so the operator can
 * download exactly the build that matches this backend. Next.js only serves
 * files that live under `frontend/public`, and the MQL5 sources are the single
 * source of truth under `mt5/`, so this script copies them across instead of
 * asking anyone to keep two trees in sync by hand.
 *
 * It is wired into the frontend's `predev` / `prebuild` hooks, so the published
 * copy can never be older than the sources. Run it directly with:
 *
 *   node scripts/sync-mt5-public.mjs [--check]
 *
 * `--check` reports drift without writing (useful in CI).
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const sourceDir = join(root, 'mt5');
const installGuide = join(root, 'docs', 'MT5_EA_INSTALL.md');
const targetDir = join(root, 'frontend', 'public', 'mt5');

const checkOnly = process.argv.includes('--check');

/** Repo-relative path of every file that must appear under frontend/public/mt5. */
async function collectSources() {
  const files = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }

  await walk(sourceDir);
  files.sort();
  return files;
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

const sources = await collectSources();
if (!sources.length) {
  console.error('[sync-mt5] no MQL5 sources found under mt5/ — nothing to publish');
  process.exit(1);
}

if (checkOnly) {
  let stale = 0;
  for (const source of sources) {
    const target = join(targetDir, relative(sourceDir, source));
    if (!existsSync(target) || (await digest(target)) !== (await digest(source))) {
      console.error(`[sync-mt5] stale: ${relative(root, target)}`);
      stale += 1;
    }
  }
  if (existsSync(installGuide)) {
    const target = join(targetDir, 'README.md');
    if (!existsSync(target) || (await digest(target)) !== (await digest(installGuide))) {
      console.error(`[sync-mt5] stale: ${relative(root, target)}`);
      stale += 1;
    }
  }
  if (stale) {
    console.error(`[sync-mt5] ${stale} file(s) out of date — run: node scripts/sync-mt5-public.mjs`);
    process.exit(1);
  }
  console.log(`[sync-mt5] in sync (${sources.length + 1} files)`);
} else {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  for (const source of sources) {
    const target = join(targetDir, relative(sourceDir, source));
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }
  if (existsSync(installGuide)) {
    await cp(installGuide, join(targetDir, 'README.md'));
  }
  const files = await collectSources();
  console.log(
    `[sync-mt5] published ${files.length + 1} files to frontend/public/mt5 ` +
      `(EA + include/TradePilot/*.mq5 + README.md)`,
  );
}
