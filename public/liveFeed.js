// ---------------------------------------------------------------------------
// Browser-side live-data collector (client-direct mode).
//
// Fetches PUBLIC, CORS-enabled exchange market-data endpoints directly from
// the user's browser — no API keys, no credentials, read-only candle data —
// and hands them to the app, which relays them to the Candlebench server.
// This exists because some hosting sandboxes block server-side outbound
// access to exchanges; browsers are usually not restricted.
//
// Providers are tried in order and the first working one is remembered
// ("sticky"). All parsers return [t,o,h,l,c,v] rows, oldest first.
// If nothing is reachable, collectLive() returns null and the app keeps
// running on its clearly-labelled server-side data.
// ---------------------------------------------------------------------------

const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const KRAKEN_MIN = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

async function fetchJson(url, timeoutMs = 9000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Sort ascending, drop malformed rows, deduplicate by timestamp. */
function prep(rows) {
  const map = new Map();
  for (const r of rows) {
    const n = r.map(Number);
    if (n.length < 6 || n.some((x) => !Number.isFinite(x))) continue;
    if (n[1] <= 0 || n[2] <= 0 || n[3] <= 0 || n[4] <= 0) continue;
    map.set(n[0], n.slice(0, 6));
  }
  return [...map.keys()].sort((a, b) => a - b).map((t) => map.get(t));
}

const providers = [
  {
    name: 'OKX',
    async fetch(symbol, tf) {
      const url = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=${OKX_BAR[tf]}&limit=300`;
      const j = await fetchJson(url);
      if (j.code !== '0' || !Array.isArray(j.data)) throw new Error(j.msg || 'unexpected OKX payload');
      // OKX rows: newest-first [ts, o, h, l, c, vol, ...]
      return prep(j.data.map((r) => [+r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]).reverse());
    },
  },
  {
    name: 'Kraken',
    async fetch(symbol, tf) {
      const pair = symbol.replace('BTC-', 'XBT-').replace('-', ''); // BTC-USDT -> XBTUSDT
      const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${KRAKEN_MIN[tf]}`;
      const j = await fetchJson(url);
      if (Array.isArray(j.error) && j.error.length) throw new Error(j.error[0]);
      const key = Object.keys(j.result || {}).find((k) => k !== 'last');
      const rows = key ? j.result[key] : null;
      if (!Array.isArray(rows)) throw new Error('unexpected Kraken payload');
      // Kraken rows: [timeSec, open, high, low, close, vwap, volume, count]
      return prep(rows.map((r) => [r[0] * 1000, +r[1], +r[2], +r[3], +r[4], +r[6]]));
    },
  },
  {
    name: 'Binance',
    async fetch(symbol, tf) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.replace('-', '')}&interval=${tf}&limit=300`;
      const rows = await fetchJson(url);
      if (!Array.isArray(rows)) throw new Error('unexpected Binance payload');
      // Binance rows: [openTime, o, h, l, c, v, ...] (numbers as strings)
      return prep(rows.map((r) => [+r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]));
    },
  },
  {
    name: 'Binance.US',
    async fetch(symbol, tf) {
      const url = `https://api.binance.us/api/v3/klines?symbol=${symbol.replace('-', '')}&interval=${tf}&limit=300`;
      const rows = await fetchJson(url);
      if (!Array.isArray(rows)) throw new Error('unexpected Binance.US payload');
      return prep(rows.map((r) => [+r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]));
    },
  },
];

let stickyProvider = null;

/**
 * Try providers until one returns usable candles.
 * @returns {provider: string, candles: number[][]} | null
 */
export async function collectLive(symbol, tf) {
  const ordered = stickyProvider
    ? [...providers.filter((p) => p.name === stickyProvider), ...providers.filter((p) => p.name !== stickyProvider)]
    : providers;
  for (const p of ordered) {
    try {
      const candles = await p.fetch(symbol, tf);
      if (candles.length >= 30) {
        stickyProvider = p.name;
        return { provider: p.name, candles };
      }
    } catch {
      if (stickyProvider === p.name) stickyProvider = null;
    }
  }
  return null;
}

export function activeProviderName() {
  return stickyProvider;
}
