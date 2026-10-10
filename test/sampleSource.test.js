import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleSeries } from '../src/data/sampleSource.js';

test('sample series are deterministic: two instances agree bar for bar', () => {
  const a = new SampleSeries('BTC-USDT', 3600000);
  const b = new SampleSeries('BTC-USDT', 3600000);
  const until = Date.UTC(2026, 0, 1) + 400 * 3600000;
  a.advanceTo(until);
  b.advanceTo(until);
  assert.equal(a.bars.length, 400);
  for (let i = 0; i < 400; i++) {
    assert.deepEqual(
      [a.bars[i].o, a.bars[i].h, a.bars[i].l, a.bars[i].c],
      [b.bars[i].o, b.bars[i].h, b.bars[i].l, b.bars[i].c]
    );
  }
});

test('different symbols produce different series', () => {
  const a = new SampleSeries('BTC-USDT', 3600000);
  const b = new SampleSeries('ETH-USDT', 3600000);
  const until = Date.UTC(2026, 0, 1) + 200 * 3600000;
  a.advanceTo(until);
  b.advanceTo(until);
  assert.notEqual(a.bars[100].c, b.bars[100].c);
});

test('bars are contiguous, ordered and OHLC-sane', () => {
  const s = new SampleSeries('SOL-USDT', 300000);
  s.advanceTo(Date.UTC(2026, 0, 1) + 500 * 300000);
  for (let i = 1; i < s.bars.length; i++) {
    const prev = s.bars[i - 1];
    const bar = s.bars[i];
    assert.equal(bar.t, prev.t + 300000);
    assert.ok(bar.h >= Math.max(bar.o, bar.c) - 1e-9, 'high >= max(open, close)');
    assert.ok(bar.l <= Math.min(bar.o, bar.c) + 1e-9, 'low <= min(open, close)');
    assert.ok(bar.v > 0);
  }
});

test('prices stay within a sane band of the base level', () => {
  const s = new SampleSeries('DOGE-USDT', 60000);
  s.advanceTo(Date.UTC(2026, 0, 1) + 5000 * 60000);
  for (const b of s.bars) {
    assert.ok(b.c > 0.12 * 0.15 && b.c < 0.12 * 5, `close ${b.c} outside clamp band`);
  }
});
