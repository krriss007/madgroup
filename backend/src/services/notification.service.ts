/**
 * TradePilot — notifications.
 *
 * Backs the bell menu in the top bar. Notifications are informational only:
 * they never represent money movements, because the platform has no deposit or
 * withdrawal capability at all (see docs/SECURITY.md → scope).
 */

import { EventEmitter } from 'node:events';
import type { Notification } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { NotificationRow } from '../db/types';
import { newId } from '../lib/ids';

export interface NotificationInput {
  level: NotificationRow['level'];
  title: string;
  message: string;
  meta?: Record<string, unknown> | null;
}

export class NotificationService extends EventEmitter {
  constructor(private readonly store: Store) {
    super();
  }

  async create(userId: string, input: NotificationInput): Promise<Notification> {
    const row: NotificationRow = {
      id: newId('ntf'),
      userId,
      level: input.level,
      title: input.title,
      message: input.message,
      read: false,
      meta: input.meta ?? null,
      createdAt: new Date().toISOString(),
    };
    await this.store.notifications.insert(row);
    const domain = this.toDomain(row);
    this.emit('created', { userId, notification: domain });
    return domain;
  }

  async list(userId: string, limit = 50): Promise<Notification[]> {
    const rows = await this.store.notifications.findMany(
      { userId: { eq: userId } },
      { orderBy: [{ field: 'createdAt', direction: 'desc' }], limit: Math.min(limit, 200) },
    );
    return rows.map((row) => this.toDomain(row));
  }

  async unreadCount(userId: string): Promise<number> {
    return this.store.notifications.count({ userId: { eq: userId }, read: { eq: false } });
  }

  async markRead(userId: string, id: string): Promise<void> {
    const row = await this.store.notifications.findById(id);
    if (!row || row.userId !== userId) return;
    await this.store.notifications.update(id, { read: true });
  }

  async markAllRead(userId: string): Promise<number> {
    const rows = await this.store.notifications.findMany({ userId: { eq: userId }, read: { eq: false } });
    for (const row of rows) await this.store.notifications.update(row.id, { read: true });
    return rows.length;
  }

  toDomain(row: NotificationRow): Notification {
    return {
      id: row.id,
      userId: row.userId,
      level: row.level,
      title: row.title,
      message: row.message,
      read: row.read,
      createdAt: row.createdAt,
      meta: row.meta,
    };
  }
}
