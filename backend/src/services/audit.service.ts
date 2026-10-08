/**
 * TradePilot — audit log.
 *
 * Append-only by design: the store exposes no update/delete for this table and
 * PostgreSQL enforces the rule with triggers (see database/schema.sql), so live
 * trading actions cannot be silently edited or removed — not by the app, not by
 * an operator with SQL access.
 */

import { EventEmitter } from 'node:events';
import type { AuditLogEntry, TradingMode } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { AuditLogRow } from '../db/types';
import type { Logger } from '../lib/logger';
import { newId } from '../lib/ids';

export interface AuditInput {
  userId: string | null;
  mode: TradingMode;
  action: string;
  symbol?: string | null;
  volume?: number | null;
  price?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  brokerTicket?: string | null;
  result: 'SUCCESS' | 'FAILURE' | 'REJECTED' | 'PENDING';
  errorCode?: string | null;
  errorMessage?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
  commandId?: string | null;
  detail?: Record<string, unknown> | null;
}

export class AuditService extends EventEmitter {
  constructor(
    private readonly store: Store,
    private readonly logger: Logger,
  ) {
    super();
  }

  async record(input: AuditInput): Promise<AuditLogRow> {
    const sequence = await this.store.nextAuditSequence();
    const row: AuditLogRow = {
      id: newId('aud'),
      userId: input.userId,
      mode: input.mode,
      sequence,
      action: input.action,
      symbol: input.symbol ?? null,
      volume: input.volume ?? null,
      price: input.price ?? null,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      brokerTicket: input.brokerTicket ?? null,
      result: input.result,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      deviceId: input.deviceId ?? null,
      commandId: input.commandId ?? null,
      detail: input.detail ?? null,
      createdAt: new Date().toISOString(),
    };

    // Never let an audit failure abort a trading action silently: log loudly.
    try {
      const stored = await this.store.auditLogs.insert(row);
      this.emit('recorded', stored);
      if (input.mode === 'LIVE') {
        this.logger.info(
          {
            sequence,
            action: input.action,
            symbol: input.symbol,
            result: input.result,
            ticket: input.brokerTicket,
          },
          'live trading action audited',
        );
      }
      return stored;
    } catch (error) {
      this.logger.error(
        { error: (error as Error).message, action: input.action, sequence },
        'FAILED TO WRITE AUDIT LOG — this is a compliance incident',
      );
      throw error;
    }
  }

  async list(
    userId: string,
    options: { limit?: number; offset?: number; mode?: TradingMode } = {},
  ): Promise<AuditLogRow[]> {
    return this.store.auditLogs.findMany(
      { userId: { eq: userId }, ...(options.mode ? { mode: { eq: options.mode } } : {}) },
      {
        orderBy: [{ field: 'sequence', direction: 'desc' }],
        limit: Math.min(options.limit ?? 100, 500),
        offset: options.offset ?? 0,
      },
    );
  }

  async count(userId: string): Promise<number> {
    return this.store.auditLogs.count({ userId: { eq: userId } });
  }

  toDomain(row: AuditLogRow): AuditLogEntry {
    return {
      id: row.id,
      userId: row.userId,
      mode: row.mode,
      sequence: row.sequence,
      action: row.action,
      symbol: row.symbol,
      volume: row.volume,
      price: row.price,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      brokerTicket: row.brokerTicket,
      result: row.result,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      ip: row.ip,
      userAgent: row.userAgent,
      deviceId: row.deviceId,
      commandId: row.commandId,
      detail: row.detail,
      createdAt: row.createdAt,
    };
  }
}
