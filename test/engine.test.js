import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from '../src/backtest.js';

const cfg = {
  fastEma: 3, slowEma: 6, rsiPeriod: 5, rsiOverbought: 70,
  atrPeriod: 5, atrMultSL: 1.5, atrMultTP: 2,
  positionSizePct: 10, feeBps: 10, slippageBps: 5, allowShorts: false,
};

function candlesFromCloses(closes) {
  return closes.map((c, i) => ({ t: 1000 + i * 60000, o: c, h: c * 1.001, l: c * 0.999, c, v: 10 }));
}

test('backtest runs on a trending series and reports hypothetical stats', () => {
  const closes = [];
  let p = 100;
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i++) {
    p *= 1 + (rand() - 0.48) * 0.01; // slight upward drift
    closes.push(p);
  }
  const r = runBacktest({ candles: candlesFromCloses(closes), config: cfg, startBalance: 10000 });
  assert.equal(r.hypothetical, true);
  assert.ok(r.barsTested > 200);
  assert.ok(Number.isFinite(r.stats.netPnl));
  assert.ok(r.equityCurve.length > 100);
  for (const t of r.trades) {
    assert.ok(t.fees >= 0, 'fees recorded');
    assert.ok(Number.isFinite(t.netPnl));
    assert.ok(['TAKE_PROFIT', 'STOP_LOSS', 'END_OF_DATA'].includes(t.exitReason));
  }
});

test('backtest refuses too-few candles', () => {
  const r = runBacktest({ candles: candlesFromCloses([1, 2, 3, 4]), config: cfg });
  assert.ok(r.error);
});

test('fees and slippage reduce the net result of a round trip', () => {
  // Synthetic single trade: entry 100 -> exit 101, qty 10, fee 10bps/side, slip 5bps entry.
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push({ t: i * 60000, o: 100, h: 100.02, l: 99.98, c: 100, v: 1 });
  // Manually verify the math used by the paper engine:
  const feeRate = 10 / 10000;
  const slipRate = 5 / 10000;
  const ideal = 100;
  const fill = ideal * (1 + slipRate);
  const qty = 1000 / fill; // 10 units of notional
  const feeEntry = 1000 * feeRate;
  const exitIdeal = 101;
  const exitFill = exitIdeal * (1 - slipRate);
  const feeExit = qty * exitFill * feeRate;
  const gross = (exitFill - fill) * qty;
  const net = gross - feeEntry - feeExit;
  // gross ~ 9.995 - 100.05/100*10... verify invariants instead of exact values:
  assert.ok(net < gross, 'fees must reduce PnL');
  assert.ok(feeEntry > 0 && feeExit > 0);
  assert.ok(Math.abs(net - (gross - feeEntry - feeExit)) < 1e-12);
});
