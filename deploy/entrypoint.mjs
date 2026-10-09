#!/usr/bin/env node
/**
 * TradePilot container entrypoint.
 *
 * One container runs both processes:
 *
 *   Fastify API    →  127.0.0.1:$API_PORT   (never exposed)
 *   Next terminal  →  0.0.0.0:$PORT          (the only public port)
 *
 * The terminal proxies /api and /ws to the API, so a single public port serves
 * the UI, the REST API and the WebSocket — and the browser never learns where
 * the API lives. Nothing here is a credential store: SESSION_SECRET and
 * BRIDGE_SECRET come from the environment and never reach the client bundle.
 *
 * Paths resolve relative to the repository root, so this file behaves
 * identically inside the image (repo at /app) and on a developer's machine.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = Number(process.env.API_PORT ?? 8080);
const apiHost = process.env.API_HOST ?? '127.0.0.1';
const webPort = Number(process.env.PORT ?? 3000);
const backendUrl = process.env.BACKEND_URL ?? `http://${apiHost}:${apiPort}`;

const children = [];
let shuttingDown = false;

function start(name, cwd, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: resolve(root, cwd),
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[entrypoint] ${name} exited (code=${code} signal=${signal}) — stopping the container`);
    shutdown(1);
  });
  children.push(child);
  console.log(`[entrypoint] ${name} started (pid ${child.pid})`);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3_000).unref();
}

async function waitForApi() {
  const url = `${backendUrl}/api/v1/system/health`;
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log(`[entrypoint] API healthy after ${attempt}s`);
        return true;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.error(`[entrypoint] API did not become healthy at ${url} within 60s`);
  return false;
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[entrypoint] ${signal} received`);
    shutdown(0);
  });
}

console.log(`[entrypoint] TradePilot starting — API on ${backendUrl}, terminal on :${webPort}`);

start('api', 'backend', ['--import', 'tsx', 'src/index.ts'], {
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  HOST: apiHost,
  PORT: String(apiPort),
});

// Start the terminal even if the health probe times out: Next renders its own
// "backend unavailable" message, which is more useful than a dead container.
void waitForApi();

start('terminal', 'frontend', ['--import', 'tsx', 'server.ts'], {
  NODE_ENV: process.env.NODE_ENV ?? 'production',
  HOST: process.env.HOST ?? '0.0.0.0',
  PORT: String(webPort),
  BACKEND_URL: backendUrl,
});
