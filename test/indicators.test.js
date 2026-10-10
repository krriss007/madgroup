import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, atr, last } from '../src/indicators.js';

test('ema seeds with SMA then follows standard recursion', () => {
  const vals = [1, 2, 3, 4, 5, 6];
  const out = ema(vals, 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 2); // SMA(1,2,3)
  const k = 2 / 4;
  assert.ok(Math.abs(out[3] - (4 * k + 2 * (1 - k))) < 1e-12);
  assert.ok(Math.abs(out[5] - (6 * k + out[4] * (1 - k))) < 1e-12);
});

test('ema matches a constant series exactly', () => {
  const out = ema(new Array(50).fill(7), 12);
  assert.equal(last(out), 7);
});

test('rsi is 100 for a strictly rising series', () => {
  const vals = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(last(rsi(vals, 14)), 100);
});

test('rsi is 0 for a strictly falling series', () => {
  const vals = Array.from({ length: 30 }, (_, i) => 30 - i);
  assert.equal(last(rsi(vals, 14)), 0);
});

test('rsi hovers near 50 for alternating gains/losses', () => {
  // +1, -1 alternating -> avgGain ~= avgLoss -> RSI oscillates toward 50
  const vals = [10];
  for (let i = 0; i < 40; i++) vals.push(vals[i] + (i % 2 === 0 ? 1 : -1));
  const r = last(rsi(vals, 14));
  assert.ok(r > 45 && r < 55, `expected RSI near 50, got ${r}`);
});

test('atr equals high-low after warmup for constant-range candles', () => {
  const candles = Array.from({ length: 40 }, () => ({ o: 100, h: 110, l: 90, c: 105 }));
  const out = atr(candles, 14);
  // Wilder seed lands at index === period (uses TRs 1..14).
  assert.equal(out[13], null);
  assert.ok(Math.abs(out[14] - 20) < 1e-9);
  assert.ok(Math.abs(out[39] - 20) < 1e-9);
});

test('atr handles gaps (|close - prevClose| dominates)', () => {
  const candles = [
    { o: 100, h: 101, l: 99, c: 100 },
    { o: 120, h: 121, l: 119, c: 120 }, // TR = max(2, 21, 19) = 21
  ];
  const out = atr(candles, 1);
  assert.ok(Math.abs(out[1] - 21) < 1e-9);
});

test('short inputs return all-null series instead of throwing', () => {
  assert.deepEqual(ema([1], 3), [null]);
  assert.deepEqual(rsi([1, 2], 14), [null, null]);
  assert.deepEqual(atr([{ o: 1, h: 1, l: 1, c: 1 }], 14), [null]);
  assert.equal(last([null, null]), null);
});
