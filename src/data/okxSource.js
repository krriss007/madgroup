// ---------------------------------------------------------------------------
// OKX exchange adapter - ISOLATED from the strategy and the paper engine.
//
// v1 scope (deliberately minimal and safe):
//   * PUBLIC market data only (candles), read-only, no authentication.
//   * No order placement of ANY kind exists in this codebase. The paper
//     engine never calls an exchange. A future order-execution adapter MUST
//     target OKX demo trading only (header `x-simulated-trading: 1`) and must
//     never request withdrawal permissions - see README.
//
// Endpoint reference (official docs): https://www.okx.com/docs-v5/en/
//   GET /api/v5/market/candles         latest candles (max 300)
//   GET /api/v5/market/history-candles older candles (paged, max 100/req)
// Candles return newest-first as [ts, o, h, l, c, vol, volCcy, volCcyQuote,
// confirm]; confirm === '1' means the candle is closed.
// ---------------------------------------------------------------------------
import { logSystem } from '../logger.js';

const TF_TO_OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };

export class OkxSource {
  constructor({ baseUrl, timeoutMs }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.availableUntil = 0; // availability cache (ms epoch)
    this.available = false;
  }

  barFor(tf) {
    const bar = TF_TO_OKX_BAR[tf];
    if (!bar) throw new Error(`Unsupported timeframe for OKX: ${tf}`);
    return bar;
  }

  async fetchJson(path, { signal } = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) throw new Error(`OKX HTTP ${res.status} for ${path}`);
    const body = await res.json();
    if (body.code !== '0') throw new Error(`OKX API error ${body.code}: ${body.msg || 'unknown'}`);
    return body.data;
  }

  /** Cheap public endpoint used to probe reachability. Cached for 60s. */
  async isReachable() {
    const now = Date.now();
    if (now < this.availableUntil) return this.available;
    try {
      await this.fetchJson('/api/v5/public/time', {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.available = true;
    } catch (err) {
      this.available = false;
      logSystem('OKX public API unreachable - sample data will be used', {
        reason: String(err && err.cause ? err.cause.code || err.message : err.message),
      });
    }
    this.availableUntil = now + 60_000;
    return this.available;
  }

  /** Map an OKX row to the app's candle shape. */
  static toCandle(row, tfMs) {
    const t = Number(row[0]);
    return {
      t,
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5]),
      complete: row[8] === '1' || t + tfMs <= Date.now(),
    };
  }

  /**
   * Fetch up to `limit` candles (oldest first, including the in-progress
   * candle). Pages through history-candles when limit > 300.
   */
  async candles(symbol, tfMs, limit, tf) {
    const bar = this.barFor(tf);
    const want = Math.min(Math.max(limit, 10), 1000);
    const rows = [];

    const recent = await this.fetchJson(
      `/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=${Math.min(want, 300)}`,
      { signal: AbortSignal.timeout(this.timeoutMs) }
    );
    rows.push(...recent);

    let guard = 0;
    while (rows.length < want && guard < 10) {
      guard++;
      const earliest = rows[rows.length - 1][0];
      const older = await this.fetchJson(
        `/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&after=${earliest}&limit=100`,
        { signal: AbortSignal.timeout(this.timeoutMs) }
      );
      if (!older.length) break;
      rows.push(...older);
      await new Promise((r) => setTimeout(r, 120)); // be polite to the API
    }

    const sliced = rows.slice(0, want);
    const candles = sliced.map((r) => OkxSource.toCandle(r, tfMs));
    candles.reverse(); // newest-first -> oldest-first
    return candles;
  }

  /** Latest traded price for mark-to-market of paper positions. */
  async lastPrice(symbol, tfMs, tf) {
    const candles = await this.candles(symbol, tfMs, 2, tf);
    return candles.length ? candles[candles.length - 1].c : null;
  }
}
