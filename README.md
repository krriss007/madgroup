# Candlebench — Paper-Trading Sandbox

An original, educational web app for **market analysis** and **simulated automated trading**.
It ships with a simple, fully explainable example strategy, a paper-trading engine with
fees/slippage estimates, and hard risk guardrails.

> ### ⚠️ Read this first
> - **Paper trading only.** This app **cannot place real-money orders** — not on OKX, not anywhere. Balances, fills and P/L are simulated.
> - **Signals are informational only.** The included strategy is a teaching example, **not a claim of profitability**.
> - **Simulated and backtested results are hypothetical.** They use simplified fee/slippage assumptions and **do not predict future returns**.
> - **Not financial advice.** Nothing in this repository is a recommendation to buy or sell anything.

---

## Features

- **Market search + watchlist** (watchlist persists in your browser's local storage)
- **Market & timeframe selectors** (1m → 1d) over a fixed educational market list
- **Candlestick chart** with EMA overlays, signal markers, entry/SL/TP lines and a data-source watermark
- **Analysis panel** showing the current signal, *which rules produced it* (pass/fail per rule), the rationale, and entry / stop-loss / take-profit levels
- **Portfolio card**: simulated cash, mark-to-market equity, today's P/L, daily-loss-limit usage, open positions with live unrealized P/L
- **Trade history table** with gross P/L, **estimated fees, estimated slippage**, and net P/L per trade
- **Backtest** of the same rules over recent closed candles — labelled **hypothetical**
- **Bot controls**: Start / Pause / Resume / Stop / **Emergency stop** / Reset, with a visible bot target and status
- **Activity log**: every signal, every simulated order, and every risk-limit decision
- Prominent **PAPER TRADING** badge, persistent risk banner, and footer disclaimer

## Tech stack (and why)

| Layer | Choice | Rationale |
|---|---|---|
| Server | **Node.js 20+ with Express** | One small runtime, one runtime dependency, easy to read top-to-bottom. The trading engine must live server-side so market access and future credentials never reach the browser. |
| Frontend | **Vanilla HTML/CSS/JS + a small canvas chart module** | No build step, no framework churn, nothing to transpile — the whole UI is auditable in three files. |
| Data | **Pluggable data bus**: browser-direct live feed → OKX public REST → deterministic sample data | Live prices work even when the server itself cannot reach exchanges (e.g. sandboxed hosting): the dashboard's browser fetches public, CORS-enabled exchange candles and relays them to the server, which validates and uses them while fresh. Clear labelling at every level. |
| Tests | **`node:test`** (built-in) | Zero extra dependencies for unit-testing indicators, strategy rules, risk gates and sample-data determinism. |
| Persistence | **Atomic JSON snapshot** in `./data` (gitignored) | Survives restarts without a database; a restart never auto-resumes the bot (it comes back **paused**). |

## Quick start

```bash
# requires Node.js >= 20
npm install
npm start            # → http://localhost:3000
```

Utilities:

```bash
npm run dev          # start with automatic restart on file changes
npm test             # unit tests (indicators, strategy, risk gates, sample data)
cp .env.example .env # optional: adjust PORT / HOST / DATA_SOURCE
```

On first load the app shows **SAMPLE DATA** unless the OKX public API is reachable — see
[Market data](#market-data) for exactly what that means.

## Market data

`DATA_SOURCE` controls the server-side resolution chain (`auto` by default):

| Mode | Behaviour |
|---|---|
| `auto` | **Client feed** (if fresh) → **OKX public REST** (if reachable) → **sample data**. |
| `okx` | Client feed restricted to the OKX provider → server-side OKX only; a clear error is shown if unreachable. |
| `sample` | Sample data only; client feeds are ignored. |

### Live data pipeline (client-direct)

Some hosting environments (including sandboxed previews) block server-side outbound access
to exchanges. Your **browser** is usually not restricted, so the dashboard ships a
client-direct collector (`public/liveFeed.js`):

1. The browser fetches public, CORS-enabled, **read-only candle endpoints** — no API keys,
   no credentials — trying providers in order: **OKX → Kraken → Binance → Binance.US**
   (the first that works is remembered).
2. It relays them to `POST /api/market/ingest`, where the server **validates everything**
   (row shape, strictly increasing timestamps, positive/OHLC-sane prices, size caps) before
   use.
3. The data bus prefers this feed **only while it stays fresh** (refreshed every few seconds
   by the open dashboard tab; staleness window 1–10 minutes). When the tab closes or the
   toggle is switched off, the app falls back to the server-side chain.

Every response and the UI say exactly where data came from:
`LIVE (client-direct) — <provider> … via your browser`, `LIVE — OKX … server-side`, or
`SAMPLE DATA — deterministic simulated prices`. The chart watermark and the header badge
match. There is a **"live feed via browser"** toggle in the chart header (persisted per
browser).

Honesty notes: client-direct data updates only while a dashboard tab is open; providers
serve public candle snapshots (polling, not streaming); if your browser's network blocks
all providers (VPN/geo/firewall), the app keeps working on clearly-labelled data instead
of inventing prices.

- **Sample data** is generated by a *seeded, deterministic* random walk (anchored to a fixed
  epoch, reproducible across restarts). Prices are **not real** and every API response and the
  UI label it: `SAMPLE DATA — deterministic simulated prices, not live market data`, with a
  watermark over the chart. The app **never presents simulated prices as live**.
- When OKX *is* reachable, candles are real public market data (labelled `OKX PUBLIC — read-only`),
  but trading remains 100% paper.

### OKX notes (important)

- The bundled adapter (`src/data/okxSource.js`) performs **public, read-only market-data
  requests only**. It is kept **strictly separate** from the strategy and the paper engine
  (see `src/data/databus.js` for the boundary).
- **v1 implements no order placement of any kind.** There is no code path — demo or live —
  that sends orders to OKX.
- If you later add a demo-trading adapter, it must follow the current official OKX API docs,
  use the **demo-trading environment only** (`x-simulated-trading: 1` header), **never request
  withdrawal permissions**, and keep keys server-side only. Placeholder env vars are listed in
  `.env.example` but are **not read by the current code**.
- The current OKX endpoints used are documented at <https://www.okx.com/docs-v5/en/>:
  `GET /api/v5/market/candles`, `GET /api/v5/market/history-candles`, `GET /api/v5/public/time`.

## The example strategy — "TriTrend"

Evaluated **once per closed candle** of the bot's target market/timeframe (no lookahead, no
repainting). Every evaluation is logged with the indicator values that produced it.

**Long entry — all three must hold on the last closed candle:**

1. **Trigger** — fast EMA (default 12) crosses **above** slow EMA (default 26) on this candle.
2. **Momentum filter** — RSI (default 14) is between **50 and the overbought bound (default 70)**:
   rising momentum, but not overextended.
3. **Sizing the exits** — stop-loss = entry − `1.5 × ATR(14)`; take-profit = entry + `2.0 × ATR(14)`
   (both multipliers configurable).

**Exits:** take-profit, stop-loss, or an opposite EMA crossover. Short entries are opt-in
(`allowShorts`) and default **off** — long-only keeps the example easier to reason about.

The analysis panel shows each rule with ✓/✗, the exact indicator numbers, the rationale in
plain language, and the proposed levels. The same rules power the backtester.

### Strategy limitations (why you should not trade it for real)

- **Trend-following lag:** EMA crossovers are late by construction; in range-bound markets they
  whipsaw repeatedly (small losses accumulate — visible in the sample backtest's win rate).
- **Crude filters:** a fixed 50/70 RSI band and fixed ATR multiples ignore regime, volume,
  liquidity and correlation.
- **No market microstructure:** fills are assumed at last price ± fixed bps; real execution
  faces spread, depth, partial fills, funding/borrow costs and outages.
- **Backtest naivety:** if a candle touches both SL and TP, the backtest conservatively assumes
  **the stop filled first**; intrabar path is otherwise unknown.
- **Single-market, single-timeframe** by design; no portfolio risk model.
- All numbers shown are from **simulated or clearly-labelled data**; past behaviour of a rule —
  real or simulated — **does not predict future returns**.

## Risk safeguards (all enforced server-side, all logged)

| Safeguard | Default | Notes |
|---|---|---|
| Position size | 10% of equity | Clamped 0.5–100%, computed at entry |
| Max open positions | 3 | Entries blocked at the cap |
| Daily loss limit | 5% of day-start equity | Entries halt for the rest of the UTC day (0 = off) |
| Cooldown after a loss | 300s | No new entries for N seconds after a losing trade (0 = off) |
| Duplicate-order prevention | always on | One position per symbol + one evaluation per closed candle + idempotent ticks |
| Emergency stop | button | Force-closes all paper positions, halts the bot; only **Reset** clears it |
| Fees & slippage | 10 bps / 5 bps | Applied to every simulated fill and reported per trade |

## Security model

- **No secrets exist in the browser.** All configuration is read server-side from environment
  variables (`.env`, gitignored). The frontend contains no keys, tokens, or credentials.
- **No credentials are read at all in v1** because no exchange writes are implemented; the
  OKX adapter uses only public endpoints.
- **Same-origin API** — no CORS headers are emitted; browsers on other origins cannot call it.
- **Input validation everywhere**: symbols/timeframes are whitelist-checked, numbers are
  range-clamped, body size is capped, unknown endpoints return JSON 404s, errors are JSON with
  clear messages.
- **Logs never contain secrets**; a `redact()` helper exists in the logger for any future code
  that touches credentials.
- **Not hardened for public exposure.** This is a local/educational tool — put it behind a
  reverse proxy with auth if you ever run it beyond localhost.

## Architecture

```
src/
  server.js           HTTP API + static hosting + input validation
  engine.js           paper-trading engine (signals → risk gates → simulated fills)
  strategy.js         the TriTrend example rules + rationale builder
  risk.js             pure entry gates (kill switch, caps, cooldown, duplicates…)
  backtest.js         bar-by-bar hypothetical backtester (SL-first tie rule)
  indicators.js       EMA / RSI / ATR (pure functions)
  logger.js           ring-buffer event log (SIGNAL / ORDER / RISK / SYSTEM / ERROR)
  store.js            atomic JSON state snapshot
  config.js           env config + engine defaults + clamping limits
  data/
    databus.js        source resolution (client feed | okx | sample) — the only data entry point
    clientFeed.js     validated store for browser-relayed live candles
    okxSource.js      OKX public REST adapter (isolated; no trading calls)
    sampleSource.js   deterministic seeded sample-candle generator
public/
  index.html / styles.css / app.js / chart.js / liveFeed.js   (no build step)
test/                 node:test unit tests
```

## API overview

| Endpoint | Purpose |
|---|---|
| `GET /api/health`, `GET /api/meta` | liveness; markets, timeframes, defaults |
| `GET /api/candles?symbol=&tf=&limit=` | candles + data-source label |
| `GET /api/analysis?symbol=&tf=` | latest evaluation, rules, levels, recent signals |
| `POST /api/market/ingest` `{symbol, tf, provider, candles}` | validated relay for browser-fetched public candles |
| `GET /api/market/feed-status` | which client feeds are stored and fresh |
| `GET /api/state` | portfolio, positions, trades, bot status, risk state |
| `POST /api/bot/start·pause·resume·stop·kill·reset` | bot lifecycle (`start` takes `{symbol, tf}`) |
| `POST /api/config` | validated config updates (returns applied + rejected keys) |
| `POST /api/positions/close` `{id}` | manual close of one paper position |
| `POST /api/backtest` `{symbol, tf, bars}` | hypothetical backtest + equity curve |
| `GET /api/logs?after=&type=&limit=` | event log (signals, orders, risk decisions) |

## Configuration

Server env (see `.env.example`): `PORT`, `HOST`, `DATA_SOURCE`, `OKX_BASE_URL`,
`OKX_TIMEOUT_MS`, `DATA_DIR`. Engine parameters (position size, caps, fees, strategy periods…)
are tuned live in the UI and validated/clamped server-side; defaults live in `src/config.js`.

The simulated state snapshot is stored under `DATA_DIR` (default `./data`, **gitignored**).

## Development

```bash
npm test        # 36 unit tests
npm run dev     # node --watch
```

The sample-data generator is unit-tested for determinism (same seed → identical bars), so the
simulator behaves identically across restarts.

## License

MIT — see `LICENSE`.

---

**Reminder:** Candlebench is an educational simulator. Signals are informational only, simulated
and backtested results are hypothetical and do not predict future returns, and nothing here is
financial advice. No real-money trading is supported.
