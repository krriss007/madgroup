/**
 * TradePilot — display formatting.
 *
 * Kept in the shared package so the terminal, the docs examples and the tests
 * all render numbers identically.
 */

export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPrice(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(Math.max(0, Math.min(8, digits)));
}

/** Signed money, e.g. "+$47.00" / "-$12.50" */
export function formatSignedMoney(value: number | null | undefined, currency = 'USD', decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const symbol = currencySymbol(currency);
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${symbol}${formatNumber(Math.abs(value), decimals)}`;
}

export function formatMoney(value: number | null | undefined, currency = 'USD', decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${currencySymbol(currency)}${formatNumber(value, decimals)}`;
}

export function currencySymbol(currency: string): string {
  switch ((currency || 'USD').toUpperCase()) {
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'JPY':
      return '¥';
    case 'AUD':
      return 'A$';
    case 'CAD':
      return 'C$';
    case 'CHF':
      return 'CHF ';
    default:
      return `${currency || 'USD'} `;
  }
}

export function formatSigned(value: number | null | undefined, decimals = 2, suffix = ''): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}${suffix}`;
}

export function formatPercent(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatLots(value: number | null | undefined, step = 0.01): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const decimals = step >= 1 ? 0 : Math.min(4, String(step).split('.')[1]?.length ?? 2);
  return value.toFixed(decimals);
}

export function formatDateTime(iso: string | null | undefined, timeZone = 'UTC'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
  }).format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit' }).format(date);
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

export function plColorClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'text-slate-300';
  return value > 0 ? 'text-emerald-400' : 'text-rose-400';
}
