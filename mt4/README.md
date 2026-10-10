# Candlebench ↔ MetaTrader 4 data feeder

`CandlebenchFeed.mq4` is a **read-only market-data feeder**. Running inside your
MT4 terminal, it pushes recent candle data for the chart it is attached to into
your Candlebench server, so the website charts, analyses and paper-trades that
market on your broker's live prices.

> **Read this first**
> - The EA is **strictly one-way market data** (MT4 → website). It places **no orders**,
>   reads no account data, and sends no credentials or balances.
> - Candlebench never sends trading instructions back to MT4. Candlebench is a
>   **paper-trading** app — it cannot place real-money orders anywhere.
> - Nothing here is financial advice.

---

## Setup

1. **Copy the EA** into your MT4 data folder:
   `File → Open Data Folder → MQL4 → Experts\` — put `CandlebenchFeed.mq4` there.
2. **Compile**: open MetaEditor (F4 in MT4), open the file, press **Compile** (F7).
   It targets MQL4 build 600+ and uses only standard functions.
3. **Whitelist the URL** (required for `WebRequest`):
   MT4 → `Tools → Options → Expert Advisors` → tick
   **"Allow WebRequest for listed URL"** and add the **host** of your ingest URL,
   e.g. `your-preview-host.e2b.app` (or `localhost` if the server runs on the same
   machine). The EA prints the exact host in the *Experts* log on start.
4. **Attach** the EA to any chart of the symbol you want to feed
   (M1, M5, M15, H1, H4 or D1). You do **not** need to enable AutoTrading —
   the EA only uses a timer and `WebRequest`.
5. Watch the *Experts* tab: every few seconds it logs
   `Candlebench: sent 300 bars of EURUSD @ 1m (HTTP 200)`.

Then open the website, search for the mapped market (e.g. **EUR/USD**) and select
it — the header badge should flip to **`DATA: LIVE — MT4 (client feed)`**.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `InpIngestUrl` | `http://localhost:3000/api/market/ingest` | Candlebench ingest endpoint. When using the hosted preview, replace host with your preview URL. |
| `InpPeriodSec` | `5` | Seconds between updates (min 2; the server rate-limits to 30 posts / 10 s). |
| `InpBars` | `300` | Candles per update (10–1000). |
| `InpAppSymbol` | *(empty)* | Override the target market. Leave empty to auto-map (below). |
| `InpProvider` | `MT4` | Label shown in the website UI/logs (e.g. `MT4-Demo`). |
| `InpUseChartTF` | `true` | Feed the chart's timeframe. |
| `InpTimeframe` | `M1` | Used when `InpUseChartTF=false`. |

## Symbol mapping

The EA auto-maps typical broker symbols (broker suffixes like `.a`, `m`, `-ecn`
are stripped):

| Broker symbol | Candlebench market |
|---|---|
| `EURUSD`, `GBPUSD`, `AUDUSD`, `USDCAD` | `EUR-USD`, `GBP-USD`, `AUD-USD`, `USD-CAD` |
| `USDJPY` | `USD-JPY` |
| `XAUUSD`, `XAGUSD` (gold, silver) | `XAU-USD`, `XAG-USD` |
| `BTCUSD`, `ETHUSD` (crypto CFDs) | `BTC-USD`, `ETH-USD` |

If your broker uses something else (e.g. `GLD`, `EU50`, `US30`), set
`InpAppSymbol` to one of the markets supported by the app
(`GET /api/meta` on the server lists them). Unsupported symbols are rejected by
the server with a clear message — nothing is invented.

## Broker timezones (handled)

MT4 timestamps bars in the **broker's server time** (often UTC+2/UTC+3). The EA
sends `"align":"lastBar"`, and the server re-anchors the most recent bar to the
current UTC bar boundary before accepting the batch. Bar spacing and OHLCV are
untouched; the applied shift is returned in the HTTP response and visible in
`GET /api/market/feed-status`. The website always labels MT4-fed markets as
`LIVE — MT4 (client feed)`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `WebRequest failed (error 4060)` / `-1` | The URL host is not whitelisted — repeat setup step 3. |
| `HTTP 400: Unknown market "..."` | Symbol not in the app list — set `InpAppSymbol`. |
| `HTTP 429` | Too many posts — raise `InpPeriodSec` (≥ 2 s, several charts each need their own margin). |
| `server replied HTTP 400: Rejected feed` | Candle data failed validation; check the *Experts* log for the specific reason. |
| Website stops updating | The feed goes stale when the EA stops posting (MT4 closed); the site then falls back to its labelled fallback data. |

## Feeding several symbols

Attach one EA copy per chart (one symbol/timeframe each). Keep
`InpPeriodSec ≥ 2` per chart; all feeds together must stay under the server's
30-posts-per-10-seconds rate limit (e.g. 5 charts × 5 s = 10 posts / 10 s — fine).

## Privacy & safety notes

- Sent payload: symbol name, timeframe, OHLCV candles, provider label. Nothing else.
- No API keys, no account numbers, no passwords. `WebRequest` is outbound HTTP only.
- To stop feeding: remove the EA from the chart (or close MT4). The website
  automatically stops using the stale feed and falls back — clearly labelled.
