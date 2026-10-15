// ---------------------------------------------------------------------------
// Client-direct live feed store.
//
// Feeders: the dashboard's browser collector (public/liveFeed.js) and the MT4
// Expert Advisor (mt4/CandlebenchFeed.mq4). Both push public, read-only candle
// data to the server's ingest endpoint. This store VALIDATES everything
// strictly before use and labels it with its provider.
//
// Freshness rules: a feed is used only while it is being actively refreshed
// by its feeder (see freshWindowMs). Otherwise the data bus falls back to its
// server-side chain (OKX public -> labelled sample data).
// ---------------------------------------------------------------------------
import { logSystem } from '../logger.js';

/**
 * Validate relayed candle rows. `rows` must be [t,o,h,l,c,v] numeric arrays,
 * strictly ascending in time, OHLC-sane, size-capped. Returns {candles} or
 * {error} with a specific message.
 */
export function validateCandleRows(rows, tfMs, now = Date.now()) {
  if (!Array.isArray(rows) || rows.length < 10 || rows.length > 1000) {
    return { error: 'candles must be an array of 10..1000 [t,o,h,l,c,v] rows' };
  }
  const out = [];
  let prevT = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length < 6) return { error: `row ${i}: expected [t,o,h,l,c,v]` };
    const t = Number(r[0]);
    const o = Number(r[1]);
    const h = Number(r[2]);
    const l = Number(r[3]);
    const c = Number(r[4]);
    const v = Number(r[5]);
    if (![t, o, h, l, c, v].every(Number.isFinite)) return { error: `row ${i}: non-finite value` };
    if (t <= prevT) return { error: `row ${i}: timestamps must strictly increase` };
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return { error: `row ${i}: prices must be positive` };
    // 0.1% tolerance for feed quirks, then hard OHLC sanity.
    if (h < Math.max(o, c) * 0.999 || l > Math.min(o, c) * 1.001) {
      return { error: `row ${i}: OHLC inconsistent` };
    }
    if (v < 0) return { error: `row ${i}: negative volume` };
    prevT = t;
    out.push({ t, o, h, l, c, v, complete: t + tfMs <= now });
  }
  if (out[out.length - 1].t > now + 5 * 60_000) return { error: 'last candle is in the future' };
  if (now - out[0].t > 400 * 86_400_000) return { error: 'oldest candle is too old' };
  return { candles: out };
}

/**
 * MT4 brokers anchor bar timestamps to their own server clock (often UTC+2/+3),
 * not true UTC. This re-anchors a batch so its most recent bar starts exactly
 * at the current (server-clock) bar boundary. Bar spacing and OHLCV are left
 * untouched; the applied shift is returned so it can be logged and shown.
 * Only used when the feeder explicitly asks for it (the MT4 EA does).
 */
export function alignRowsToLastBar(rows, tfMs, now = Date.now()) {
  if (!Array.isArray(rows) || !rows.length) return { error: 'nothing to align' };
  const last = rows[rows.length - 1];
  if (!Array.isArray(last) || !Number.isFinite(Number(last[0]))) return { error: 'bad last row' };
  const target = Math.floor(now / tfMs) * tfMs;
  const offset = target - Number(last[0]);
  if (Math.abs(offset) > 48 * 3_600_000) return { error: 'feed timestamps are too far from the server clock' };
  if (offset === 0) return { rows, offsetSec: 0 };
  return {
    rows: rows.map((r) => (Array.isArray(r) ? [Number(r[0]) + offset, r[1], r[2], r[3], r[4], r[5]] : r)),
    offsetSec: Math.round(offset / 1000),
  };
}

export class ClientFeedStore {
  constructor() {
    this.feeds = new Map(); // "symbol|tf" -> {candles, provider, receivedAt, tfMs}
  }

  /** A feed is trusted only while actively refreshed by its feeder. */
  static freshWindowMs(tfMs) {
    return Math.min(Math.max(2 * tfMs, 60_000), 600_000); // 1min..10min
  }

  ingest(symbol, tf, tfMs, rows, provider, now = Date.now()) {
    if (typeof provider !== 'string' || !provider.trim() || provider.length > 40) {
      return { error: 'invalid provider label' };
    }
    const check = validateCandleRows(rows, tfMs, now);
    if (check.error) return check;
    const key = `${symbol}|${tf}`;
    const prev = this.feeds.get(key);
    if (!prev || prev.provider !== provider) {
      logSystem(
        `Live client feed ${prev ? 'provider switched to' : 'active'}: ${provider} — ${symbol} @ ${tf} (${check.candles.length} bars relayed)`
      );
    }
    this.feeds.set(key, {
      symbol,
      tf,
      tfMs,
      candles: check.candles,
      provider: provider.trim(),
      receivedAt: now,
    });
    return { ok: true, bars: check.candles.length };
  }

  get(symbol, tf, tfMs, { okxOnly = false, now = Date.now() } = {}) {
    const feed = this.feeds.get(`${symbol}|${tf}`);
    if (!feed) return null;
    if (okxOnly && feed.provider !== 'OKX') return null;
    const windowMs = ClientFeedStore.freshWindowMs(tfMs);
    if (now - feed.receivedAt > windowMs) return null; // feeder stopped/stalled
    const lastT = feed.candles[feed.candles.length - 1].t;
    if (now - lastT > windowMs + tfMs) return null; // stale candles
    return feed;
  }

  status() {
    const now = Date.now();
    const out = [];
    for (const [key, f] of this.feeds) {
      out.push({
        key,
        provider: f.provider,
        bars: f.candles.length,
        receivedAt: f.receivedAt,
        fresh: now - f.receivedAt <= ClientFeedStore.freshWindowMs(f.tfMs),
      });
    }
    return out;
  }
}
