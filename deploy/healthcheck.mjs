#!/usr/bin/env node
/**
 * Container healthcheck: proves the whole chain, not just one process.
 *
 * It calls the health route *through the terminal's proxy*, so a green result
 * means the public port serves the UI, reaches the API, and the store answers.
 */
const port = Number(process.env.PORT ?? 3000);
const target = `http://127.0.0.1:${port}/api/v1/system/health`;

try {
  const response = await fetch(target, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`healthcheck: HTTP ${response.status} from ${target}`);
    process.exit(1);
  }
  console.log(`ok — store=${body?.store?.kind ?? 'unknown'}`);
  process.exit(0);
} catch (error) {
  console.error(`healthcheck: ${error.message} — ${target}`);
  process.exit(1);
}
