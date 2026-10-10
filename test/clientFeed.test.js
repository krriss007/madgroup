import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandleRows, alignRowsToLastBar, ClientFeedStore } from '../src/data/clientFeed.js';
import { MARKETS } from '../src/data/databus.js';

const TF = 60_000;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function rows(n, startPrice = 100) {
  const out = [];
  let p = startPrice;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * 1.001;
    out.push([NOW - (n - i) * TF, o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c, 10]);
    p = c;
  }
  return out;
}

test('accepts well-formed rows and marks completed candles', () => {
  const r = validateCandleRows(rows(50), TF, NOW);
  assert.ok(!r.error, r.error);
  assert.equal(r.candles.length, 50);
  // last candle ends exactly at NOW -> complete
  assert.equal(r.candles[r.candles.length - 1].complete, true);
});

test('rejects too few rows, bad shapes and non-finite values', () => {
  assert.ok(validateCandleRows(rows(5), TF, NOW).error);
  assert.ok(validateCandleRows('nope', TF, NOW).error);
  assert.ok(validateCandleRows(rows(30).map((r) => r.slice(0, 3)), TF, NOW).error);
  const bad = rows(30);
  bad[10][2] = 'x';
  assert.ok(validateCandleRows(bad, TF, NOW).error);
});

test('rejects decreasing timestamps and future data', () => {
  const unsorted = rows(30);
  [unsorted[5], unsorted[6]] = [unsorted[6], unsorted[5]];
  assert.match(validateCandleRows(unsorted, TF, NOW).error, /strictly increase/);
  const future = rows(30);
  future[29][0] = NOW + 60 * 60_000;
  assert.match(validateCandleRows(future, TF, NOW).error, /future/);
});

test('rejects non-positive prices, negative volume, OHLC violations', () => {
  const zero = rows(30);
  zero[3][1] = 0;
  assert.ok(validateCandleRows(zero, TF, NOW).error);
  const negVol = rows(30);
  negVol[3][5] = -1;
  assert.match(validateCandleRows(negVol, TF, NOW).error, /negative volume/);
  const badOhlc = rows(30);
  badOhlc[7][2] = badOhlc[7][3] * 0.5; // high below low
  assert.match(validateCandleRows(badOhlc, TF, NOW).error, /OHLC/);
});

test('alignRowsToLastBar re-anchors broker-clock timestamps to UTC bars', () => {
  // MT4 broker at UTC+3: last bar tagged 3h "ahead"; spacing preserved (1m).
  const src = rows(30);
  const shifted = src.map((r) => [r[0] + 3 * 3_600_000, r[1], r[2], r[3], r[4], r[5]]);
  const res = alignRowsToLastBar(shifted, TF, NOW);
  assert.ok(!res.error, res.error);
  const lastT = res.rows[res.rows.length - 1][0];
  // last (in-progress) bar now starts exactly on the UTC boundary containing NOW
  assert.equal(lastT, Math.floor(NOW / TF) * TF);
  // the applied shift exactly undoes the 3h broker offset (mod one bar)
  assert.equal(res.offsetSec, (lastT - shifted[shifted.length - 1][0]) / 1000);
  // spacing unchanged
  assert.equal(res.rows[1][0] - res.rows[0][0], TF);
  const back = validateCandleRows(res.rows, TF, NOW);
  assert.ok(!back.error, back.error);
});

test('alignRowsToLastBar passes through when already aligned, rejects absurd shifts', () => {
  // rows whose newest bar starts exactly on the boundary containing NOW
  const boundary = Math.floor(NOW / TF) * TF;
  const src = rows(30).map((r) => [r[0] + TF, r[1], r[2], r[3], r[4], r[5]]);
  assert.equal(src[src.length - 1][0], boundary);
  const aligned = alignRowsToLastBar(src, TF, NOW);
  assert.equal(aligned.offsetSec, 0);
  assert.deepEqual(aligned.rows, src);
  const far = rows(30).map((r) => [r[0] + 100 * 3_600_000, r[1], r[2], r[3], r[4], r[5]]);
  assert.match(alignRowsToLastBar(far, TF, NOW).error, /too far/);
  assert.ok(alignRowsToLastBar([], TF, NOW).error);
});

test('store: ingest + fresh get + okxOnly filter', () => {
  const store = new ClientFeedStore();
  const res = store.ingest('BTC-USDT', '1m', TF, rows(60), 'OKX', NOW);
  assert.ok(res.ok);
  const feed = store.get('BTC-USDT', '1m', TF, { now: NOW + 30_000 });
  assert.equal(feed.provider, 'OKX');
  assert.equal(feed.candles.length, 60);
  // DATA_SOURCE=okx accepts only the OKX provider
  assert.equal(store.get('BTC-USDT', '1m', TF, { okxOnly: true, now: NOW + 30_000 }), feed);
});

test('store: MT4-style provider labels with colons are accepted', () => {
  const store = new ClientFeedStore();
  const res = store.ingest('EUR-USD', '1m', TF, rows(60), 'MT4:Demo-ICMarkets', NOW);
  assert.ok(res.ok, res.error);
  assert.equal(store.get('EUR-USD', '1m', TF, { now: NOW + 10_000 }).provider, 'MT4:Demo-ICMarkets');
});

test('store: feed goes stale once the feeder stops refreshing it', () => {
  const store = new ClientFeedStore();
  store.ingest('ETH-USDT', '1m', TF, rows(60), 'Kraken', NOW);
  // fresh window for 1m bars = max(2*60s, 60s) = 120s
  assert.ok(store.get('ETH-USDT', '1m', TF, { now: NOW + 100_000 }));
  assert.equal(store.get('ETH-USDT', '1m', TF, { now: NOW + 180_000 }), null);
});

test('store: rejects invalid provider labels and bad rows', () => {
  const store = new ClientFeedStore();
  assert.ok(store.ingest('BTC-USDT', '1m', TF, rows(30), '', NOW).error);
  assert.ok(store.ingest('BTC-USDT', '1m', TF, rows(30), 'x'.repeat(50), NOW).error);
  assert.ok(store.ingest('BTC-USDT', '1m', TF, rows(5), 'OKX', NOW).error);
});

test('market list covers MT4-mappable symbols with unique, friendly labels', () => {
  const symbols = MARKETS.map((m) => m.symbol);
  for (const s of ['EUR-USD', 'USD-JPY', 'XAU-USD', 'BTC-USD', 'BTC-USDT']) {
    assert.ok(symbols.includes(s), `missing ${s}`);
  }
  assert.equal(new Set(symbols).size, symbols.length, 'symbols must be unique');
  const labels = MARKETS.map((m) => m.label);
  assert.ok(labels.includes('EUR/USD'));
  assert.ok(labels.includes('XAU/USD'));
  assert.ok(labels.includes('BTC/USDT'));
  assert.equal(new Set(labels).size, labels.length, 'labels must be unique');
});
