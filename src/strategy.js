// ---------------------------------------------------------------------------
// Example strategy: "TriTrend" - a deliberately simple, fully explainable
// EMA-crossover system with an RSI momentum filter and ATR-based levels.
//
//   LONG entry, all on the LAST CLOSED candle (no lookahead):
//     1. Trigger: fast EMA crosses ABOVE slow EMA on this candle.
//     2. Filter:  RSI(period) is between 50 and `rsiOverbought`
//                 (momentum confirms, but not overextended).
//     3. Levels:  SL = entry - atrMultSL * ATR, TP = entry + atrMultTP * ATR.
//
//   EXIT: take-profit, stop-loss, or the opposite EMA crossover.
//   Shorts are opt-in via config.allowShorts (default OFF: long-only).
//
// This is an EXAMPLE for learning how the pipeline works. It is NOT a claim
// of profitability and NOT financial advice. See README "Strategy & limits".
// ---------------------------------------------------------------------------
import { ema, rsi as calcRsi, atr as calcAtr } from './indicators.js';

/**
 * Evaluate the strategy on a series of CLOSED candles (oldest -> newest).
 * @param {Array<{t,o,h,l,c,v}>} candles closed candles only
 * @param {object} cfg strategy config subset (see config.defaultEngineConfig)
 * @returns evaluation object consumed by the engine, the analysis panel,
 *          the backtester, and the logger.
 */
export function evaluateStrategy(candles, cfg) {
  const n = candles.length;
  const lastCandle = candles[n - 1];
  const closes = candles.map((c) => c.c);

  const emaFast = ema(closes, cfg.fastEma);
  const emaSlow = ema(closes, cfg.slowEma);
  const rsiSeries = calcRsi(closes, cfg.rsiPeriod);
  const atrSeries = calcAtr(candles, cfg.atrPeriod);

  const f0 = emaFast[n - 1];
  const s0 = emaSlow[n - 1];
  const f1 = n >= 2 ? emaFast[n - 2] : null;
  const s1 = n >= 2 ? emaSlow[n - 2] : null;
  const r0 = rsiSeries[n - 1];
  const a0 = atrSeries[n - 1];
  const price = lastCandle.c;

  const warm = f0 == null || s0 == null || f1 == null || s1 == null || r0 == null || a0 == null;

  const crossoverUp = !warm && f1 <= s1 && f0 > s0;
  const crossoverDown = !warm && f1 >= s1 && f0 < s0;

  const rsiLongOk = !warm && r0 >= 50 && r0 < cfg.rsiOverbought;
  const rsiShortOk = !warm && r0 <= 100 - cfg.rsiOverbought + (100 - cfg.rsiOverbought) * 0 + 50 - 0; // mirrored below
  void rsiShortOk; // mirrored filter computed below for shorts

  let action = 'HOLD';
  let levels = null;
  const rules = [];
  const rationale = [];

  if (warm) {
    rules.push({ id: 'warmup', label: `Enough closed candles for EMA ${cfg.fastEma}/${cfg.slowEma}, RSI ${cfg.rsiPeriod}, ATR ${cfg.atrPeriod}`, passed: false });
    rationale.push('Collecting more closed candles before the strategy can produce signals.');
  } else {
    rules.push({
      id: 'crossover',
      label: `EMA${cfg.fastEma} ${crossoverUp ? 'crossed above' : crossoverDown ? 'crossed below' : 'did not cross'} EMA${cfg.slowEma}`,
      passed: crossoverUp || crossoverDown,
      detail: `EMA${cfg.fastEma} ${fmt(f1)} -> ${fmt(f0)} | EMA${cfg.slowEma} ${fmt(s1)} -> ${fmt(s0)}`,
    });
    rules.push({
      id: 'rsi',
      label: `RSI(${cfg.rsiPeriod}) = ${r0.toFixed(1)} ${rsiLongOk ? 'confirms momentum (50..100 - overbought)' : 'does not confirm'}`,
      passed: rsiLongOk,
      detail: `Requires ${50} <= RSI < ${cfg.rsiOverbought} for longs`,
    });
    rationale.push(
      crossoverUp
        ? `Bullish crossover: EMA${cfg.fastEma} moved above EMA${cfg.slowEma} on the last closed candle.`
        : crossoverDown
          ? `Bearish crossover: EMA${cfg.fastEma} moved below EMA${cfg.slowEma} on the last closed candle.`
          : `No EMA crossover on the last closed candle, so no entry/exit trigger.`
    );
    rationale.push(
      `RSI(${cfg.rsiPeriod}) is ${r0.toFixed(1)}; the long filter wants 50-${cfg.rsiOverbought} (rising momentum, not overbought).`
    );
    rationale.push(`ATR(${cfg.atrPeriod}) = ${fmt(a0)} sizes the stop (x${cfg.atrMultSL}) and target (x${cfg.atrMultTP}).`);

    if (crossoverUp && rsiLongOk) action = 'BUY';
    else if (crossoverDown && cfg.allowShorts && rsiShortOk) action = 'SELL';
    else if (crossoverDown) action = 'SELL'; // long-only: SELL means "exit longs"
    else action = 'HOLD';

    if (action === 'BUY' || (action === 'HOLD' && crossoverUp)) {
      // Entry approximation is the last closed price; the engine adds
      // estimated slippage when it simulates the fill.
      levels = {
        entry: round8(price),
        stopLoss: round8(price - cfg.atrMultSL * a0),
        takeProfit: round8(price + cfg.atrMultTP * a0),
        atr: round8(a0),
      };
    }
    if (action === 'SELL' && cfg.allowShorts) {
      levels = {
        entry: round8(price),
        stopLoss: round8(price + cfg.atrMultSL * a0),
        takeProfit: round8(price - cfg.atrMultTP * a0),
        atr: round8(a0),
      };
    }
  }

  return {
    action, // BUY | SELL | HOLD
    symbolTime: lastCandle.t,
    price: round8(price),
    crossover: crossoverUp ? 'UP' : crossoverDown ? 'DOWN' : null,
    indicators: {
      emaFast: maybe(f0),
      emaSlow: maybe(s0),
      emaFastPrev: maybe(f1),
      emaSlowPrev: maybe(s1),
      rsi: maybe(r0),
      atr: maybe(a0),
    },
    params: {
      fastEma: cfg.fastEma,
      slowEma: cfg.slowEma,
      rsiPeriod: cfg.rsiPeriod,
      rsiOverbought: cfg.rsiOverbought,
      atrPeriod: cfg.atrPeriod,
      atrMultSL: cfg.atrMultSL,
      atrMultTP: cfg.atrMultTP,
      allowShorts: !!cfg.allowShorts,
    },
    rules,
    rationale,
    levels,
    note: levels
      ? null
      : action === 'SELL' && !cfg.allowShorts
        ? 'Short entries are disabled (long-only mode). A bearish crossover only closes open longs.'
        : null,
  };
}

function fmt(x) {
  return x == null ? 'n/a' : Number(x).toFixed(x >= 1000 ? 2 : x >= 1 ? 4 : 6);
}
function maybe(x) {
  return x == null ? null : round8(x);
}
function round8(x) {
  return Math.round(x * 1e8) / 1e8;
}
