import type { InstrumentSpec, Quote, Side } from '../../shared/types';

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: { ok?: boolean; data?: unknown; error?: string } = {};
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok || !json.ok) throw new Error(json.error ?? `Request failed (HTTP ${res.status})`);
  return json.data as T;
}

export const fmtPrice = (n: number | null | undefined, digits = 5): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(digits);

export const fmtMoney = (n: number | null | undefined, opts: { sign?: boolean } = {}): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (opts.sign) return `${n > 0 ? '+' : n < 0 ? '−' : ''}$${abs}`;
  return `${n < 0 ? '−' : ''}$${abs}`;
};

export const fmtPct = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "11 Oct 05:30:00" (local time). Plain formatting: no Intl locale data needed. */
export const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** "05:30" (local time). */
export const fmtShortTime = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** Client-side conversion of an amount in `ccy` into USD (mirrors the server rule). */
export function ccyToUsd(ccy: string, quotes: Record<string, Quote>): number | null {
  if (ccy === 'USD' || ccy === 'USDT') return 1;
  const direct = quotes[`${ccy}USD`]?.mid ?? quotes[`${ccy}USDT`]?.mid;
  if (direct && direct > 0) return direct;
  const inverse = quotes[`USD${ccy}`]?.mid;
  if (inverse && inverse > 0) return 1 / inverse;
  return null;
}

/** Estimated margin (USD) for an order at a given price. */
export function estimateMargin(spec: InstrumentSpec, volume: number, price: number, leverage: number, quotes: Record<string, Quote>): number {
  const rate = ccyToUsd(spec.quoteCcy, quotes) ?? 1;
  return (volume * spec.contractSize * price * rate) / leverage;
}

/** Estimated P/L in USD for moving from `entry` to `exit`. */
export function estimateProfit(spec: InstrumentSpec, side: Side, volume: number, entry: number, exit: number, quotes: Record<string, Quote>): number {
  const rate = ccyToUsd(spec.quoteCcy, quotes) ?? 1;
  const dir = side === 'buy' ? 1 : -1;
  return dir * (exit - entry) * volume * spec.contractSize * rate;
}

export const CATEGORY_LABEL: Record<string, string> = {
  forex: 'Forex',
  metals: 'Metals',
  indices: 'Indices',
  crypto: 'Crypto',
};
