// ---------------------------------------------------------------------------
// Data bus: resolves which market-data source to use and normalises errors.
// Resolution order:
//   1. CLIENT FEED  - public exchange candles relayed by an external feeder
//                     (browser collector or the MT4 EA; used only while fresh).
//   2. SERVER OKX   - OKX public REST (read-only), when the server can reach it.
//   3. SAMPLE       - deterministic simulated candles, always clearly labelled.
// DATA_SOURCE modes: "auto" (1 -> 2 -> 3), "okx" (client feed restricted to the
// OKX provider, then 2), "sample" (3 only).
// The rest of the app only ever talks to this module.
// ---------------------------------------------------------------------------
import { SampleSource } from './sampleSource.js';
import { OkxSource } from './okxSource.js';
import { ClientFeedStore } from './clientFeed.js';
import { logSystem } from '../logger.js';
import { serverConfig } from '../config.js';

export const TIMEFRAMES = Object.freeze([
  { id: '1m', label: '1 min', ms: 60_000 },
  { id: '5m', label: '5 min', ms: 300_000 },
  { id: '15m', label: '15 min', ms: 900_000 },
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '4h', label: '4 hours', ms: 14_400_000 },
  { id: '1d', label: '1 day', ms: 86_400_000 },
]);

export const MARKETS = Object.freeze(
  [
    // Crypto (spot-style, USDT or USD quoted)
    'BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'ADA-USDT',
    'DOGE-USDT', 'AVAX-USDT', 'LINK-USDT', 'DOT-USDT', 'LTC-USDT',
    'ATOM-USDT', 'NEAR-USDT', 'BTC-USD', 'ETH-USD',
    // FX majors & metals (typical MT4 CFD symbols, e.g. EURUSD -> EUR-USD)
    'EUR-USD', 'GBP-USD', 'USD-JPY', 'AUD-USD', 'USD-CAD', 'XAU-USD', 'XAG-USD',
  ].map((symbol) => ({
    symbol,
    label: symbol.replace('-USDT', '/USDT').replace('-USD', '/USD').replace('-', '/'),
  }))
);

const TF_MS = new Map(TIMEFRAMES.map((t) => [t.id, t.ms]));

export function tfMs(tf) {
  const ms = TF_MS.get(tf);
  if (!ms) throw new Error(`Unsupported timeframe: ${tf}`);
  return ms;
}

export class DataBus {
  constructor(cfg = serverConfig) {
    this.mode = cfg.dataSource;
    this.okx = new OkxSource({ baseUrl: cfg.okxBaseUrl, timeoutMs: cfg.okxTimeoutMs });
    this.sample = new SampleSource();
    this.clientFeed = new ClientFeedStore();
    this.lastSource = null; // 'client' | 'okx' | 'sample'
  }

  describe(source, provider = null) {
    if (source === 'client') {
      return {
        source,
        provider,
        isSample: false,
        label: `LIVE (client feed) — ${provider} public market data relayed to the server (browser collector or MT4); updates while the feed is active`,
      };
    }
    if (source === 'okx') {
      return {
        source,
        isSample: false,
        label: 'LIVE — OKX public market data (read-only), fetched server-side',
      };
    }
    return {
      source: 'sample',
      isSample: true,
      label: 'SAMPLE DATA — deterministic simulated prices, not live market data',
    };
  }

  async resolveSource() {
    if (this.mode === 'sample') return 'sample';
    if (this.mode === 'okx') {
      const ok = await this.okx.isReachable();
      if (!ok) throw new Error('OKX market data is unreachable (DATA_SOURCE=okx)');
      return 'okx';
    }
    const ok = await this.okx.isReachable();
    const src = ok ? 'okx' : 'sample';
    if (src !== this.lastSource) {
      logSystem(`Server-side market data source: ${src === 'okx' ? 'OKX public API' : 'sample data (OKX unreachable)'}`);
      this.lastSource = src;
    }
    return src;
  }

  async candles(symbol, tf, limit = 300) {
    const ms = tfMs(tf);

    // 1. Fresh client-direct feed wins (feeder-validated + server-validated).
    if (this.mode !== 'sample') {
      const feed = this.clientFeed.get(symbol, tf, ms, { okxOnly: this.mode === 'okx' });
      if (feed) {
        return {
          symbol, tf,
          candles: feed.candles.slice(-limit),
          ...this.describe('client', feed.provider),
        };
      }
    }

    // 2. Server-side OKX public API.
    const source = await this.resolveSource();
    if (source === 'okx') {
      try {
        const candles = await this.okx.candles(symbol, ms, limit, tf);
        return { symbol, tf, candles, ...this.describe('okx') };
      } catch (err) {
        if (this.mode === 'okx') throw err;
        logSystem(`OKX request failed, falling back: ${err.message}`);
        this.okx.availableUntil = 0;
      }
    }

    // 3. Labelled sample data.
    return { symbol, tf, candles: this.sample.candles(symbol, ms, limit), ...this.describe('sample') };
  }

  async lastPrice(symbol, tf) {
    const ms = tfMs(tf);
    if (this.mode !== 'sample') {
      const feed = this.clientFeed.get(symbol, tf, ms, { okxOnly: this.mode === 'okx' });
      if (feed) {
        const lastCandle = feed.candles[feed.candles.length - 1];
        return { price: lastCandle.c, ...this.describe('client', feed.provider) };
      }
    }
    const source = await this.resolveSource();
    if (source === 'okx') {
      const p = await this.okx.lastPrice(symbol, ms, tf);
      if (p != null) return { price: p, ...this.describe('okx') };
    }
    return { price: this.sample.lastPrice(symbol, ms), ...this.describe('sample') };
  }
}
