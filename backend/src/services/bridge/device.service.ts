/**
 * TradePilot — MT5 device (EA) registration and heartbeat handling.
 *
 * Security model
 * --------------
 * • The user generates a device token in Settings → MT5 Connection. It is shown
 *   exactly once and only its SHA-256 hash is stored.
 * • The MT5 terminal authenticates with `x-tradepilot-device` /
 *   `x-tradepilot-token` headers on every call. Broker *passwords* never leave
 *   the terminal and are never accepted by this API.
 * • The device secret doubles as the HMAC key for command signing, so a
 *   compromised database alone cannot forge commands.
 * • Heartbeats are expected every 2–5 seconds; if one is missing for longer
 *   than HEARTBEAT_TIMEOUT_MS the connection is marked OFFLINE, which disables
 *   live trading automatically.
 */

import { EventEmitter } from 'node:events';
import {
  ErrorCode,
  TradePilotError,
  type ConnectionStatus,
  type Mt5Connection,
} from '@tradepilot/shared';
import type { EaHeartbeat } from '@tradepilot/shared';
import type { Store } from '../../db/types';
import type { Mt5ConnectionRow } from '../../db/types';
import type { Env } from '../../config/env';
import type { Logger } from '../../lib/logger';
import { newId, randomToken, sha256 } from '../../lib/ids';
import { decryptSecret, encryptSecret } from '../../lib/crypto';

export interface GeneratedDeviceToken {
  connectionId: string;
  deviceId: string;
  /** Plaintext token — returned once, never stored, never logged. */
  token: string;
  tokenPrefix: string;
}

export interface DeviceAuth {
  connection: Mt5ConnectionRow;
  /** Raw secret, used to verify/sign bridge commands for this device. */
  secret: string;
}

export class DeviceService extends EventEmitter {
  private offlineTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly env: Env,
    private readonly logger: Logger,
  ) {
    super();
  }

  /** Create a new device token for a user (the EA will paste this token). */
  async createDevice(userId: string, deviceName: string | null): Promise<GeneratedDeviceToken> {
    const deviceId = randomToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    const secret = randomToken(24).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    const token = `tpd_${deviceId}_${secret}`;
    const now = new Date().toISOString();
    const row: Mt5ConnectionRow = {
      id: newId('con'),
      userId,
      accountId: null,
      deviceId,
      deviceName,
      tokenHash: sha256(secret),
      tokenSecretEnc: encryptSecret(secret, this.env.BRIDGE_SECRET),
      tokenPrefix: `${token.slice(0, 12)}…${token.slice(-4)}`,
      accountLogin: null,
      server: null,
      status: 'OFFLINE',
      lastHeartbeat: null,
      lastSequence: 0,
      latencyMs: null,
      terminalConnected: false,
      tradeAllowed: false,
      eaTradeAllowed: false,
      algoTradingEnabled: false,
      terminalBuild: null,
      eaVersion: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.mt5Connections.insert(row);
    this.logger.info({ userId, deviceId }, 'MT5 device token generated');
    return { connectionId: row.id, deviceId, token, tokenPrefix: row.tokenPrefix };
  }

  async listDevices(userId: string): Promise<Mt5ConnectionRow[]> {
    return this.store.mt5Connections.findMany({ userId: { eq: userId }, revokedAt: { isNull: true } }, {
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
    });
  }

  async revoke(userId: string, connectionId: string): Promise<boolean> {
    const row = await this.store.mt5Connections.findById(connectionId);
    if (!row || row.userId !== userId) return false;
    await this.store.mt5Connections.update(row.id, {
      revokedAt: new Date().toISOString(),
      status: 'OFFLINE',
      updatedAt: new Date().toISOString(),
    });
    this.emit('revoked', { userId, connectionId });
    return true;
  }

  /** Validate the `x-tradepilot-*` headers sent by the EA. */
  async authenticate(deviceId: string, token: string): Promise<DeviceAuth> {
    if (!deviceId || !token) {
      throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Missing MT5 device credentials.', 401);
    }
    const connection = await this.store.mt5Connections.findOne({ deviceId: { eq: deviceId } });
    if (!connection) {
      throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Unknown MT5 device.', 401);
    }
    if (connection.revokedAt) {
      throw new TradePilotError(ErrorCode.FORBIDDEN, 'This MT5 device token has been revoked.', 403);
    }
    const provided = token.startsWith('tpd_') ? token.split('_').slice(2).join('_') : token;
    if (sha256(provided) !== connection.tokenHash) {
      this.logger.warn({ deviceId }, 'MT5 device authentication failed (token mismatch)');
      throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Invalid MT5 device token.', 401);
    }
    return { connection, secret: provided };
  }

  /**
   * Recover the device secret so the backend can sign commands for this EA.
   * The value is stored AES-256-GCM encrypted under BRIDGE_SECRET — never in
   * plaintext, never in logs, and never returned to the browser.
   */
  async getDeviceSecret(deviceId: string): Promise<string | null> {
    const connection = await this.store.mt5Connections.findOne({ deviceId: { eq: deviceId } });
    if (!connection?.tokenSecretEnc) return null;
    return decryptSecret(connection.tokenSecretEnc, this.env.BRIDGE_SECRET);
  }

  async getConnectionById(connectionId: string): Promise<Mt5ConnectionRow | null> {
    return this.store.mt5Connections.findById(connectionId);
  }

  /** Register a heartbeat and mark the connection online. */
  async heartbeat(heartbeat: EaHeartbeat, latencyMs: number | null): Promise<Mt5ConnectionRow> {
    const connection = await this.store.mt5Connections.findOne({ deviceId: { eq: heartbeat.device_id } });
    if (!connection) {
      throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Unknown MT5 device.', 401);
    }
    if (heartbeat.sequence != null && connection.lastSequence >= heartbeat.sequence) {
      // Duplicate/out-of-order heartbeat: acknowledge without changing state.
      return connection;
    }

    const now = new Date().toISOString();
    const status: ConnectionStatus = heartbeat.terminal_connected && heartbeat.trade_allowed ? 'CONNECTED' : 'DEGRADED';
    const updated = await this.store.mt5Connections.update(connection.id, {
      status,
      lastHeartbeat: now,
      latencyMs,
      terminalConnected: heartbeat.terminal_connected,
      tradeAllowed: heartbeat.trade_allowed,
      eaTradeAllowed: heartbeat.ea_trade_allowed,
      algoTradingEnabled: heartbeat.algo_trading_enabled,
      terminalBuild: heartbeat.terminal_build ?? connection.terminalBuild,
      eaVersion: heartbeat.ea_version ?? connection.eaVersion,
      accountLogin: heartbeat.account ?? connection.accountLogin,
      server: heartbeat.server ?? connection.server,
      updatedAt: now,
    });
    if (!updated) throw new TradePilotError(ErrorCode.INTERNAL, 'Failed to record heartbeat.', 500);

    this.emit('heartbeat', { connection: updated, status });
    return updated;
  }

  /** Attach the live account row once the EA reports it. */
  async linkAccount(connection: Mt5ConnectionRow, accountId: string, login: string, server: string): Promise<void> {
    await this.store.mt5Connections.update(connection.id, {
      accountId,
      accountLogin: login,
      server,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Start the watchdog that flips stale connections to OFFLINE. */
  startWatchdog(intervalMs = 2_000): void {
    if (this.offlineTimer) return;
    this.offlineTimer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.offlineTimer.unref?.();
  }

  stopWatchdog(): void {
    if (this.offlineTimer) clearInterval(this.offlineTimer);
    this.offlineTimer = null;
  }

  private async sweep(): Promise<void> {
    const threshold = new Date(Date.now() - this.env.HEARTBEAT_TIMEOUT_MS).toISOString();
    try {
      const stale = await this.store.mt5Connections.findMany({
        status: { in: ['CONNECTED', 'DEGRADED'] },
        revokedAt: { isNull: true },
        lastHeartbeat: { lt: threshold },
      });
      for (const connection of stale) {
        clearStaleHeartbeat(connection);
        await this.store.mt5Connections.update(connection.id, {
          status: 'OFFLINE',
          terminalConnected: false,
          tradeAllowed: false,
          eaTradeAllowed: false,
          updatedAt: new Date().toISOString(),
        });
        this.logger.warn({ deviceId: connection.deviceId }, 'MT5 heartbeat lost — connection marked OFFLINE, live trading disabled');
        this.emit('offline', { connection });
      }
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'heartbeat watchdog failed');
    }
  }

  /** Seconds since the last heartbeat, or null when there has never been one. */
  heartbeatAgeSeconds(connection: Mt5ConnectionRow | null): number | null {
    if (!connection?.lastHeartbeat) return null;
    const age = (Date.now() - Date.parse(connection.lastHeartbeat)) / 1000;
    return Math.max(0, Math.round(age));
  }

  isOnline(connection: Mt5ConnectionRow | null): boolean {
    if (!connection || connection.revokedAt) return false;
    const age = this.heartbeatAgeSeconds(connection);
    if (age == null) return false;
    return age * 1000 <= this.env.HEARTBEAT_TIMEOUT_MS && connection.status !== 'OFFLINE';
  }

  /** Find the online connection that owns a live account. */
  async connectionForAccount(accountId: string): Promise<Mt5ConnectionRow | null> {
    return this.store.mt5Connections.findOne(
      { accountId: { eq: accountId }, revokedAt: { isNull: true } },
      { orderBy: [{ field: 'lastHeartbeat', direction: 'desc' }] },
    );
  }

  async connectionForUser(userId: string): Promise<Mt5ConnectionRow | null> {
    return this.store.mt5Connections.findOne(
      { userId: { eq: userId }, revokedAt: { isNull: true } },
      { orderBy: [{ field: 'lastHeartbeat', direction: 'desc' }] },
    );
  }

  toDomain(row: Mt5ConnectionRow | null): Mt5Connection | null {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      accountLogin: row.accountLogin,
      server: row.server,
      status: row.status,
      lastHeartbeat: row.lastHeartbeat,
      latencyMs: row.latencyMs,
      terminalConnected: row.terminalConnected,
      tradeAllowed: row.tradeAllowed,
      eaTradeAllowed: row.eaTradeAllowed,
      algoTradingEnabled: row.algoTradingEnabled,
      terminalBuild: row.terminalBuild,
      eaVersion: row.eaVersion,
      createdAt: row.createdAt,
    };
  }
}

/**
 * `status` is recomputed by the watchdog; this helper keeps the in-memory object
 * coherent for callers that hold a reference to a stale row.
 */
function clearStaleHeartbeat(connection: Mt5ConnectionRow): void {
  connection.status = 'OFFLINE';
  connection.terminalConnected = false;
  connection.tradeAllowed = false;
  connection.eaTradeAllowed = false;
}
