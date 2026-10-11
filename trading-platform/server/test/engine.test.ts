import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers';
import { STOP_OUT_LEVEL } from '../trading/engine';

const EURUSD_SPREAD = 0.00008;

describe('order placement', () => {
  test('market buy opens a position with margin reserved at the ask', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    const res = h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.1, sl: 1.08, tp: 1.09 }, 'manual');
    assert.equal(res.ok, true);
    const pos = h.state.positions[0]!;
    const ask = 1.085 + EURUSD_SPREAD / 2;
    assert.equal(pos.openPrice, Number(ask.toFixed(5)));
    // 0.1 lot * 100,000 * price / 100 (1:100 leverage)
    assert.ok(Math.abs(pos.margin - (0.1 * 100_000 * ask) / 100) < 1e-6);
    assert.equal(h.state.orders[0]!.status, 'filled');
  });

  test('rejects stops on the wrong side of the entry', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    const res = h.engine.placeOrder({ symbol: 'EURUSD', side: 'sell', type: 'market', volume: 0.1, sl: 1.07 }, 'manual');
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /Stop loss must be above/);
    assert.equal(h.state.positions.length, 0);
  });

  test('rejects volumes below minimum, off-step, or above maximum', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    for (const volume of [0.005, 0.015, 150]) {
      const res = h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume }, 'manual');
      assert.equal(res.ok, false, `volume ${volume} should be rejected`);
    }
  });

  test('rejects orders that exceed free margin', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.setSettings({ leverage: 1 });
    const res = h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 1 }, 'manual');
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /Not enough free margin/);
  });

  test('pending buy limit must sit below the ask and fills when price reaches it', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    const bad = h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'limit', volume: 0.1, price: 1.09 }, 'manual');
    assert.equal(bad.ok, false);
    const ok = h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'limit', volume: 0.1, price: 1.08 }, 'manual');
    assert.equal(ok.ok, true);
    assert.equal(h.state.pending.length, 1);
    h.tick('EURUSD', 1.0802); // ask ~1.08024: not yet
    assert.equal(h.state.pending.length, 1);
    h.tick('EURUSD', 1.0799); // ask ~1.07994 <= 1.08: fills
    assert.equal(h.state.pending.length, 0);
    assert.equal(h.state.positions.length, 1);
    assert.equal(h.state.orders.find((o) => o.id === ok.data.ticket)!.status, 'filled');
  });

  test('pending prices more than 50% away from the market are rejected', () => {
    const h = harness();
    h.tick('XAUUSD', 4000);
    const res = h.engine.placeOrder({ symbol: 'XAUUSD', side: 'buy', type: 'limit', volume: 0.01, price: 1 }, 'manual');
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /within 50%/);
  });

  test('pending buy stop triggers once price rises through it', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'stop', volume: 0.1, price: 1.09 }, 'manual');
    h.tick('EURUSD', 1.0905);
    assert.equal(h.state.positions.length, 1);
  });

  test('cancelling a pending order marks it cancelled', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    const res = h.engine.placeOrder({ symbol: 'EURUSD', side: 'sell', type: 'limit', volume: 0.1, price: 1.09 }, 'manual');
    assert.equal(res.ok, true);
    assert.equal(h.engine.cancelOrder(res.ok ? res.data.ticket : 0).ok, true);
    assert.equal(h.state.pending.length, 0);
    assert.equal(h.state.orders[0]!.status, 'cancelled');
  });
});

describe('closing and managing positions', () => {
  test('stop loss closes the position at a loss', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.1, sl: 1.08 }, 'manual');
    const before = h.state.balance;
    h.tick('EURUSD', 1.0795);
    assert.equal(h.state.positions.length, 0);
    assert.equal(h.state.history[0]!.reason, 'sl');
    assert.ok(h.state.balance < before, 'balance should fall');
  });

  test('take profit closes the position at a profit', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.1, tp: 1.09 }, 'manual');
    h.tick('EURUSD', 1.0905);
    assert.equal(h.state.history[0]!.reason, 'tp');
    assert.ok(h.state.history[0]!.profit > 0);
  });

  test('partial close reduces volume and records a history entry for the closed part', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.3 }, 'manual');
    const res = h.engine.closePosition(h.state.positions[0]!.id, { volume: 0.1 });
    assert.equal(res.ok, true);
    assert.equal(h.state.positions[0]!.volume, 0.2);
    assert.equal(h.state.history[0]!.volume, 0.1);
  });

  test('partial close volume must be a multiple of the volume step', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.1 }, 'manual');
    const id = h.state.positions[0]!.id;
    assert.equal(h.engine.closePosition(id, { volume: 0.015 }).ok, false);
    assert.equal(h.state.positions[0]!.volume, 0.1);
  });

  test('modify validates new stops against the current price', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.1 }, 'manual');
    const id = h.state.positions[0]!.id;
    assert.equal(h.engine.modifyPosition(id, { sl: 1.1 }).ok, false);
    assert.equal(h.engine.modifyPosition(id, { sl: 1.08 }).ok, true);
    assert.equal(h.state.positions[0]!.sl, 1.08);
    assert.equal(h.engine.modifyPosition(id, { sl: null }).ok, true);
    assert.equal(h.state.positions[0]!.sl, null);
  });

  test('close all closes every open position', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.tick('XAUUSD', 4000);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.1 }, 'manual');
    h.engine.placeOrder({ symbol: 'XAUUSD', side: 'sell', type: 'market', volume: 0.01 }, 'agent');
    const res = h.engine.closeAll({}, 'close_all');
    assert.deepEqual(res, { ok: true, data: 2 });
    assert.equal(h.state.positions.length, 0);
  });
});

describe('risk, margin and account rules', () => {
  test('stop-out closes positions when margin level falls to the stop-out level', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    for (let i = 0; i < 8; i++) h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 1 }, 'manual');
    assert.equal(h.state.positions.length, 8);
    // 8 lots: a 0.0075 drop costs about $6,000 of a $10,000 balance.
    h.tick('EURUSD', 1.0775);
    assert.ok(h.state.history.some((t) => t.reason === 'stop_out'), 'expected a stop-out');
    const s = h.engine.summary();
    assert.ok(s.marginLevel === null || s.marginLevel > STOP_OUT_LEVEL, `margin level ${s.marginLevel} should be above stop-out`);
  });

  test('swap is charged once per UTC day rollover', () => {
    const h = harness(Date.UTC(2026, 9, 12, 20, 0, 0));
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 1 }, 'manual');
    const before = h.state.balance;
    h.clock.t = Date.UTC(2026, 9, 13, 0, 5, 0);
    h.tick('EURUSD', 1.085);
    const notional = 1 * 100_000 * h.market.mid('EURUSD');
    const expected = (notional * -0.0045) / 100;
    assert.ok(Math.abs(h.state.balance - before - expected) < 0.01, `swap ${h.state.balance - before} vs ${expected}`);
    assert.equal(h.state.ledger[0]!.type, 'swap');
    // A second tick on the same day does not charge again.
    const afterFirst = h.state.balance;
    h.tick('EURUSD', 1.0851);
    assert.equal(h.state.balance, afterFirst);
  });

  test('raw account charges commission per lot on open and on close', () => {
    const h = harness();
    h.engine.setSettings({ accountType: 'raw' });
    h.tick('EURUSD', 1.085);
    const start = h.state.balance;
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 2 }, 'manual');
    assert.equal(h.state.balance, start - 7, 'open commission $3.50 × 2 lots');
    h.engine.closeAll({}, 'close_all');
    const closeComm = h.state.ledger.find((l) => l.type === 'commission' && l.amount < 0 && l.note.includes('close'));
    assert.ok(closeComm, 'close commission recorded in ledger');
  });

  test('raw account has tighter spreads than standard', () => {
    const h = harness();
    const std = h.engine.quote('EURUSD')!;
    h.engine.setSettings({ accountType: 'raw' });
    const raw = h.engine.quote('EURUSD')!;
    assert.ok(raw.ask - raw.bid < std.ask - std.bid);
  });

  test('deposit adds funds and withdrawal is limited to free margin', () => {
    const h = harness();
    assert.equal(h.engine.deposit(500).ok, true);
    assert.equal(h.state.balance, 10_500);
    assert.equal(h.engine.deposit(-5).ok, false);
    assert.equal(h.engine.withdraw(20_000).ok, false);
    assert.equal(h.engine.withdraw(500).ok, true);
    assert.equal(h.state.balance, 10_000);
  });

  test('reset restores the starting balance and clears history', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.1 }, 'manual');
    h.engine.closeAll({}, 'close_all');
    h.engine.reset();
    assert.equal(h.state.balance, 10_000);
    assert.equal(h.state.history.length, 0);
    assert.equal(h.state.positions.length, 0);
  });

  test('rejects unsupported leverage and account types', () => {
    const h = harness();
    assert.equal(h.engine.setSettings({ leverage: 3 }).ok, false);
    assert.equal(h.engine.setSettings({ accountType: 'bogus' as never }).ok, false);
    assert.equal(h.engine.setSettings({ leverage: 500 }).ok, true);
  });

  test('summary reflects floating P/L and margin', () => {
    const h = harness();
    h.tick('EURUSD', 1.085);
    h.engine.placeOrder({ symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.1 }, 'manual');
    h.tick('EURUSD', 1.0950);
    const s = h.engine.summary();
    assert.ok(s.floatingPnl > 0);
    assert.ok(Math.abs(s.equity - (s.balance + s.floatingPnl)) < 1e-9);
    assert.ok(Math.abs(s.freeMargin - (s.equity - s.margin)) < 1e-9);
  });
});
