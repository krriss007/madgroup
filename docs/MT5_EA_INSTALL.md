# TradePilot — MT5 Expert Advisor installation guide

This is the guide for connecting **your own MetaTrader 5 terminal** to TradePilot so
that the dashboard shows *your real broker data* and can place *real orders*.

Read this first:

> **TradePilot never asks for, transmits or stores your MT5 password, investor
> password, broker login or server name.** Those credentials stay inside your MT5
> terminal, on your own machine/VPS, exactly as they are today. The EA you install
> does not authenticate to your broker — it talks to the terminal you are already
> logged into, and it authenticates to *your* TradePilot backend with a
> TradePilot-issued **device token**. If any page or message ever asks you for an
> MT5 password, it is not TradePilot.

Until an EA is installed and CONNECTED, LIVE mode shows
`MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE` and refuses live orders. That is
correct behaviour, not a bug: TradePilot never invents a live price.

---

## 1. What you need

| Component | Where it runs | Notes |
|---|---|---|
| MetaTrader 5 terminal, logged into your broker account | Windows (your PC or a Windows VPS) | The EA runs inside the terminal. MT5 must be running for live data to flow. |
| TradePilot backend API | Any host reachable over HTTPS from the MT5 machine | `https://YOUR-BACKEND-HOST` |
| TradePilot web dashboard | Vercel / any static+node host | Talks only to the backend |
| `TradePilotBridge.mq5` + `Include/TradePilot/*.mq5` | Inside the MT5 data folder | Download from **Settings → MT5 Connection** |

Recommended: a **Windows VPS** (any region near your broker's servers) so the
terminal and the EA stay online while the dashboard is used from a browser.

---

## 2. Start your TradePilot backend (once)

The backend is the only component that holds secrets. It needs at least:

```bash
# backend/.env  (never commit this file)
NODE_ENV=production
PORT=8080
HOST=0.0.0.0
SESSION_SECRET=<64 random chars>      # session cookies
BRIDGE_SECRET=<64 random chars>       # signs commands sent to the EA
DATABASE_URL=postgresql://user:pass@host:5432/tradepilot
DEMO_AUTO_LOGIN=false                 # demo convenience must be OFF in production
```

Generate the secrets with `openssl rand -hex 32`. `BRIDGE_SECRET` is what proves
to the EA that a command came from your backend: **change it and every EA
reconnects with a fresh token** (see §6). Full list: `backend/.env.example`.

Two requirements for the bridge to be reachable:

1. **HTTPS** — the EA refuses plain `http://` unless you allow it explicitly for
   local testing. Browsers and MT5 both behave better with a real certificate
   (Caddy/nginx + Let's Encrypt is fine).
2. **`POST /api/v1/bridge/*` must be exposed** to the MT5 machine. Nothing else
   needs to be public. Do not put the bridge behind a path that strips custom
   headers — the EA sends `x-tradepilot-device` and `x-tradepilot-token`.

---

## 3. Download the EA matching your backend

In the dashboard: **Settings → MT5 Connection → Download EA**
(`/mt5/TradePilotBridge.mq5`), plus the support headers
(`/mt5/include/TradePilot/*.mq5`). The page also links this guide as
`/mt5/README.md`.

Copy the files into your MT5 **data folder** (in MT5: *File → Open Data Folder*):

```
<MT5 data folder>/
  MQL5/
    Experts/
      TradePilotBridge.mq5
    Include/
      TradePilot/
        TP_Sha256.mq5
        TP_Json.mq5
        TP_Http.mq5
        TP_Symbols.mq5
        TP_Trade.mq5
        TP_Protocol.mq5
```

The include layout matters: the EA does
`#include <TradePilot/TP_Protocol.mq5>` and expects the folder to be named
`TradePilot` with that exact capitalisation.

---

## 4. Compile the EA

1. Open **MetaEditor** (F4 in MT5) → open `Experts/TradePilotBridge.mq5`.
2. Press **F7** (Compile). Expect `0 errors, 0 warnings`; the includes compile
   with the EA.
3. The compiled `TradePilotBridge.ex5` appears next to the source.

Then in MT5: **View → Navigator → Expert Advisors → TradePilotBridge** and drag it
onto *any* chart (a small one such as `XAUUSD M1` is ideal — the EA reports every
symbol on the account, it does not depend on the chart it sits on).

Enable **Algo Trading** in the MT5 toolbar — with it off, the EA reports data but
the terminal will reject every execution command.

---

## 5. Create a device token and configure the EA

In the dashboard: **Settings → MT5 Connection → Generate device token**.

* The token looks like `tpd_0Nc3u752J7tJ_<secret>` and is **shown exactly once**.
* It is stored server-side as `sha256(secret)` — nobody, including TradePilot
  administrators, can read it back. Lost it? Revoke and generate another.
* Up to 5 devices per account; revoke any of them at any time (the EA goes
  to DISCONNECTED within one heartbeat, ~10 s).

Paste it into the EA inputs (`F7` on the chart, or *Inputs* tab when attaching):

| Input | Value | Why |
|---|---|---|
| `InpBackendUrl` | `https://your-backend-host` | Where commands are polled from. |
| `InpDeviceToken` | `tpd_…` | Authenticates *this* terminal to *your* backend. |
| `InpHeartbeatSeconds` | `3` | 2–5 s keeps status CONNECTED (timeout is 10 s). |
| `InpEnableTrading` | `true` | `false` = reporting only, execution refused. Use it to watch data first. |
| `InpMagicNumber` | `700200` | Tags TradePilot live orders so they are identifiable in MT5. |
| `InpDeviationPoints` | `20` | Max slippage accepted on market orders. |
| `InpManageOnlyOwnMagic` | `false` | When `true`, "close all" only touches TradePilot positions. |
| `InpVerboseLog` | `false` | Turn on while troubleshooting. |

Click **OK**, then check the *Experts* tab of the MT5 toolbox. Within a few
seconds you should see a heartbeat line and, in the dashboard, the top bar
switches to **MT5 CONNECTED**.

## 6. Verify

* **Top bar** → **MT5 CONNECTED**, plus balance / equity / free margin / margin
  level straight from your account.
* **Settings → MT5 Connection** → account login, broker server, EA version,
  latency, last heartbeat (`GET /api/v1/settings/mt5/status`).
* **Markets / Watchlist** → 11 default symbols with real Bid/Ask/Spread from your
  broker, `source: MT5`. Symbol names are matched to your broker's suffixes
  (`XAUUSD`, `XAUUSDm`, `XAUUSD.`, `XAUUSDpro`, …) — nothing about contract size,
  tick value, digits or stops level is hardcoded; the EA pushes each symbol's
  specification as your broker reports it.
* **Order panel** → lot-size calculator now uses your broker's
  `volume_min/max/step`, contract size, tick size and tick value.

## 7. Enable LIVE trading (deliberate, one-time)

LIVE is off until **all** of these are true:

1. an EA is connected and healthy (§6);
2. the account is authorised for live trading in TradePilot;
3. global risk limits are configured (max risk/trade, max daily loss, max open
   positions, max lot size) — see **Settings → Risk**;
4. you explicitly enable live trading and accept the risk warning.

Learn the live flow before you trust it:

1. **DEMO first.** Everything in this guide works identically in DEMO mode with
   simulated prices. Practise the sequence: XAUUSD → lot size → SL/TP → BUY →
   confirm → position appears → modify SL/TP → close → history updates.
2. **Micro-lot live test.** Enable LIVE, set the risk limits low, place one 0.01
   lot order on a demo/practice account of your broker, confirm it appears in MT5,
   then close it from the dashboard.
3. Only then trade a funded account.

Every live order shows a confirmation that says **"THIS ORDER WILL USE REAL
MONEY."**, and a permanent 🔴 **LIVE TRADING** indicator stays visible while live
trading is enabled. Every live command is written to an append-only audit log
(`GET /api/v1/audit?mode=LIVE`) with the request, the risk checks, the EA result
and the resulting ticket. The **CLOSE ALL POSITIONS** emergency button requires
typing `CONFIRM CLOSE ALL`.

## 8. Safety model (what actually protects you)

* The browser never receives broker credentials, the device token, or anything
  that could execute an order on its own — the dashboard talks to the backend,
  the backend talks to the EA, the EA talks to the terminal.
* Every command is **signed** (HMAC-SHA256 over the canonical command payload with
  `BRIDGE_SECRET`), carries a timestamp, a nonce and an idempotency key; the EA
  rejects replays, stale timestamps (default 180 s tolerance) and tampered
  payloads.
* The backend re-validates every order immediately before sending it, and the EA
  re-validates against the *live* terminal state right before executing:
  symbol exists, volume within `volume_min/max/step`, `SYMBOL_TRADE_STOPS_LEVEL`
  respected, market open, terminal accepting, Algo Trading enabled.
* Daily-loss lock (`DAILY LOSS LIMIT REACHED — TRADING LOCKED`), max-open-positions
  cap, max-lot cap and risk-per-trade cap are enforced server-side.
* If the EA stops heartbeating, live execution **fails closed**
  (`MT5_NOT_AUTHORIZED`) and the dashboard disables the live buttons.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard stays DISCONNECTED | Check the *Experts* tab for HTTP errors. Wrong `InpBackendUrl` (must be `https://host`, no trailing slash), firewall, or the token was revoked. |
| `401` from the bridge | Device token typo or revoked → generate a new token (§5). |
| `COMMAND_TIMEOUT` / order stays pending | MT5 not running, EA not attached, **Algo Trading** off, or the chart's terminal is busy. Orders fail safely; nothing is sent twice. |
| `SIGNATURE_INVALID` | `BRIDGE_SECRET` changed on the backend after the token was issued → reissue the token, re-paste it. Also check the VPS clock (NTP) — skewed clocks break timestamp checks. |
| `STOPS_LEVEL_VIOLATION` | SL/TP too close to price for your broker; the dashboard shows the minimum distance. |
| `INVALID_VOLUME` | Volume outside your broker's min/max/step. |
| `TRADE_DISABLED` | Terminal in read-only/login-only state, or Algo Trading off. |
| Prices look frozen | Market closed (weekend/rollover) or the symbol is hidden in Market Watch (the EA enables it automatically once connected). |

## 10. Testing the pipeline without a broker

If you want to exercise the whole LIVE path (quotes, orders, modify, close,
history, audit) **without** a real broker account, the repository ships a
deliberately synthetic test double:

```bash
node scripts/mt5-bridge-simulator.mjs --token tpd_… --url http://127.0.0.1:8080
```

It speaks the exact EA protocol (same endpoints, headers, signatures, payloads)
and pushes **clearly labelled synthetic prices at absurd levels** so nobody can
mistake them for a market. It is a development tool: never present its numbers as
real, and never use it with a funded configuration. Real live data always
requires the EA in §3–§6 on your own terminal.

---

*TradePilot is original software: the EA, the protocol and the dashboard were
written for this project and contain no third-party broker code. Nothing in this
guide requires you to share credentials with anyone.*
