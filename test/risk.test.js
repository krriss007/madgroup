import test from 'node:test';
import assert from 'node:assert/strict';
import { gateEntry } from '../src/risk.js';

const baseState = () => ({
  bot: { status: 'RUNNING', target: { symbol: 'BTC-USDT', tf: '5m' } },
  risk: { dayHalted: false, lastLossAt: null, killActive: false },
  account: { dayStartEquity: 10000 },
});
const baseConfig = {
  positionSizePct: 10, maxOpenPositions: 3, dailyLossLimitPct: 5, cooldownSec: 300,
};
const baseCtx = (over = {}) => ({
  config: { ...baseConfig, ...(over.config || {}) },
  account: baseState().account,
  equity: 10000,
  positions: [],
  symbol: 'BTC-USDT',
  now: 1_000_000,
  state: baseState(),
  ...over,
});

test('allows a normal entry', () => {
  const d = gateEntry(baseCtx());
  assert.equal(d.allowed, true);
});

test('blocks when emergency stop (KILL) is active', () => {
  const ctx = baseCtx();
  ctx.state.bot.status = 'KILLED';
  const d = gateEntry(ctx);
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'KILL_SWITCH');
});

test('blocks while day-halted', () => {
  const ctx = baseCtx();
  ctx.state.risk.dayHalted = true;
  const d = gateEntry(ctx);
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'DAILY_LOSS_HALT');
});

test('duplicate-order prevention: same symbol already open', () => {
  const d = gateEntry(baseCtx({ positions: [{ symbol: 'BTC-USDT', side: 'LONG' }] }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'DUPLICATE_SYMBOL');
});

test('another open symbol does not block a different market', () => {
  const d = gateEntry(baseCtx({ positions: [{ symbol: 'ETH-USDT', side: 'LONG' }] }));
  assert.equal(d.allowed, true);
});

test('max open positions caps entries', () => {
  const d = gateEntry(baseCtx({
    config: { ...baseConfig, maxOpenPositions: 2 },
    positions: [{ symbol: 'A' }, { symbol: 'B' }],
  }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'MAX_POSITIONS');
});

test('cooldown after a losing trade blocks new entries within window', () => {
  const d = gateEntry(baseCtx({ state: { ...baseState(), risk: { dayHalted: false, lastLossAt: 1_000_000 - 100, killActive: false } } }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'COOLDOWN');
});

test('cooldown passes after the window elapses', () => {
  const d = gateEntry(baseCtx({ state: { ...baseState(), risk: { dayHalted: false, lastLossAt: 1_000_000 - 301_000, killActive: false } } }));
  assert.equal(d.allowed, true);
});

test('zero-equity (bad notional) is refused', () => {
  const d = gateEntry(baseCtx({ equity: 0 }));
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'BAD_SIZE');
});
