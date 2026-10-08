/**
 * TradePilot — backend entry point.
 *
 * Boots the API, attaches the WebSocket hub to the same HTTP server and starts
 * the background jobs (demo market simulator, live-account sync, heartbeat
 * watchdog, optional strategy engine).
 */

import { buildApp } from './app';
import { loadEnv } from './config/env';
import { createContext } from './http/context';

async function main(): Promise<void> {
  const env = loadEnv();
  const context = await createContext({ env });

  const { app } = await buildApp({ context });

  // WebSocket hub on the same server, path /ws
  context.services.attachHub(app.server);

  // Seed the demo user so the terminal is usable immediately in local dev.
  if (env.SEED_DEMO_USER) {
    const email = env.DEMO_USER_EMAIL.toLowerCase();
    const existing = await context.store.users.findOne({ email: { eq: email } });
    if (!existing) {
      const { user } = await context.auth.register({
        email,
        password: env.DEMO_USER_PASSWORD,
        displayName: 'Demo Trader',
      });
      context.logger.warn(
        { email, password: env.DEMO_USER_PASSWORD },
        'seeded demo account — change this password before any real deployment',
      );
      void user;
    }
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  context.services.startBackgroundJobs();

  context.logger.info(
    {
      url: `http://${env.HOST}:${env.PORT}`,
      ws: `ws://${env.HOST}:${env.PORT}/ws`,
      mode: 'DEMO by default — LIVE requires an explicitly enabled MT5 connection',
    },
    'TradePilot backend listening',
  );

  const shutdown = async (signal: string): Promise<void> => {
    context.logger.info({ signal }, 'shutting down TradePilot backend');
    try {
      await app.close();
      await context.services.stopBackgroundJobs();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    context.logger.error({ reason: String(reason) }, 'unhandled promise rejection');
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', error);
  process.exit(1);
});
