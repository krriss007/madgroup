import type { InstrumentSpec, Side } from '../../shared/types';

/** Looks up the current mid price of a symbol, or undefined if unknown. */
export type MidLookup = (symbol: string) => number | undefined;

/** Round a price to the instrument's number of digits. */
export function roundPrice(price: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(price * f) / f;
}

/** Volume in lots, normalised to two decimals (the step is 0.01 for every instrument). */
export function normaliseVolume(volume: number): number {
  return Math.round(volume * 100) / 100;
}

export function validateVolume(volume: unknown, spec: InstrumentSpec): string | null {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return 'Volume must be a number';
  if (volume < spec.minVolume - 1e-9) return `Minimum volume is ${spec.minVolume} lots`;
  if (volume > spec.maxVolume + 1e-9) return `Maximum volume is ${spec.maxVolume} lots`;
  const steps = volume / spec.volumeStep;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return `Volume must be a multiple of ${spec.volumeStep}`;
  return null;
}

/**
 * Convert an amount denominated in `ccy` into USD using current mid prices.
 * USDT is treated as USD. Returns null if no conversion pair is available.
 */
export function ccyToUsd(ccy: string, lookup: MidLookup): number | null {
  if (ccy === 'USD' || ccy === 'USDT') return 1;
  const direct = lookup(`${ccy}USD`) ?? lookup(`${ccy}USDT`);
  if (direct && direct > 0) return direct;
  const inverse = lookup(`USD${ccy}`);
  if (inverse && inverse > 0) return 1 / inverse;
  return null;
}

/** Notional value of a position in USD at `price`. */
export function notionalUsd(spec: InstrumentSpec, volume: number, price: number, lookup: MidLookup): number {
  const rate = ccyToUsd(spec.quoteCcy, lookup) ?? 1;
  return volume * spec.contractSize * price * rate;
}

/** Margin required (USD) to open `volume` at `price` with the given leverage. */
export function requiredMargin(spec: InstrumentSpec, volume: number, price: number, leverage: number, lookup: MidLookup): number {
  return notionalUsd(spec, volume, price, lookup) / leverage;
}

/** Gross profit/loss in USD (before commission and swap). */
export function grossProfitUsd(
  spec: InstrumentSpec,
  side: Side,
  volume: number,
  openPrice: number,
  closePrice: number,
  lookup: MidLookup,
): number {
  const dir = side === 'buy' ? 1 : -1;
  const rate = ccyToUsd(spec.quoteCcy, lookup) ?? 1;
  return dir * (closePrice - openPrice) * volume * spec.contractSize * rate;
}

/**
 * Validate stop-loss / take-profit levels against a reference entry price.
 * Buy: SL below entry, TP above. Sell: SL above entry, TP below.
 */
export function validateStops(
  side: Side,
  entry: number,
  sl: number | null | undefined,
  tp: number | null | undefined,
): string | null {
  if (sl !== null && sl !== undefined) {
    if (!Number.isFinite(sl) || sl <= 0) return 'Invalid stop loss';
    if (side === 'buy' && sl >= entry) return 'Stop loss must be below the entry price for a buy';
    if (side === 'sell' && sl <= entry) return 'Stop loss must be above the entry price for a sell';
  }
  if (tp !== null && tp !== undefined) {
    if (!Number.isFinite(tp) || tp <= 0) return 'Invalid take profit';
    if (side === 'buy' && tp <= entry) return 'Take profit must be above the entry price for a buy';
    if (side === 'sell' && tp >= entry) return 'Take profit must be below the entry price for a sell';
  }
  return null;
}

/** Stops for an open position, validated against the price it would close at (bid for buys, ask for sells). */
export function validateStopsForClose(
  side: Side,
  closePrice: number,
  sl: number | null | undefined,
  tp: number | null | undefined,
): string | null {
  if (sl !== null && sl !== undefined) {
    if (side === 'buy' && sl >= closePrice) return 'Stop loss must be below the current bid for a buy';
    if (side === 'sell' && sl <= closePrice) return 'Stop loss must be above the current ask for a sell';
  }
  if (tp !== null && tp !== undefined) {
    if (side === 'buy' && tp <= closePrice) return 'Take profit must be above the current bid for a buy';
    if (side === 'sell' && tp >= closePrice) return 'Take profit must be below the current ask for a sell';
  }
  return null;
}

/** Margin level in percent (equity / used margin * 100). Null when no margin is used. */
export function marginLevelPct(equity: number, margin: number): number | null {
  if (margin <= 0) return null;
  return (equity / margin) * 100;
}

/** UTC calendar day key, e.g. "2026-10-11". */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
