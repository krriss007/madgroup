/**
 * TradePilot — price alerts.
 *
 * Alerts are evaluated against whatever price source the account is using:
 * simulated prices for DEMO accounts, MT5 prices for LIVE accounts. They never
 * generate trades on their own — acting on an alert is always a manual step.
 */

import { EventEmitter } from 'node:events';
import { ErrorCode, TradePilotError, canonicalize, round, type PriceAlert, type Quote } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { PriceAlertRow } from '../db/types';
import type { NotificationService } from './notification.service';
import { newId } from '../lib/ids';

export interface AlertInput {
  symbol: string;
  condition: 'ABOVE' | 'BELOW';
  price: number;
  note?: string | null;
}

export class AlertsService extends EventEmitter {
  constructor(
    private readonly store: Store,
    private readonly notifications: NotificationService,
  ) {
    super();
  }

  async list(userId: string): Promise<PriceAlert[]> {
    const rows = await this.store.priceAlerts.findMany(
      { userId: { eq: userId } },
      { orderBy: [{ field: 'createdAt', direction: 'desc' }], limit: 100 },
    );
    return rows.map((row) => this.toDomain(row));
  }

  async create(userId: string, input: AlertInput): Promise<PriceAlert> {
    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new TradePilotError(ErrorCode.VALIDATION_FAILED, 'Alert price must be a positive number.', 400);
    }
    const row: PriceAlertRow = {
      id: newId('alt'),
      userId,
      symbol: input.symbol,
      canonical: canonicalize(input.symbol),
      condition: input.condition,
      price: input.price,
      triggered: false,
      triggeredAt: null,
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
    };
    await this.store.priceAlerts.insert(row);
    return this.toDomain(row);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const row = await this.store.priceAlerts.findById(id);
    if (!row || row.userId !== userId) return false;
    return this.store.priceAlerts.delete(id);
  }

  /** Evaluate every open alert against the latest quotes. */
  async evaluate(quotes: Quote[]): Promise<PriceAlert[]> {
    if (!quotes.length) return [];
    const byCanonical = new Map(quotes.map((q) => [q.canonical, q]));
    const pending = await this.store.priceAlerts.findMany({ triggered: { eq: false } });
    const fired: PriceAlert[] = [];

    for (const alert of pending) {
      const quote = byCanonical.get(alert.canonical);
      if (!quote) continue;
      const price = alert.condition === 'ABOVE' ? quote.bid : quote.ask;
      const hit = alert.condition === 'ABOVE' ? price >= alert.price : price <= alert.price;
      if (!hit) continue;

      const triggeredAt = new Date().toISOString();
      const updated = await this.store.priceAlerts.update(alert.id, { triggered: true, triggeredAt });
      const domain = this.toDomain(updated ?? { ...alert, triggered: true, triggeredAt });
      fired.push(domain);

      await this.notifications.create(alert.userId, {
        level: 'info',
        title: `${alert.canonical} ${alert.condition === 'ABOVE' ? 'above' : 'below'} ${alert.price}`,
        message: `Price alert triggered at ${round(price, quote.digits)} (${quote.source === 'MT5' ? 'MT5' : 'simulated demo data'}).`,
        meta: { alertId: alert.id, symbol: alert.symbol, price },
      });
      this.emit('triggered', domain);
    }

    return fired;
  }

  toDomain(row: PriceAlertRow): PriceAlert {
    return {
      id: row.id,
      userId: row.userId,
      symbol: row.symbol,
      canonical: row.canonical,
      condition: row.condition,
      price: row.price,
      triggered: row.triggered,
      triggeredAt: row.triggeredAt,
      createdAt: row.createdAt,
      note: row.note,
    };
  }
}
