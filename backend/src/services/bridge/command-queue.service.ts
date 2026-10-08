/**
 * TradePilot — MT5 command queue.
 *
 * Every trading action destined for a live MT5 terminal is:
 *   1. built as a `BridgeCommandEnvelope` (command_id, timestamp, user_id,
 *      account_id, symbol, action, parameters, idempotency_key, nonce),
 *   2. signed with the device's HMAC secret (replay protection),
 *   3. queued in the database where the EA polls for it,
 *   4. resolved when the EA posts back an `EaExecutionResult`.
 *
 * If the EA never answers, the command expires and the caller receives a
 * MT5_TIMEOUT error — the platform never assumes an order was executed.
 */

import { EventEmitter } from 'node:events';
import {
  BRIDGE_PROTOCOL_VERSION,
  ErrorCode,
  TradePilotError,
  signCommand,
  type BridgeAction,
  type BridgeCommandEnvelope,
  type EaExecutionResult,
} from '@tradepilot/shared';
import type { Store } from '../../db/types';
import type { BridgeCommandRow, Mt5ConnectionRow } from '../../db/types';
import type { DeviceService } from './device.service';
import type { Env } from '../../config/env';
import type { Logger } from '../../lib/logger';
import { newId, newId as uuid, randomHex } from '../../lib/ids';

export interface EnqueueOptions {
  userId: string;
  accountId: string;
  deviceId: string;
  symbol: string;
  action: BridgeAction;
  parameters: Record<string, unknown>;
  /** Idempotency key: the same key can never create two broker operations. */
  idempotencyKey: string;
  timeoutMs?: number;
}

export interface CommandResultPayload {
  success: boolean;
  brokerTicket: number | null;
  executionPrice: number | null;
  volume: number | null;
  retcode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  state: string | null;
}

export class CommandQueueService extends EventEmitter {
  constructor(
    private readonly store: Store,
    private readonly devices: DeviceService,
    private readonly env: Env,
    private readonly logger: Logger,
  ) {
    super();
  }

  /** Sign and queue a command for a specific device. */
  async enqueue(options: EnqueueOptions): Promise<BridgeCommandRow> {
    const existing = await this.store.bridgeCommands.findOne({
      idempotencyKey: { eq: options.idempotencyKey },
    });
    if (existing) {
      // Idempotent replay: return the original command instead of a duplicate.
      return existing;
    }

    const secret = await this.devices.getDeviceSecret(options.deviceId);
    if (!secret) {
      throw new TradePilotError(
        ErrorCode.MT5_NOT_AUTHORIZED,
        'This MT5 device has no usable signing key. Generate a new device token in Settings → MT5 Connection.',
        409,
      );
    }

    const commandId = newId('cmd');
    const timestamp = new Date().toISOString();
    const nonce = randomHex(16);
    const signable = {
      command_id: commandId,
      timestamp,
      user_id: options.userId,
      account_id: options.accountId,
      symbol: options.symbol,
      action: options.action,
      parameters: options.parameters,
      idempotency_key: options.idempotencyKey,
      nonce,
    };
    const signature = await signCommand(signable, secret);
    const envelope: BridgeCommandEnvelope = {
      ...signable,
      signature,
      protocol_version: BRIDGE_PROTOCOL_VERSION,
    };

    const timeoutMs = options.timeoutMs ?? this.env.COMMAND_TIMEOUT_MS;
    const now = Date.now();
    const row: BridgeCommandRow = {
      id: uuid(),
      commandId,
      userId: options.userId,
      accountId: options.accountId,
      deviceId: options.deviceId,
      action: options.action,
      symbol: options.symbol,
      envelope: envelope as unknown as Record<string, unknown>,
      idempotencyKey: options.idempotencyKey,
      status: 'QUEUED',
      attempts: 0,
      result: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(now).toISOString(),
      deliveredAt: null,
      completedAt: null,
      expiresAt: new Date(now + timeoutMs).toISOString(),
    };

    await this.store.bridgeCommands.insert(row);
    this.logger.debug({ commandId, action: options.action, symbol: options.symbol }, 'bridge command queued');
    this.emit('queued', row);
    return row;
  }

  /** EA polling endpoint: hand over queued commands (marks them DELIVERED). */
  async takeQueued(connection: Mt5ConnectionRow, limit = 10): Promise<BridgeCommandEnvelope[]> {
    const now = new Date().toISOString();
    const rows = await this.store.bridgeCommands.findMany(
      {
        deviceId: { eq: connection.deviceId },
        status: { eq: 'QUEUED' },
        expiresAt: { gt: now },
      },
      { orderBy: [{ field: 'createdAt', direction: 'asc' }], limit },
    );

    const envelopes: BridgeCommandEnvelope[] = [];
    for (const row of rows) {
      await this.store.bridgeCommands.update(row.id, {
        status: 'DELIVERED',
        deliveredAt: now,
        attempts: row.attempts + 1,
      });
      envelopes.push(row.envelope as unknown as BridgeCommandEnvelope);
    }
    return envelopes;
  }

  /** EA result callback. */
  async submitResult(connection: Mt5ConnectionRow, result: EaExecutionResult): Promise<BridgeCommandRow> {
    const row = await this.store.bridgeCommands.findOne({ commandId: { eq: result.command_id } });
    if (!row) {
      throw new TradePilotError(ErrorCode.COMMAND_NOT_FOUND, `Unknown command_id ${result.command_id}.`, 404);
    }
    if (row.deviceId !== connection.deviceId) {
      throw new TradePilotError(ErrorCode.FORBIDDEN, 'This command belongs to a different MT5 device.', 403);
    }

    const completedAt = new Date().toISOString();
    const updated = await this.store.bridgeCommands.update(row.id, {
      status: result.success ? 'COMPLETED' : 'FAILED',
      result: result as unknown as Record<string, unknown>,
      errorCode: result.error_code,
      errorMessage: result.error_message,
      completedAt,
    });
    if (!updated) throw new TradePilotError(ErrorCode.INTERNAL, 'Failed to store the execution result.', 500);

    this.emit('result', updated);
    this.emit(`result:${row.commandId}`, updated);
    return updated;
  }

  /** Wait for the EA to report on a command. */
  async awaitResult(commandId: string, timeoutMs?: number): Promise<BridgeCommandRow> {
    const existing = await this.store.bridgeCommands.findOne({ commandId: { eq: commandId } });
    if (!existing) {
      throw new TradePilotError(ErrorCode.COMMAND_NOT_FOUND, `Unknown command_id ${commandId}.`, 404);
    }
    if (existing.status === 'COMPLETED' || existing.status === 'FAILED') return existing;

    const waitMs = timeoutMs ?? this.env.COMMAND_TIMEOUT_MS;
    return new Promise<BridgeCommandRow>((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.removeListener(`result:${commandId}`, onResult);
        const latest = await this.store.bridgeCommands.findOne({ commandId: { eq: commandId } });
        if (latest && (latest.status === 'COMPLETED' || latest.status === 'FAILED')) {
          resolve(latest);
          return;
        }
        if (latest) {
          await this.store.bridgeCommands.update(latest.id, {
            status: 'EXPIRED',
            errorCode: ErrorCode.MT5_TIMEOUT,
            errorMessage: 'The MT5 terminal did not confirm this command in time.',
            completedAt: new Date().toISOString(),
          });
        }
        reject(
          new TradePilotError(
            ErrorCode.MT5_TIMEOUT,
            'MT5 did not confirm the command in time. Verify that the terminal is running, the EA is attached and Algo Trading is enabled.',
            504,
            { meta: { commandId } },
          ),
        );
      }, waitMs);
      timer.unref?.();

      const onResult = (row: BridgeCommandRow): void => {
        clearTimeout(timer);
        resolve(row);
      };
      this.once(`result:${commandId}`, onResult);
    });
  }

  /** Convert a completed queue row into the broker-neutral result payload. */
  toResultPayload(row: BridgeCommandRow): CommandResultPayload {
    const result = (row.result ?? {}) as Partial<EaExecutionResult>;
    return {
      success: row.status === 'COMPLETED' && result.success !== false,
      brokerTicket: result.broker_ticket ?? null,
      executionPrice: result.execution_price ?? null,
      volume: result.volume ?? null,
      retcode: result.retcode ?? null,
      errorCode: row.errorCode ?? result.error_code ?? null,
      errorMessage: row.errorMessage ?? result.error_message ?? null,
      state: result.state ?? null,
    };
  }

  async status(userId: string): Promise<{ queued: number; delivered: number; failed: number }> {
    const [queued, delivered, failed] = await Promise.all([
      this.store.bridgeCommands.count({ userId: { eq: userId }, status: { eq: 'QUEUED' } }),
      this.store.bridgeCommands.count({ userId: { eq: userId }, status: { eq: 'DELIVERED' } }),
      this.store.bridgeCommands.count({ userId: { eq: userId }, status: { eq: 'FAILED' } }),
    ]);
    return { queued, delivered, failed };
  }
}
