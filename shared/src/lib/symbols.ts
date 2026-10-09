/**
 * TradePilot — canonical instrument registry + broker symbol resolution.
 *
 * Brokers do not agree on symbol names (XAUUSD, XAUUSDm, XAUUSD., XAUUSDpro,
 * GOLD, GOLD.a, …). The platform therefore never hard-codes broker names.
 * Instead:
 *
 *   1. The EA reports the broker's *actual* symbol names (SYMBOL_NAME + PATH).
 *   2. `canonicalize()` maps them onto a canonical instrument (XAUUSD, EURUSD…).
 *   3. All UI/analytics group by canonical name, all orders by broker name.
 */

export type InstrumentCategory = 'metal' | 'forex' | 'index' | 'crypto' | 'other';

export interface InstrumentDefinition {
  canonical: string;
  category: InstrumentCategory;
  /** Human label used in the UI */
  label: string;
  /** Base / quote currencies ('' for non-currency instruments) */
  base: string;
  quote: string;
  description: string;
  /** Preferred timeframe when the symbol is opened */
  preferredTimeframe: string;
}

export const INSTRUMENTS: InstrumentDefinition[] = [
  {
    canonical: 'XAUUSD',
    category: 'metal',
    label: 'Gold / US Dollar',
    base: 'XAU',
    quote: 'USD',
    description: 'Spot gold vs US dollar',
    preferredTimeframe: 'M15',
  },
  { canonical: 'EURUSD', category: 'forex', label: 'Euro / US Dollar', base: 'EUR', quote: 'USD', description: 'Euro vs US dollar', preferredTimeframe: 'M15' },
  { canonical: 'GBPUSD', category: 'forex', label: 'British Pound / US Dollar', base: 'GBP', quote: 'USD', description: 'Pound sterling vs US dollar', preferredTimeframe: 'M15' },
  { canonical: 'USDJPY', category: 'forex', label: 'US Dollar / Japanese Yen', base: 'USD', quote: 'JPY', description: 'US dollar vs Japanese yen', preferredTimeframe: 'M15' },
  { canonical: 'USDCHF', category: 'forex', label: 'US Dollar / Swiss Franc', base: 'USD', quote: 'CHF', description: 'US dollar vs Swiss franc', preferredTimeframe: 'M15' },
  { canonical: 'AUDUSD', category: 'forex', label: 'Australian Dollar / US Dollar', base: 'AUD', quote: 'USD', description: 'Aussie vs US dollar', preferredTimeframe: 'M15' },
  { canonical: 'USDCAD', category: 'forex', label: 'US Dollar / Canadian Dollar', base: 'USD', quote: 'CAD', description: 'US dollar vs Canadian dollar', preferredTimeframe: 'M15' },
  { canonical: 'NZDUSD', category: 'forex', label: 'New Zealand Dollar / US Dollar', base: 'NZD', quote: 'USD', description: 'Kiwi vs US dollar', preferredTimeframe: 'M15' },
  { canonical: 'EURGBP', category: 'forex', label: 'Euro / British Pound', base: 'EUR', quote: 'GBP', description: 'Euro vs pound sterling', preferredTimeframe: 'M15' },
  { canonical: 'EURJPY', category: 'forex', label: 'Euro / Japanese Yen', base: 'EUR', quote: 'JPY', description: 'Euro vs Japanese yen', preferredTimeframe: 'M15' },
  { canonical: 'GBPJPY', category: 'forex', label: 'British Pound / Japanese Yen', base: 'GBP', quote: 'JPY', description: 'Pound sterling vs Japanese yen', preferredTimeframe: 'M15' },
  { canonical: 'XAGUSD', category: 'metal', label: 'Silver / US Dollar', base: 'XAG', quote: 'USD', description: 'Spot silver vs US dollar', preferredTimeframe: 'M15' },
  { canonical: 'US30', category: 'index', label: 'Dow Jones 30', base: '', quote: 'USD', description: 'Dow Jones Industrial Average CFD', preferredTimeframe: 'M15' },
  { canonical: 'NAS100', category: 'index', label: 'Nasdaq 100', base: '', quote: 'USD', description: 'Nasdaq 100 CFD', preferredTimeframe: 'M15' },
  { canonical: 'GER40', category: 'index', label: 'DAX 40', base: '', quote: 'EUR', description: 'German DAX index CFD', preferredTimeframe: 'M15' },
  { canonical: 'BTCUSD', category: 'crypto', label: 'Bitcoin / US Dollar', base: 'BTC', quote: 'USD', description: 'Bitcoin vs US dollar', preferredTimeframe: 'H1' },
  { canonical: 'ETHUSD', category: 'crypto', label: 'Ethereum / US Dollar', base: 'ETH', quote: 'USD', description: 'Ethereum vs US dollar', preferredTimeframe: 'H1' },
];

/** Default watchlist required by the specification. */
export const DEFAULT_WATCHLIST: string[] = [
  'XAUUSD',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'USDCAD',
  'NZDUSD',
  'EURGBP',
  'EURJPY',
  'GBPJPY',
];

export const PRIMARY_SYMBOL = 'XAUUSD';

const INSTRUMENT_MAP = new Map(INSTRUMENTS.map((i) => [i.canonical, i]));

export function getInstrument(canonical: string): InstrumentDefinition | undefined {
  return INSTRUMENT_MAP.get(canonical.toUpperCase());
}

/**
 * Suffixes brokers commonly append/prepend. Kept generic on purpose: the list
 * is a *fallback heuristic* for names the EA did not report, never a source of
 * truth. Anything unknown simply canonicalizes to itself.
 */
const KNOWN_SUFFIXES = ['m', 'micro', '.', '.a', '.b', '.c', '.pro', '.raw', '.ecn', 'pro', 'raw', 'ecn', 'i', 's', 'z', '_', '-i', '.i'];
const KNOWN_PREFIXES = ['#', '=', 'FX.', 'FOREX.'];

export function stripDecoration(rawName: string): string {
  let name = rawName.trim().toUpperCase();
  for (const prefix of KNOWN_PREFIXES) {
    if (name.startsWith(prefix.toUpperCase())) name = name.slice(prefix.length);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of KNOWN_SUFFIXES) {
      if (name.length > suffix.length && name.endsWith(suffix.toUpperCase())) {
        name = name.slice(0, name.length - suffix.length);
        changed = true;
        break;
      }
    }
  }
  return name.replace(/[^A-Z0-9]/g, '');
}

/**
 * Map a broker symbol name to a canonical instrument.
 * Resolution order: exact canonical hit → decoration-stripped hit → substring hit → self.
 */
export function canonicalize(brokerSymbol: string): string {
  const upper = brokerSymbol.trim().toUpperCase();
  if (INSTRUMENT_MAP.has(upper)) return upper;

  const stripped = stripDecoration(upper);
  if (INSTRUMENT_MAP.has(stripped)) return stripped;

  for (const canonical of INSTRUMENT_MAP.keys()) {
    if (upper.includes(canonical)) return canonical;
  }
  // metals under alternative naming
  if (/^(GOLD|XAU)/.test(stripped)) return 'XAUUSD';
  if (/^(SILVER|XAG)/.test(stripped)) return 'XAGUSD';

  return stripped || upper;
}

export function instrumentCategory(brokerSymbol: string): InstrumentCategory {
  const instrument = getInstrument(canonicalize(brokerSymbol));
  if (instrument) return instrument.category;
  const stripped = stripDecoration(brokerSymbol);
  if (/^(XAU|XAG|GOLD|SILVER)/.test(stripped)) return 'metal';
  if (stripped.length === 6 && /^[A-Z]{6}$/.test(stripped)) return 'forex';
  if (/^(US30|US500|NAS100|GER40|UK100|JP225)/.test(stripped)) return 'index';
  if (/^(BTC|ETH|SOL|XRP)/.test(stripped)) return 'crypto';
  return 'other';
}

export function labelFor(brokerSymbol: string): string {
  const canonical = canonicalize(brokerSymbol);
  const instrument = INSTRUMENT_MAP.get(canonical);
  return instrument?.label ?? brokerSymbol;
}

/**
 * Pip size helper. For 5/3-digit FX quotes a pip is 10 points; for everything
 * else a pip equals one point. Used only for display, never for execution.
 */
export function pipSize(digits: number): number {
  if (digits === 5 || digits === 3) return 10;
  return 1;
}

/** Number of decimals an instrument is normally quoted with (display fallback). */
export function defaultDigits(canonical: string): number {
  switch (canonical) {
    case 'XAUUSD':
    case 'XAGUSD':
      return 2;
    case 'USDJPY':
    case 'EURJPY':
    case 'GBPJPY':
      return 3;
    case 'BTCUSD':
      return 2;
    case 'ETHUSD':
      return 2;
    case 'US30':
    case 'NAS100':
    case 'GER40':
      return 1;
    default:
      return 5;
  }
}

export function isMetalOrForex(canonical: string): boolean {
  const category = getInstrument(canonical)?.category;
  return category === 'metal' || category === 'forex';
}
