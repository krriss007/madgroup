/**
 * TradePilot — session & trading-hours helpers.
 *
 * Sessions are defined in UTC (the platform's canonical clock). Session labels
 * are indicative reference windows, not broker guarantees.
 */

export interface TradingSession {
  id: 'SYDNEY' | 'TOKYO' | 'ASIAN' | 'LONDON' | 'NEW_YORK';
  label: string;
  /** UTC window, can wrap midnight */
  startUtcHour: number;
  endUtcHour: number;
  color: string;
}

export const SESSIONS: TradingSession[] = [
  { id: 'SYDNEY', label: 'Sydney', startUtcHour: 21, endUtcHour: 6, color: '#38bdf8' },
  { id: 'TOKYO', label: 'Tokyo', startUtcHour: 0, endUtcHour: 9, color: '#a78bfa' },
  { id: 'ASIAN', label: 'Asian', startUtcHour: 0, endUtcHour: 8, color: '#a78bfa' },
  { id: 'LONDON', label: 'London', startUtcHour: 7, endUtcHour: 16, color: '#22c55e' },
  { id: 'NEW_YORK', label: 'New York', startUtcHour: 12, endUtcHour: 21, color: '#f59e0b' },
];

function withinWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (end > start) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function activeSessions(now: Date = new Date()): TradingSession[] {
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  return SESSIONS.filter((s) => withinWindow(hour, s.startUtcHour, s.endUtcHour));
}

/** Human label for the current market phase. */
export function currentSessionLabel(now: Date = new Date()): string {
  const active = activeSessions(now).filter((s) => s.id !== 'ASIAN' || !activeSessions(now).some((o) => o.id === 'TOKYO'));
  if (!active.length) return 'Closed';
  return active.map((s) => s.label).join(' + ');
}

/** FX/metals weekend check in UTC (market opens Sunday ~21:00 UTC, closes Friday ~21:00 UTC). */
export function isWeekendClosed(now: Date = new Date()): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return true;
  if (day === 0 && hour < 21) return true;
  if (day === 5 && hour >= 21) return true;
  return false;
}

/** Overlap flag — useful for the "high liquidity" hint on the XAUUSD panel. */
export function isLondonNewYorkOverlap(now: Date = new Date()): boolean {
  const hour = now.getUTCHours();
  return hour >= 12 && hour < 16;
}

export function parseTimeWindow(window: { start: string; end: string }): { start: number; end: number } | null {
  const parse = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = parse(window.start);
  const end = parse(window.end);
  if (start == null || end == null) return null;
  return { start, end };
}

export function isWithinTradingHours(
  windows: { start: string; end: string }[],
  now: Date = new Date(),
): boolean {
  if (!windows.length) return true;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return windows.some((window) => {
    const parsed = parseTimeWindow(window);
    if (!parsed) return false;
    if (parsed.start <= parsed.end) return minutes >= parsed.start && minutes <= parsed.end;
    return minutes >= parsed.start || minutes <= parsed.end;
  });
}

export function nextWindowOpen(
  windows: { start: string; end: string }[],
  now: Date = new Date(),
): Date | null {
  if (!windows.length) return null;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const parsed = windows
    .map(parseTimeWindow)
    .filter((w): w is { start: number; end: number } => w != null)
    .sort((a, b) => a.start - b.start);
  const next = parsed.find((w) => w.start > minutes);
  const target = next ? next.start : parsed[0] ? parsed[0].start + 24 * 60 : null;
  if (target == null) return null;
  const deltaMinutes = target - minutes;
  return new Date(now.getTime() + deltaMinutes * 60_000);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';
  const delta = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (delta < 2) return 'just now';
  if (delta < 60) return `${delta} seconds ago`;
  const minutes = Math.floor(delta / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Local (UTC) day key, e.g. 2026-10-08 */
export function dayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function monthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function startOfUtcDay(date: Date = new Date()): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}
