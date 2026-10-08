/**
 * TradePilot — trading journal.
 *
 * Lets the trader attach notes to a trade or to a standalone idea: setup,
 * reason for entry, market conditions, emotion, mistakes, lesson, screenshot.
 */

import { ErrorCode, TradePilotError, type JournalEntry } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { JournalRow } from '../db/types';
import { newId } from '../lib/ids';

export interface JournalInput {
  tradeId?: string | null;
  ticket?: string | null;
  symbol?: string | null;
  setup?: string | null;
  reasonForEntry?: string | null;
  marketConditions?: string | null;
  emotion?: string | null;
  mistakes?: string | null;
  lesson?: string | null;
  notes?: string | null;
  tags?: string[];
  rating?: number | null;
  screenshotUrl?: string | null;
}

const MAX_TEXT = 8_000;

function clampText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_TEXT);
}

export class JournalService {
  constructor(private readonly store: Store) {}

  async list(userId: string, options: { ticket?: string | null; limit?: number; offset?: number } = {}): Promise<JournalEntry[]> {
    const rows = await this.store.journal.findMany(
      { userId: { eq: userId }, ...(options.ticket ? { ticket: { eq: options.ticket } } : {}) },
      {
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
        limit: Math.min(options.limit ?? 100, 300),
        offset: options.offset ?? 0,
      },
    );
    return rows.map((row) => this.toDomain(row));
  }

  async get(userId: string, id: string): Promise<JournalEntry | null> {
    const row = await this.store.journal.findById(id);
    if (!row || row.userId !== userId) return null;
    return this.toDomain(row);
  }

  async create(userId: string, input: JournalInput): Promise<JournalEntry> {
    const now = new Date().toISOString();
    const row: JournalRow = {
      id: newId('jrn'),
      userId,
      tradeId: input.tradeId ?? null,
      ticket: input.ticket ?? null,
      symbol: input.symbol ?? null,
      setup: clampText(input.setup),
      reasonForEntry: clampText(input.reasonForEntry),
      marketConditions: clampText(input.marketConditions),
      emotion: clampText(input.emotion),
      mistakes: clampText(input.mistakes),
      lesson: clampText(input.lesson),
      notes: clampText(input.notes),
      tags: (input.tags ?? []).slice(0, 20).map((tag) => tag.trim().slice(0, 40)).filter(Boolean),
      rating: input.rating != null ? Math.max(1, Math.min(5, Math.round(input.rating))) : null,
      screenshotUrl: input.screenshotUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.journal.insert(row);
    return this.toDomain(row);
  }

  async update(userId: string, id: string, input: JournalInput): Promise<JournalEntry> {
    const row = await this.store.journal.findById(id);
    if (!row || row.userId !== userId) {
      throw new TradePilotError(ErrorCode.NOT_FOUND, 'Journal entry not found.', 404);
    }
    const updated = await this.store.journal.update(id, {
      setup: input.setup === undefined ? row.setup : clampText(input.setup),
      reasonForEntry: input.reasonForEntry === undefined ? row.reasonForEntry : clampText(input.reasonForEntry),
      marketConditions: input.marketConditions === undefined ? row.marketConditions : clampText(input.marketConditions),
      emotion: input.emotion === undefined ? row.emotion : clampText(input.emotion),
      mistakes: input.mistakes === undefined ? row.mistakes : clampText(input.mistakes),
      lesson: input.lesson === undefined ? row.lesson : clampText(input.lesson),
      notes: input.notes === undefined ? row.notes : clampText(input.notes),
      tags: input.tags === undefined ? row.tags : input.tags.slice(0, 20).map((t) => t.trim().slice(0, 40)).filter(Boolean),
      rating: input.rating === undefined ? row.rating : input.rating == null ? null : Math.max(1, Math.min(5, Math.round(input.rating))),
      screenshotUrl: input.screenshotUrl === undefined ? row.screenshotUrl : input.screenshotUrl,
      updatedAt: new Date().toISOString(),
    });
    if (!updated) throw new TradePilotError(ErrorCode.INTERNAL, 'Failed to update the journal entry.', 500);
    return this.toDomain(updated);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const row = await this.store.journal.findById(id);
    if (!row || row.userId !== userId) return false;
    return this.store.journal.delete(id);
  }

  toDomain(row: JournalRow): JournalEntry {
    return {
      id: row.id,
      userId: row.userId,
      tradeId: row.tradeId,
      ticket: row.ticket,
      symbol: row.symbol,
      setup: row.setup,
      reasonForEntry: row.reasonForEntry,
      marketConditions: row.marketConditions,
      emotion: row.emotion,
      mistakes: row.mistakes,
      lesson: row.lesson,
      notes: row.notes,
      tags: row.tags ?? [],
      rating: row.rating,
      screenshotUrl: row.screenshotUrl,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
