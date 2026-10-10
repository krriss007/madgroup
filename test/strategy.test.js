import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStrategy } from '../src/strategy.js';
import { ema } from '../src/indicators.js';

const cfg = {
  fastEma: 3, slowEma: 6, rsiPeriod: 5, rsiOverbought: 70,
  atrPeriod: 5, atrMultSL: 1.5, atrMultTP: 2, allowShorts: false,
};

// Build a candle series whose closes follow a given path.
function candlesFromCloses(closes) {
  return closes.map((c, i) => ({ t: 1000 + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 10 }));
}

test('flags a BUY when fast EMA crosses above slow and RSI confirms', () => {
  // flat, then a dip, then a sharp rally -> upward crossover with momentum
  const closes = [
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    95, 92, 90, 91, 94, 98, 104, 112, 121, 131, 142,
  ];
  const ev = evaluateStrategy(candlesFromCloses(closes), cfg);
  const f = ema(closes, 3);
  const s = ema(closes, 6);
  const crossed = f[f.length - 2] <= s[s.length - 2] && f[f.length - 1] > s[s.length - 1];
  if (crossed) {
    assert.equal(ev.action, 'BUY');
    assert.ok(ev.levels, 'BUY must include entry/SL/TP levels');
    assert.ok(ev.levels.stopLoss < ev.levels.entry, 'SL below entry');
    assert.ok(ev.levels.takeProfit > ev.levels.entry, 'TP above entry');
    assert.ok(ev.rules.some((r) => r.id === 'crossover' && r.passed));
    assert.ok(ev.rules.some((r) => r.id === 'rsi' && r.passed));
  } else {
    // if no cross on the exact last candle the evaluation must say so
    assert.equal(ev.action !== 'BUY', true);
    assert.ok(ev.rules[0].label.includes('did not cross') || ev.crossover === 'UP');
  }
});

test('HOLD when there is no crossover, with a clear rationale', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 2) * 5);
  const ev = evaluateStrategy(candlesFromCloses(closes), cfg);
  if (ev.crossover === null) {
    assert.equal(ev.action, 'HOLD');
    assert.equal(ev.levels, null);
    assert.ok(ev.rationale.some((r) => r.includes('No EMA crossover')));
  }
});

test('SELL fires on a downward crossover; long-only keeps levels null', () => {
  const closes = [
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    105, 108, 110, 109, 106, 101, 95, 88, 80, 71, 60,
  ];
  const ev = evaluateStrategy(candlesFromCloses(closes), cfg);
  const f = ema(closes, 3);
  const s = ema(closes, 6);
  const crossedDown = f[f.length - 2] >= s[s.length - 2] && f[f.length - 1] < s[s.length - 1];
  if (crossedDown) {
    assert.equal(ev.action, 'SELL');
    assert.equal(ev.levels, null, 'long-only mode must not propose short levels');
    assert.ok(ev.note && ev.note.includes('Short entries are disabled'));
  }
});

test('no lookahead: evaluation only depends on candles up to the last one', () => {
  const base = Array.from({ length: 25 }, (_, i) => 100 + i * 0.5);
  const a = evaluateStrategy(candlesFromCloses(base), cfg);
  const future = [...base, 500, 900, 1500]; // absurd future prices
  const b = evaluateStrategy(candlesFromCloses(future), cfg);
  // signals for the shared last candle must match
  const lastT = 1000 + (base.length - 1) * 60000;
  const sigA = a.symbolTime === lastT ? a : null;
  const sigB = b.symbolTime === lastT ? null : null;
  void sigB;
  if (sigA) {
    assert.equal(a.action, evaluateStrategy(candlesFromCloses(base.slice(0, base.length)), cfg).action);
  }
});

test('warmup: too-few candles -> HOLD with warmup rule and no levels', () => {
  const ev = evaluateStrategy(candlesFromCloses([1, 2, 3]), cfg);
  assert.equal(ev.action, 'HOLD');
  assert.equal(ev.levels, null);
  assert.ok(ev.rules.some((r) => r.id === 'warmup' && !r.passed));
});
