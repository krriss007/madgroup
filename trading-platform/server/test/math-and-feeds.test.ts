import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ccyToUsd,
  grossProfitUsd,
  marginLevelPct,
  notionalUsd,
  requiredMargin,
  validateStops,
  validateVolume,
  utcDay,
} from '../trading/math';
import { getInstrument, INSTRUMENTS } from '../market/instruments';
import { parseBookTicker, parseKline, TF_TO_BINANCE } from '../market/binance';
import { parseCandles, parseTradeMessage, candleEndpoint } from '../market/finnhub';
import { applyToBars, aggregateBars, MarketData } from '../market/marketData';
import { generateSeries, gaussian } from '../market/simulator';
import { TIMEFRAME_MS, TIMEFRAMES } from '../../shared/types';

const prices: Record<string, number> = { EURUSD: 1.085, USDJPY: 150, GBPUSD: 1.25, BTCUSDT: 65000 };
const lookup = (s: string) => prices[s];

describe('trading math', () => {
  test('notional for a USD-quoted forex pair', () => {
    const eur = getInstrument('EURUSD')!;
    assert.equal(notionalUsd(eur, 1, 1.085, lookup), 108_500);
    assert.equal(requiredMargin(eur, 1, 1.085, 100, lookup), 1085);
  });

  test('JPY-quoted pair converts notional into USD via USDJPY', () => {
    const usdjpy = getInstrument('USDJPY')!;
    // 1 lot = 100,000 USD of base. Notional in JPY = 100,000 * 150 → USD = 100,000.
    assert.ok(Math.abs(notionalUsd(usdjpy, 1, 150, lookup) - 100_000) < 1e-6);
  });

  test('profit is signed by direction and converted to USD', () => {
    const eur = getInstrument('EURUSD')!;
    assert.ok(Math.abs(grossProfitUsd(eur, 'buy', 1, 1.08, 1.0810, lookup) - 100) < 1e-6); // 10 pips * $10/pip
    assert.ok(Math.abs(grossProfitUsd(eur, 'sell', 1, 1.08, 1.0810, lookup) + 100) < 1e-6);
  });

  test('ccy conversion handles direct, inverse and USDT quotes', () => {
    assert.equal(ccyToUsd('USD', lookup), 1);
    assert.equal(ccyToUsd('USDT', lookup), 1);
    assert.equal(ccyToUsd('GBP', () => undefined), null);
    assert.equal(ccyToUsd('GBP', (s) => (s === 'GBPUSD' ? 1.25 : undefined)), 1.25);
    assert.ok(Math.abs((ccyToUsd('JPY', lookup) ?? 0) - 1 / 150) < 1e-12);
  });

  test('volume validation enforces min, max, and step', () => {
    const eur = getInstrument('EURUSD')!;
    assert.equal(validateVolume(0.01, eur), null);
    assert.equal(validateVolume(1.5, eur), null);
    assert.ok(validateVolume(0.001, eur));
    assert.ok(validateVolume(0.015, eur));
    assert.ok(validateVolume(101, eur));
    assert.ok(validateVolume('0.1' as never, eur));
  });

  test('stop validation depends on side', () => {
    assert.equal(validateStops('buy', 100, 90, 110), null);
    assert.ok(validateStops('buy', 100, 110, null));
    assert.ok(validateStops('sell', 100, 90, null));
    assert.equal(validateStops('sell', 100, 110, 90), null);
    assert.ok(validateStops('sell', 100, null, 110));
  });

  test('margin level and UTC day helpers', () => {
    assert.equal(marginLevelPct(5000, 0), null);
    assert.equal(marginLevelPct(5000, 2500), 200);
    assert.equal(utcDay(Date.UTC(2026, 9, 11, 23, 59)), '2026-10-11');
  });

  test('every instrument has a sane spec', () => {
    for (const i of INSTRUMENTS) {
      assert.ok(i.spread > 0, i.symbol);
      assert.ok(i.contractSize > 0, i.symbol);
      assert.ok(i.simBasePrice > 0, i.symbol);
      assert.ok(i.minVolume > 0 && i.maxVolume >= i.minVolume, i.symbol);
    }
  });
});

describe('feed message parsing', () => {
  test('Binance bookTicker combined-stream message', () => {
    const msg = { stream: 'btcusdt@bookTicker', data: { u: 1, s: 'BTCUSDT', b: '64999.5', B: '1', a: '65000.5', A: '2' } };
    assert.deepEqual(parseBookTicker(msg), { binanceSymbol: 'BTCUSDT', bid: 64999.5, ask: 65000.5 });
    assert.equal(parseBookTicker({ foo: 1 }), null);
    assert.equal(parseBookTicker({ data: { s: 'X', b: '0', a: '1' } }), null);
  });

  test('Binance kline row maps to a bar', () => {
    const bar = parseKline([1700000000000, '1', '2', '0.5', '1.5', '10', 0]);
    assert.deepEqual(bar, { t: 1700000000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    assert.equal(TF_TO_BINANCE.H4, '4h');
  });

  test('Finnhub trade message keeps the latest price per symbol', () => {
    const msg = {
      type: 'trade',
      data: [
        { s: 'OANDA:EUR_USD', p: 1.0851, t: 1000, v: 1 },
        { s: 'OANDA:EUR_USD', p: 1.0853, t: 2000, v: 1 },
        { s: 'BINANCE:BTCUSDT', p: 65010, t: 1500, v: 0.1 },
      ],
    };
    const trades = parseTradeMessage(msg);
    assert.equal(trades.length, 2);
    assert.equal(trades.find((t) => t.finnhubSymbol === 'OANDA:EUR_USD')!.price, 1.0853);
    assert.deepEqual(parseTradeMessage({ type: 'ping' }), []);
  });

  test('Finnhub candle payload parsing and error on no_data', () => {
    const bars = parseCandles({ s: 'ok', t: [1700000000, 1700000060], o: [1, 2], h: [2, 3], l: [0.5, 1], c: [1.5, 2.5], v: [10, 11] });
    assert.equal(bars.length, 2);
    assert.equal(bars[0]!.t, 1_700_000_000_000);
    assert.throws(() => parseCandles({ s: 'no_data' }), /no candle data/);
  });

  test('candle endpoint selection', () => {
    assert.equal(candleEndpoint('OANDA:EUR_USD'), 'forex');
    assert.equal(candleEndpoint('BINANCE:BTCUSDT'), 'crypto');
  });
});

describe('candles and aggregation', () => {
  test('ticks update the forming candle and open new buckets on boundaries', () => {
    const bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
    const m = TIMEFRAME_MS.M1;
    const t0 = Math.floor(Date.UTC(2026, 9, 12, 10) / m) * m;
    applyToBars(bars, m, t0 + 5_000, 1.1);
    applyToBars(bars, m, t0 + 20_000, 1.2);
    applyToBars(bars, m, t0 + 40_000, 1.05);
    assert.equal(bars.length, 1);
    assert.deepEqual([bars[0]!.o, bars[0]!.h, bars[0]!.l, bars[0]!.c], [1.1, 1.2, 1.05, 1.05]);
    applyToBars(bars, m, t0 + 61_000, 1.07);
    assert.equal(bars.length, 2);
    assert.equal(bars[1]!.o, 1.05, 'new candle opens at previous close');
  });

  test('aggregateBars groups H1 into H4', () => {
    const h1 = [0, 1, 2, 3, 4].map((i) => ({ t: i * 3_600_000, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1 }));
    const h4 = aggregateBars(h1, TIMEFRAME_MS.H4);
    assert.equal(h4.length, 2);
    assert.equal(h4[0]!.o, 0);
    assert.equal(h4[0]!.c, 3.5);
    assert.equal(h4[0]!.h, 4);
    assert.equal(h4[1]!.v, 1);
  });

  test('simulated series ends exactly at the current price for every timeframe', () => {
    let seed = 42;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (const tf of TIMEFRAMES) {
      const bars = generateSeries({ tf, count: 200, endTime: Date.UTC(2026, 9, 12), basePrice: 100, endPrice: 101.25, dailyVolPct: 1, speed: 3, rng });
      assert.equal(bars.length, 200);
      assert.equal(bars[bars.length - 1]!.c, 101.25);
      for (const b of bars) assert.ok(b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c), `${tf} OHLC order`);
      for (let i = 1; i < bars.length; i++) assert.ok(bars[i]!.t > bars[i - 1]!.t, 'ascending time');
      for (let i = 1; i < bars.length; i++) assert.equal(bars[i]!.o, bars[i - 1]!.c, 'bars are continuous');
    }
    assert.ok(Number.isFinite(gaussian(rng)));
  });

  test('market data reports source and day stats', () => {
    const md = new MarketData(INSTRUMENTS);
    md.seed('EURUSD', 'D1', [{ t: Date.UTC(2026, 9, 12), o: 1.08, h: 1.09, l: 1.07, c: 1.085, v: 1 }]);
    md.tick('EURUSD', 1.087, Date.UTC(2026, 9, 12, 12), { source: 'live', spread: 0.0001 });
    const raw = md.raw('EURUSD')!;
    assert.equal(raw.source, 'live');
    assert.equal(raw.dayOpen, 1.08);
    assert.equal(raw.high, 1.09);
  });
});
