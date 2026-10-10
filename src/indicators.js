// ---------------------------------------------------------------------------
// Pure indicator functions. No state, no I/O - easy to unit-test.
// All functions return arrays aligned with the input (null while warming up).
// ---------------------------------------------------------------------------

/**
 * Exponential Moving Average. Seeded with the SMA of the first `period`
 * values, standard EMA thereafter.
 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period || period < 1) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index (Wilder's smoothing).
 */
export function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period || period < 1) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Average True Range (Wilder's smoothing) over OHLC candles.
 * `candles`: [{o, h, l, c}] (volume/timestamps not needed).
 */
export function atr(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period || period < 1) return out;
  const trs = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const { h, l, c } = candles[i];
    const prevClose = candles[i - 1].c;
    trs[i] = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Last non-null value of an indicator series, or null. */
export function last(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null && Number.isFinite(series[i])) return series[i];
  }
  return null;
}
