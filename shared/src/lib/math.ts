/**
 * TradePilot — numeric helpers.
 *
 * All money/price math funnels through here so rounding is consistent between
 * the risk calculator, the demo engine, the validation layer and the UI.
 */

export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  // Epsilon nudge avoids 1.005 -> 1.00 style surprises on binary floats.
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

export function floorTo(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.floor(value * factor + 1e-9) / factor;
}

export function ceilTo(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.ceil(value * factor - 1e-9) / factor;
}

/** Round a price to the instrument's digits. */
export function roundPrice(price: number, digits: number): number {
  return round(price, Math.max(0, Math.min(8, digits)));
}

/** Snap an arbitrary volume to the broker's volume step. */
export function normalizeVolume(volume: number, step: number, digits?: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  const safeStep = step > 0 ? step : 0.01;
  const stepDecimals = digits ?? decimalsOfStep(safeStep);
  return round(Math.round(volume / safeStep) * safeStep, stepDecimals);
}

export function decimalsOfStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const text = step.toString();
  if (text.includes('e-')) {
    const exponent = Number(text.split('e-')[1]);
    return Math.min(8, exponent);
  }
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(8, text.length - dot - 1);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Validate that a value sits on the broker's volume grid without floating
 * point drift (0.30000000000000004 must count as a valid 0.30).
 */
export function isOnVolumeStep(volume: number, step: number, tolerance = 1e-8): boolean {
  if (!Number.isFinite(volume) || step <= 0) return false;
  const ratio = volume / step;
  return Math.abs(ratio - Math.round(ratio)) < tolerance * Math.max(1, ratio);
}

export function percentChange(current: number, reference: number): number {
  if (!reference) return 0;
  return ((current - reference) / reference) * 100;
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
}

export function average(values: number[]): number | null {
  const valid = values.filter((v) => Number.isFinite(v));
  if (!valid.length) return null;
  return sum(valid) / valid.length;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = sum(values) / values.length;
  const variance = sum(values.map((v) => (v - mean) ** 2)) / (values.length - 1);
  return Math.sqrt(variance);
}
