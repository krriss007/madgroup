/**
 * TradePilot — realtime snapshot builder.
 *
 * Produces the messages sent to a browser right after it connects (or when it
 * asks for a snapshot / switches between DEMO and LIVE). Keeping this in one
 * service means the WebSocket handshake, the "switch mode" action and the REST
 * snapshot endpoint all return identical data.
 */

import { ErrorCode, TradePilotError, type ServerMessage, type TradingMode } from '@tradepilot/shared';
import type { AccountService } from './account.service';
import type { RiskService } from './risk.service';
import type { MarketService } from './market.service';
import type { DeviceService } from './bridge/device.service';
import type { Store } from '../db/types';

export interface SnapshotDeps {
  store: Store;
  accounts: AccountService;
  risk: RiskService;
  market: MarketService;
  devices: DeviceService;
}

export class RealtimeService {
  constructor(private readonly deps: SnapshotDeps) {}

  async build(userId: string, mode: TradingMode): Promise<ServerMessage[]> {
    const messages: ServerMessage[] = [];
    const user = await this.deps.store.users.findById(userId);
    if (!user) throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Session user no longer exists.', 401);

    const account =
      mode === 'DEMO'
        ? await this.deps.accounts.ensureDemoAccount(userId)
        : await this.deps.accounts.getAccount(userId, 'LIVE');

    const connection = mode === 'LIVE' ? await this.deps.devices.connectionForAccount(account?.id ?? '') : null;
    const activeConnection = connection ?? (await this.deps.devices.connectionForUser(userId));
    const online = this.deps.devices.isOnline(activeConnection);

    const positions = account ? await this.deps.store.positions.findMany({ accountId: { eq: account.id } }) : [];
    const orders = account
      ? await this.deps.store.orders.findMany({ accountId: { eq: account.id }, status: { eq: 'PENDING' } })
      : [];

    const risk = account
      ? await this.deps.risk.computeStatus(userId, account, {
          liveTradingEnabled: user.liveTradingEnabled,
          brokerOnline: online,
          killSwitchEngaged: user.killSwitchEngaged,
        })
      : null;

    const quotes = account
      ? await this.deps.market.getQuotes(mode, userId, [], activeConnection?.deviceId ?? null)
      : [];
    if (quotes.length) messages.push({ type: 'quotes', quotes });

    if (account) {
      messages.push({
        type: 'account',
        account: this.deps.accounts.toDomain(account),
        risk:
          risk ?? {
            tradingEnabled: false,
            liveTradingEnabled: user.liveTradingEnabled,
            locked: true,
            lockReasons: ['No account available for this mode.'],
            dailyLossLimitAmount: 0,
            dailyRealizedLoss: 0,
            dailyRealizedProfit: 0,
            dailyNetPl: 0,
            dailyTradesCount: 0,
            openPositionsCount: 0,
            totalExposureLots: 0,
            consecutiveLosses: 0,
            remainingRiskToday: 0,
            day: new Date().toISOString().slice(0, 10),
          },
      });
    }

    messages.push({
      type: 'positions',
      mode,
      positions: positions.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        mode: row.mode,
        ticket: row.ticket,
        symbol: row.symbol,
        canonical: row.canonical,
        side: row.side,
        volume: row.volume,
        openPrice: row.openPrice,
        currentPrice: row.currentPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        swap: row.swap,
        commission: row.commission,
        profit: row.profit,
        profitPercent: row.profitPercent,
        magic: row.magic,
        comment: row.comment,
        openTime: row.openTime,
        updatedAt: row.updatedAt,
        origin: row.origin,
        strategyId: row.strategyId,
        accountLogin: row.accountLogin,
        source: row.source,
      })),
    });

    messages.push({
      type: 'orders',
      mode,
      orders: orders.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        mode: row.mode,
        ticket: row.ticket,
        symbol: row.symbol,
        canonical: row.canonical,
        type: row.type,
        side: row.side,
        volume: row.volume,
        price: row.price,
        stopLimitPrice: row.stopLimitPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        expiration: row.expiration,
        status: row.status,
        placedAt: row.placedAt,
        comment: row.comment,
        magic: row.magic,
        accountLogin: account?.login ?? '',
        source: row.source,
      })),
    });

    messages.push({
      type: 'connection',
      mt5: this.deps.devices.toDomain(activeConnection),
      status: this.deps.devices.isOnline(activeConnection) ? 'CONNECTED' : 'OFFLINE',
      lastHeartbeatAgeSeconds: this.deps.devices.heartbeatAgeSeconds(activeConnection),
      message: online ? null : mode === 'LIVE' ? 'MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE' : null,
    });

    if (risk) messages.push({ type: 'risk', risk });
    return messages;
  }
}
