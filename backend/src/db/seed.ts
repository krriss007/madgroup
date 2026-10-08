/**
 * TradePilot — database seed.
 *
 * Creates the minimum records the terminal needs to be usable, and nothing
 * more. It is idempotent: running it twice does not duplicate anything.
 *
 * What it seeds
 *   1. the demo user (email/password from the environment, SEED_DEMO_USER only)
 *   2. the DEMO broker account ($10,000 simulated balance — no real money)
 *   3. the default watchlist (the 11 core XAU/USD + FX instruments)
 *   4. risk settings with conservative defaults (1% per trade, 3% daily loss …)
 *
 * What it deliberately does NOT seed
 *   • No trades, no positions, no P/L, no deposits, no withdrawals, no
 *     balances that pretend to be real. An empty account is the honest state,
 *     and the analytics panel says "no trades yet" until you actually trade.
 *   • No broker credentials of any kind. A LIVE account appears only after the
 *     user connects their own MT5 terminal through the bridge device token.
 *
 * Usage
 *   npm run seed                 # from the repository root
 *   npm run seed -w @tradepilot/backend
 *   DATABASE_URL=postgres://… npm run seed
 */

import { loadEnv } from '../config/env';
import { createLogger } from '../lib/logger';
import { createStore } from './index';
import { AccountService } from '../services/account.service';
import { AuthService } from '../services/auth.service';
import { RiskService } from '../services/risk.service';

export interface SeedResult {
  store: 'memory' | 'postgres';
  created: {
    user: boolean;
    demoAccount: boolean;
    watchlist: boolean;
    riskSettings: boolean;
  };
  email: string;
  balance: number;
  symbols: number;
  notes: string[];
}

export async function seedDatabase(): Promise<SeedResult> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, { service: 'tradepilot-seed' });
  const { store, fellBack } = await createStore(env, logger);

  const accounts = new AccountService(store, env, logger);
  const auth = new AuthService(store, env, logger, accounts);
  const risk = new RiskService(store, logger);

  const email = env.DEMO_USER_EMAIL.trim().toLowerCase();
  const notes: string[] = [];

  if (fellBack) {
    notes.push(
      'PostgreSQL was requested but unreachable — everything below lives in memory and disappears when this process exits.',
    );
  }

  /* 1. demo user ------------------------------------------------------- */
  let user = await store.users.findOne({ email: { eq: email } });
  const createdUser = !user;
  if (!user) {
    if (!env.SEED_DEMO_USER) {
      throw new Error(
        'Demo user does not exist and SEED_DEMO_USER=false. Set SEED_DEMO_USER=true (or create the account through the API) before seeding.',
      );
    }
    const registered = await auth.register({
      email,
      password: env.DEMO_USER_PASSWORD,
      displayName: 'Demo Trader',
    });
    user = registered.user;
    notes.push(
      `Demo user created with the password from DEMO_USER_PASSWORD. Change it in Settings before exposing this instance to a network.`,
    );
  }

  /* 2. demo account ---------------------------------------------------- */
  const beforeAccount = await store.brokerAccounts.findOne({ userId: { eq: user.id }, mode: { eq: 'DEMO' } });
  const account = await accounts.ensureDemoAccount(user.id);

  /* 3. default watchlist ---------------------------------------------- */
  const beforeWatchlist = await store.watchlists.findOne({ userId: { eq: user.id }, isDefault: { eq: true } });
  await accounts.ensureDefaultWatchlist(user.id);
  const watchlist = await store.watchlists.findOne({ userId: { eq: user.id }, isDefault: { eq: true } });
  const items = watchlist
    ? await store.watchlistItems.findMany({ watchlistId: { eq: watchlist.id } })
    : [];

  /* 4. risk settings --------------------------------------------------- */
  const beforeRisk = await store.riskSettings.findOne({ userId: { eq: user.id } });
  const settings = await risk.getSettings(user.id);

  notes.push(
    `DEMO account ${account.login} starts with ${account.startingBalance.toFixed(2)} ${account.currency} of simulated balance — never presented as real funds.`,
  );
  notes.push(
    `Risk limits: ${settings.maxRiskPerTradePercent}% per trade, ${settings.maxDailyLossPercent}% daily loss, max ${settings.maxOpenPositions} open positions, max ${settings.maxLotSize} lot per order, live confirmation ${
      settings.requireLiveConfirmation ? 'required' : 'disabled'
    }.`,
  );
  notes.push(
    'LIVE trading stays disabled until (a) an MT5 device is connected, (b) the account is authorised, and (c) you explicitly enable it in Settings.',
  );

  logger.info(
    {
      store: store.kind,
      email,
      demoAccount: account.login,
      watchlistSymbols: items.map((item) => item.canonical),
    },
    'seed complete',
  );

  await store.close().catch(() => undefined);

  return {
    store: fellBack ? 'memory' : (store.kind as 'memory' | 'postgres'),
    created: {
      user: createdUser,
      demoAccount: !beforeAccount,
      watchlist: !beforeWatchlist,
      riskSettings: !beforeRisk,
    },
    email,
    balance: account.startingBalance,
    symbols: items.length,
    notes,
  };
}

const isDirectRun =
  process.argv[1] !== undefined && /[\\/]db[\\/]seed\.(ts|mjs|js)$/.test(process.argv[1]);

if (isDirectRun) {
  seedDatabase()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log('\nTradePilot seed complete');
      // eslint-disable-next-line no-console
      console.log(`  store          : ${result.store}`);
      // eslint-disable-next-line no-console
      console.log(`  demo login     : ${result.email}`);
      // eslint-disable-next-line no-console
      console.log(`  demo balance   : ${result.balance.toFixed(2)} (simulated)`);
      // eslint-disable-next-line no-console
      console.log(`  watchlist      : ${result.symbols} instruments`);
      for (const note of result.notes) {
        // eslint-disable-next-line no-console
        console.log(`  note           : ${note}`);
      }
      process.exit(0);
    })
    .catch((error: Error) => {
      // eslint-disable-next-line no-console
      console.error(`\nSeed failed: ${error.message}`);
      process.exit(1);
    });
}
