/**
 * TradePilot — broker registry.
 *
 * Resolves the `TradingBroker` implementation for a (user, mode) pair. The rest
 * of the backend — and therefore the whole frontend — is agnostic about which
 * implementation is in play. Swapping in a direct broker API later (see
 * docs/ARCHITECTURE.md → ExnessDirectAPI) only requires a new case here.
 */

import { ErrorCode, TradePilotError, type TradingBroker, type TradingMode } from '@tradepilot/shared';
import type { Store } from '../../db/types';
import type { BrokerAccountRow } from '../../db/types';
import type { Env } from '../../config/env';
import type { Logger } from '../../lib/logger';
import type { AccountService } from '../account.service';
import type { DeviceService } from '../bridge/device.service';
import type { CommandQueueService } from '../bridge/command-queue.service';
import type { MarketService } from '../market.service';
import { MarketSimulator } from '../demo/market-simulator';
import { DemoBroker } from '../demo/demo-broker';
import { MT5BrokerBridge } from './mt5-broker-bridge';

export interface BrokerRegistryDeps {
  store: Store;
  env: Env;
  logger: Logger;
  accounts: AccountService;
  devices: DeviceService;
  queue: CommandQueueService;
  market: MarketService;
  simulator: MarketSimulator;
}

export class BrokerRegistry {
  constructor(private readonly deps: BrokerRegistryDeps) {}

  async forAccount(userId: string, account: BrokerAccountRow): Promise<TradingBroker> {
    if (account.mode === 'DEMO') {
      return new DemoBroker({
        store: this.deps.store,
        simulator: this.deps.simulator,
        context: { userId, accountId: account.id, mode: 'DEMO' },
        account,
      });
    }

    const connection = await this.deps.devices.connectionForAccount(account.id);
    const latest = connection ?? (await this.deps.devices.connectionForUser(userId));
    if (!latest) {
      throw new TradePilotError(
        ErrorCode.MT5_NOT_AUTHORIZED,
        'No MT5 device is connected to this account. Generate a device token in Settings → MT5 Connection and add it to the EA.',
        409,
      );
    }

    return new MT5BrokerBridge({
      store: this.deps.store,
      devices: this.deps.devices,
      queue: this.deps.queue,
      market: this.deps.market,
      logger: this.deps.logger,
      context: { userId, accountId: account.id, mode: 'LIVE' },
      connection: latest,
    });
  }

  /** Convenience: resolve (and lazily provision) the account for a mode. */
  async forMode(userId: string, mode: TradingMode): Promise<{ broker: TradingBroker; account: BrokerAccountRow }> {
    const account =
      mode === 'DEMO'
        ? await this.deps.accounts.ensureDemoAccount(userId)
        : await this.deps.accounts.requireActiveAccount(userId, mode);
    const broker = await this.forAccount(userId, account);
    return { broker, account };
  }
}
