/**
 * TradePilot — DEMO BROKER PROFILE.
 *
 * !!! These values are ONLY used by the built-in paper-trading engine. !!!
 *
 * They describe a synthetic broker so the platform can be explored without any
 * MT5 terminal. Live trading never reads anything from this file: for LIVE
 * accounts every specification (contract size, tick size, tick value, volume
 * grid, stops level, …) comes from the connected MT5 terminal through the EA,
 * because brokers disagree about all of these.
 *
 * The demo profile is intentionally conservative and mimics a typical retail
 * ECN account: 1:100 leverage, 0.01 volume step, commission per lot.
 */

export interface DemoInstrumentProfile {
  canonical: string;
  /** Starting price used to seed the simulated random walk */
  basePrice: number;
  /** annualised volatility, e.g. 0.12 = 12% per year */
  annualVolatility: number;
  /** typical spread in price units */
  spread: number;
  digits: number;
  tickSize: number;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  /** broker stops level in points */
  stopsLevel: number;
  /** round-turn commission per lot in account currency */
  commissionPerLot: number;
  /** swap per lot per night (negative = cost), account currency */
  swapLongPerLot: number;
  swapShortPerLot: number;
  /** currency the symbol is quoted in (quote leg) */
  quoteCurrency: string;
  description: string;
  /** trading hours in UTC, empty = 24/5 */
  sessions: string[];
}

const FX_SESSIONS = ['', '00:00-23:59', '00:00-23:59', '00:00-23:59', '00:00-23:59', '00:00-23:59', ''];

function fx(
  canonical: string,
  basePrice: number,
  annualVolatility: number,
  spread: number,
  quoteCurrency: string,
  description: string,
  digits = 5,
  tickSize = 0.00001,
): DemoInstrumentProfile {
  return {
    canonical,
    basePrice,
    annualVolatility,
    spread,
    digits,
    tickSize,
    contractSize: 100_000,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    stopsLevel: 0,
    commissionPerLot: 7,
    swapLongPerLot: canonical.endsWith('JPY') ? 1.2 : -0.9,
    swapShortPerLot: canonical.endsWith('JPY') ? -2.1 : 0.3,
    quoteCurrency,
    description,
    sessions: FX_SESSIONS,
  };
}

export const DEMO_PROFILES: Record<string, DemoInstrumentProfile> = {
  XAUUSD: {
    canonical: 'XAUUSD',
    basePrice: 2650,
    annualVolatility: 0.16,
    spread: 0.3,
    digits: 2,
    tickSize: 0.01,
    contractSize: 100,
    volumeMin: 0.01,
    volumeMax: 100,
    volumeStep: 0.01,
    stopsLevel: 30,
    commissionPerLot: 7,
    swapLongPerLot: -2.4,
    swapShortPerLot: 0.6,
    quoteCurrency: 'USD',
    description: 'Gold vs US Dollar (simulated)',
    sessions: FX_SESSIONS,
  },
  EURUSD: fx('EURUSD', 1.0850, 0.075, 0.00012, 'USD', 'Euro vs US Dollar (simulated)'),
  GBPUSD: fx('GBPUSD', 1.2700, 0.085, 0.00016, 'USD', 'Pound vs US Dollar (simulated)'),
  USDJPY: fx('USDJPY', 150.20, 0.095, 0.016, 'JPY', 'US Dollar vs Yen (simulated)', 3, 0.001),
  USDCHF: fx('USDCHF', 0.8750, 0.07, 0.00016, 'CHF', 'US Dollar vs Franc (simulated)'),
  AUDUSD: fx('AUDUSD', 0.6600, 0.09, 0.00016, 'USD', 'Aussie vs US Dollar (simulated)'),
  USDCAD: fx('USDCAD', 1.3600, 0.07, 0.00018, 'CAD', 'US Dollar vs Loonie (simulated)'),
  NZDUSD: fx('NZDUSD', 0.6100, 0.095, 0.0002, 'USD', 'Kiwi vs US Dollar (simulated)'),
  EURGBP: fx('EURGBP', 0.8540, 0.06, 0.00018, 'GBP', 'Euro vs Pound (simulated)'),
  EURJPY: fx('EURJPY', 163.00, 0.09, 0.02, 'JPY', 'Euro vs Yen (simulated)', 3, 0.001),
  GBPJPY: fx('GBPJPY', 190.70, 0.11, 0.03, 'JPY', 'Pound vs Yen (simulated)', 3, 0.001),
  XAGUSD: {
    canonical: 'XAGUSD',
    basePrice: 31.2,
    annualVolatility: 0.28,
    spread: 0.03,
    digits: 3,
    tickSize: 0.001,
    contractSize: 5_000,
    volumeMin: 0.01,
    volumeMax: 50,
    volumeStep: 0.01,
    stopsLevel: 0,
    commissionPerLot: 7,
    swapLongPerLot: -3.1,
    swapShortPerLot: 0.4,
    quoteCurrency: 'USD',
    description: 'Silver vs US Dollar (simulated)',
    sessions: FX_SESSIONS,
  },
  US30: {
    canonical: 'US30',
    basePrice: 42_000,
    annualVolatility: 0.15,
    spread: 3,
    digits: 1,
    tickSize: 0.1,
    contractSize: 1,
    volumeMin: 0.1,
    volumeMax: 100,
    volumeStep: 0.1,
    stopsLevel: 0,
    commissionPerLot: 0,
    swapLongPerLot: -6.5,
    swapShortPerLot: -1.5,
    quoteCurrency: 'USD',
    description: 'Dow Jones 30 (simulated)',
    sessions: ['', '13:30-20:00', '13:30-20:00', '13:30-20:00', '13:30-20:00', '13:30-20:00', ''],
  },
  NAS100: {
    canonical: 'NAS100',
    basePrice: 20_100,
    annualVolatility: 0.2,
    spread: 2,
    digits: 1,
    tickSize: 0.1,
    contractSize: 1,
    volumeMin: 0.1,
    volumeMax: 100,
    volumeStep: 0.1,
    stopsLevel: 0,
    commissionPerLot: 0,
    swapLongPerLot: -7.2,
    swapShortPerLot: -1.9,
    quoteCurrency: 'USD',
    description: 'Nasdaq 100 (simulated)',
    sessions: ['', '13:30-20:00', '13:30-20:00', '13:30-20:00', '13:30-20:00', '13:30-20:00', ''],
  },
  BTCUSD: {
    canonical: 'BTCUSD',
    basePrice: 96_500,
    annualVolatility: 0.55,
    spread: 45,
    digits: 2,
    tickSize: 0.01,
    contractSize: 1,
    volumeMin: 0.01,
    volumeMax: 20,
    volumeStep: 0.01,
    stopsLevel: 0,
    commissionPerLot: 0,
    swapLongPerLot: -18,
    swapShortPerLot: -9,
    quoteCurrency: 'USD',
    description: 'Bitcoin vs US Dollar (simulated)',
    sessions: [],
  },
};

export function demoProfile(canonical: string): DemoInstrumentProfile | null {
  return DEMO_PROFILES[canonical] ?? null;
}

/**
 * Conversion rate from a quote currency to USD, used only by the demo engine to
 * express simulated tick values in the account currency.
 */
export function usdRateFor(quoteCurrency: string, prices: Map<string, number>): number {
  switch (quoteCurrency) {
    case 'USD':
      return 1;
    case 'JPY':
      return 1 / (prices.get('USDJPY') ?? 150);
    case 'CHF':
      return 1 / (prices.get('USDCHF') ?? 0.88);
    case 'CAD':
      return 1 / (prices.get('USDCAD') ?? 1.36);
    case 'GBP':
      return prices.get('GBPUSD') ?? 1.27;
    case 'EUR':
      return prices.get('EURUSD') ?? 1.09;
    default:
      return 1;
  }
}
