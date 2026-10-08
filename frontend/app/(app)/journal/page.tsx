"use client";

import { useCallback, useEffect, useState } from 'react';
import { BookOpenText, NotebookPen, Save, Trash2 } from 'lucide-react';
import { formatDateTime } from '@tradepilot/shared';
import type { JournalEntry } from '@tradepilot/shared';
import { api, ApiError } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const EMPTY = {
  symbol: 'XAUUSD',
  ticket: '',
  setup: '',
  reasonForEntry: '',
  marketConditions: '',
  emotion: '',
  mistakes: '',
  lesson: '',
  notes: '',
  tags: '',
  rating: 3,
};

/** Trading Journal — the trader's own notes, attached to real ticket numbers. */
export default function JournalPage(): JSX.Element {
  const { pushToast, mode } = useTerminal();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{ entries: JournalEntry[] }>('/journal', { limit: 100 });
      setEntries(response.entries);
    } catch (error) {
      pushToast({ title: 'Could not load the journal', message: (error as Error).message, level: 'error' });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    try {
      await api.post('/journal', {
        symbol: form.symbol.trim().toUpperCase() || null,
        ticket: form.ticket.trim() || null,
        setup: form.setup || null,
        reasonForEntry: form.reasonForEntry || null,
        marketConditions: form.marketConditions || null,
        emotion: form.emotion || null,
        mistakes: form.mistakes || null,
        lesson: form.lesson || null,
        notes: form.notes || null,
        tags: form.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
          .slice(0, 20),
        rating: Number(form.rating),
      });
      setForm({ ...EMPTY });
      await load();
      pushToast({ title: 'Journal entry saved', level: 'success' });
    } catch (error) {
      pushToast({
        title: 'Entry not saved',
        message: error instanceof ApiError ? error.message : (error as Error).message,
        level: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api.delete(`/journal/${id}`);
      setEntries((current) => current.filter((entry) => entry.id !== id));
    } catch (error) {
      pushToast({ title: 'Could not delete the entry', message: (error as Error).message, level: 'error' });
    }
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="flex items-center gap-1.5 text-sm font-semibold">
            <BookOpenText className="h-4 w-4" /> Trading journal
          </h1>
          <p className="text-2xs text-muted-foreground">
            Record the plan, the emotion and the lesson behind each trade. Entries are private to your account.
          </p>
        </div>
        <Badge variant={mode === 'DEMO' ? 'demo' : 'live'} className="ml-auto">
          {mode === 'DEMO' ? 'DEMO account' : 'LIVE account'}
        </Badge>
      </div>

      <div className="grid gap-3 xl:grid-cols-[380px_minmax(0,1fr)]">
        <form onSubmit={save} className="panel space-y-2 p-3">
          <p className="panel-header -mx-3 -mt-3 mb-2">
            <span className="flex items-center gap-1.5">
              <NotebookPen className="h-3.5 w-3.5" /> New entry
            </span>
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="journal-symbol">Symbol</Label>
              <Input id="journal-symbol" value={form.symbol} onChange={(event) => setForm({ ...form, symbol: event.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="journal-ticket">Ticket (optional)</Label>
              <Input id="journal-ticket" value={form.ticket} onChange={(event) => setForm({ ...form, ticket: event.target.value })} className="num" />
            </div>
          </div>

          {(
            [
              ['setup', 'Setup / strategy'],
              ['reasonForEntry', 'Reason for entry'],
              ['marketConditions', 'Market conditions'],
              ['emotion', 'Emotion'],
              ['mistakes', 'Mistakes'],
              ['lesson', 'Lesson learned'],
              ['notes', 'Additional notes'],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`journal-${key}`}>{label}</Label>
              <textarea
                id={`journal-${key}`}
                value={form[key]}
                onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                rows={2}
                className="w-full rounded-md border border-input bg-background/60 px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          ))}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="journal-rating">Rating (1-5)</Label>
              <Input
                id="journal-rating"
                type="number"
                min={1}
                max={5}
                value={form.rating}
                onChange={(event) => setForm({ ...form, rating: Number(event.target.value) })}
                className="num"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="journal-tags">Tags</Label>
              <Input
                id="journal-tags"
                value={form.tags}
                onChange={(event) => setForm({ ...form, tags: event.target.value })}
                placeholder="breakout, news, discipline"
              />
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={saving}>
            <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save entry'}
          </Button>
        </form>

        <div className="space-y-2">
          {loading ? (
            <>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </>
          ) : null}
          {!loading && entries.length === 0 ? (
            <p className="panel p-6 text-center text-xs text-muted-foreground">
              No journal entries yet. Write down your first trade review — the discipline is what makes the journal useful.
            </p>
          ) : null}
          {entries.map((entry) => (
            <article key={entry.id} className="panel p-3">
              <header className="flex items-center gap-2">
                <span className="text-xs font-semibold">{entry.symbol ?? '—'}</span>
                {entry.ticket ? <span className="num text-2xs text-muted-foreground">#{entry.ticket}</span> : null}
                {entry.rating != null ? <Badge variant="outline">{entry.rating}/5</Badge> : null}
                {(entry.tags ?? []).slice(0, 3).map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
                <span className="ml-auto text-[10px] text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
                <Button size="xs" variant="ghost" onClick={() => void remove(entry.id)} title="Delete">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </header>
              <dl className="mt-2 grid gap-1 text-2xs md:grid-cols-2">
                {(
                  [
                    ['Setup', entry.setup],
                    ['Reason', entry.reasonForEntry],
                    ['Conditions', entry.marketConditions],
                    ['Emotion', entry.emotion],
                    ['Mistakes', entry.mistakes],
                    ['Lesson', entry.lesson],
                    ['Notes', entry.notes],
                  ] as const
                )
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="whitespace-pre-wrap">{value}</dd>
                    </div>
                  ))}
              </dl>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
