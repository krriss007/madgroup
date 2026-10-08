#!/usr/bin/env node
/**
 * TradePilot — MT5 bridge SIMULATOR (test double, not a market data source).
 *
 *   ⚠  This program does NOT connect to any broker and does NOT provide real
 *      prices. It answers the TradePilot bridge protocol the same way
 *      `mt5/TradePilotBridge.mq5` does, using deliberately absurd price levels
 *      (gOLD at 9999.00, FX at 9.9999 …) and a symbol description that says
 *      "SIMULATED FEED", so a simulated feed can never be mistaken for a real
 *      one. Use it to exercise the LIVE plumbing end to end — device token,
 *      heartbeat, live quotes, signed commands, order execution, position and
 *      history sync — before your Windows VPS with MetaTrader 5 is ready.
 *
 *   For real live data, install the EA on an MT5 terminal connected to your own
 *   broker account: docs/MT5_EA_INSTALL.md.
 *
 * Usage:
 *   node scripts/mt5-bridge-simulator.mjs --token tpd_<deviceId>_<secret> \
 *        [--url http://127.0.0.1:8099] [--balance 100000] [--login 55512345] \
 *        [--server "Simulated-Server"] [--verbose]
 *
 * The device token is created in TradePilot → Settings → MT5 Connection and is
 * shown exactly once. Nothing else is needed: no password, no broker login.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const verbose = args.includes('--verbose');

const backendUrl = (flag('url', process.env.BACKEND_URL ?? 'http://127.0.0.1:8099')).replace(/\/$/, '');
const rawToken = flag('token', process.env.TRADEPILOT_DEVICE_TOKEN ?? '');
const accountLogin = Number(flag('login', '55512345'));
const accountServer = flag('server', 'TradePilot-Simulated-Server');
const startingBalance = Number(flag('balance', '100000'));
const accountCurrency = flag('currency', 'USD');
const accountLeverage = Number(flag('leverage', '100'));
const heartbeatMs = Number(flag('heartbeat-ms', '3000'));
const tickMs = Number(flag('tick-ms', '1000'));
const pollMs = Number(flag('poll-ms', '1200'));
const syncMs = Number(flag('sync-ms', '4000'));

if (!rawToken.startsWith('tpd_')) {
  console.error(
    [
      '',
      '  A TradePilot device token is required (it looks like tpd_<deviceId>_<secret>).',
      '  Create one in TradePilot → Settings → MT5 Connection, then run:',
      '',
      '    node scripts/mt5-bridge-simulator.mjs --token tpd_…',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const parts = rawToken.split('_');
const deviceId = parts[1];
const deviceSecret = parts.slice(2).join('_');

/* ------------------------------------------------------------------ */
/* the simulated "broker"                                              */
/* ------------------------------------------------------------------ */

/** Prefix makes every simulated quote unmistakable in the terminal UI. */
const SIM = 'SIMULATED FEED — not a broker price';

const SYMBOLS = {
  XAUUSD: { price: 9999.0, spread: 0.5, digits: 2, contract: 100, base: 'XAU', quote: 'USD', description: 'Gold / US Dollar (SIMULATED FEED)' },
  EURUSD: { price: 9.9999, spread: 0.0002, digits: 5, contract: 100000, base: 'EUR', quote: 'USD', description: 'Euro / US Dollar (SIMULATED FEED)' },
  GBPUSD: { price: 8.8888, spread: 0.0003, digits: 5, contract: 100000, base: 'GBP', quote: 'USD', description: 'Pound / US Dollar (SIMULATED FEED)' },
  USDJPY: { price: 777.77, spread: 0.03, digits: 3, contract: 100000, base: 'USD', quote: 'JPY', description: 'US Dollar / Yen (SIMULATED FEED)' },
  AUDUSD: { price: 7.7777, spread: 0.0003, digits: 5, contract: 100000, base: 'AUD', quote: 'USD', description: 'Aussie / US Dollar (SIMULATED FEED)' },
  USDCAD: { price: 6.6666, spread: 0.0003, digits: 5, contract: 100000, base: 'USD', quote: 'CAD', description: 'US Dollar / Loonie (SIMULATED FEED)' },
  NZDUSD: { price: 5.5555, spread: 0.0004, digits: 5, contract: 100000, base: 'NZD', quote: 'USD', description: 'Kiwi / US Dollar (SIMULATED FEED)' },
  USDCHF: { price: 4.4444, spread: 0.0003, digits: 5, contract: 100000, base: 'USD', quote: 'CHF', description: 'US Dollar / Franc (SIMULATED FEED)' },
  EURGBP: { price: 3.3333, spread: 0.0003, digits: 5, contract: 100000, base: 'EUR', quote: 'GBP', description: 'Euro / Pound (SIMULATED FEED)' },
  EURJPY: { price: 2.2222, spread: 0.03, digits: 3, contract: 100000, base: 'EUR', quote: 'JPY', description: 'Euro / Yen (SIMULATED FEED)' },
  GBPJPY: { price: 1.1111, spread: 0.04, digits: 3, contract: 100000, base: 'GBP', quote: 'JPY', description: 'Pound / Yen (SIMULATED FEED)' },
};

const state = {
  balance: startingBalance,
  positions: new Map(),
  orders: new Map(),
  deals: [],
  executedCommandIds: new Set(),
  seenNonces: new Set(),
  sequence: 0,
  nextTicket: Math.floor(Date.now() / 1000) % 1_000_000_000,
  lastHeartbeatAck: null,
  ticksReceived: 0,
  commandsExecuted: 0,
  commandsRefused: 0,
};

const nowMs = () => Date.now();
const iso = (ms = nowMs()) => new Date(ms).toISOString();
const round = (value, digits) => Number(value.toFixed(digits));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextTicket = () => ++state.nextTicket;

function price(symbol) {
  const spec = SYMBOLS[symbol];
  if (!spec) return null;
  // Deterministic gentle drift keeps the UI visibly live without pretending to
  // be a market: ±0.15% around the configured level.
  const phase = (nowMs() % 60_000) / 60_000;
  const drift = Math.sin(phase * Math.PI * 2) * spec.price * 0.0015;
  const mid = spec.price + drift;
  return { bid: round(mid - spec.spread / 2, spec.digits), ask: round(mid + spec.spread / 2, spec.digits) };
}

function profitOf(position) {
  const spec = SYMBOLS[position.symbol];
  if (!spec) return 0;
  const quote = price(position.symbol);
  const current = position.type === 0 ? quote.bid : quote.ask;
  const direction = position.type === 0 ? 1 : -1;
  let value = (current - position.open_price) * direction * position.volume * spec.contract;
  if (spec.quote === 'JPY') value /= current; // crude conversion, simulator only
  return Number(value.toFixed(2));
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

const headers = {
  'content-type': 'application/json',
  accept: 'application/json',
  'x-tradepilot-device': deviceId,
  'x-tradepilot-token': rawToken,
  'x-tradepilot-protocol': '1.0.0',
};

async function post(path, payload) {
  state.sequence += 1;
  const body = JSON.stringify({
    device_id: deviceId,
    device_token: rawToken,
    protocol_version: '1.0.0',
    sent_at: iso(),
    sequence: state.sequence,
    payload,
  });
  try {
    const response = await fetch(`${backendUrl}${path}`, { method: 'POST', headers, body });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    if (!response.ok) {
      log(`POST ${path} → ${response.status} ${text.slice(0, 180)}`, 'warn');
      return { ok: false, status: response.status, json };
    }
    if (verbose) log(`POST ${path} → ${response.status}`);
    return { ok: true, status: response.status, json };
  } catch (error) {
    log(`POST ${path} failed: ${error.message}`, 'warn');
    return { ok: false, status: 0, json: null };
  }
}

async function get(path) {
  try {
    const response = await fetch(`${backendUrl}${path}`, { headers });
    const text = await response.text();
    if (!response.ok) {
      log(`GET ${path} → ${response.status} ${text.slice(0, 160)}`, 'warn');
      return null;
    }
    return text ? JSON.parse(text) : null;
  } catch (error) {
    log(`GET ${path} failed: ${error.message}`, 'warn');
    return null;
  }
}

const colours = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', trade: '\x1b[35m', reset: '\x1b[0m' };
function log(message, level = 'info') {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`${colours[level] ?? ''}[${stamp}] ${message}${colours.reset}`);
}

/* ------------------------------------------------------------------ */
/* payload builders (mirror the EA)                                    */
/* ------------------------------------------------------------------ */

function symbolPayload(symbol) {
  const spec = SYMBOLS[symbol];
  return {
    symbol,
    description: spec.description,
    path: `Simulated\\${spec.base}`,
    currency_base: spec.base,
    currency_profit: spec.quote,
    currency_margin: spec.base,
    digits: spec.digits,
    point: Number((10 ** -spec.digits).toFixed(10)),
    tick_size: Number((10 ** -spec.digits).toFixed(10)),
    tick_value: Number((spec.contract * 10 ** -spec.digits).toFixed(8)),
    tick_value_profit: Number((spec.contract * 10 ** -spec.digits).toFixed(8)),
    tick_value_loss: Number((spec.contract * 10 ** -spec.digits).toFixed(8)),
    contract_size: spec.contract,
    volume_min: 0.01,
    volume_max: 50,
    volume_step: 0.01,
    stops_level: 30,
    freeze_level: 0,
    trade_mode: 4,
    trade_allowed: true,
    swap_long: -0.5,
    swap_short: -0.3,
    sessions: [],
  };
}

function tickPayload(symbol) {
  const quote = price(symbol);
  const spec = SYMBOLS[symbol];
  const point = 10 ** -spec.digits;
  const dayRange = spec.price * 0.01;
  return {
    symbol,
    bid: quote.bid,
    ask: quote.ask,
    last: quote.bid,
    spread_points: Number(((quote.ask - quote.bid) / point).toFixed(2)),
    time: iso(),
    day_open: spec.price,
    day_high: round(spec.price + dayRange, spec.digits),
    day_low: round(spec.price - dayRange, spec.digits),
  };
}

function accountPayload() {
  let floating = 0;
  for (const position of state.positions.values()) floating += profitOf(position);
  floating = Number(floating.toFixed(2));
  const equity = Number((state.balance + floating).toFixed(2));
  return {
    login: accountLogin,
    server: accountServer,
    currency: accountCurrency,
    leverage: accountLeverage,
    balance: Number(state.balance.toFixed(2)),
    equity,
    margin: 0,
    free_margin: equity,
    margin_level: 0,
    profit: floating,
    trade_allowed: true,
    trade_expert: true,
    timestamp: iso(),
  };
}

function positionsPayload() {
  return {
    positions: [...state.positions.values()].map((position) => {
      const quote = price(position.symbol);
      return {
        ticket: position.ticket,
        symbol: position.symbol,
        type: position.type,
        volume: position.volume,
        open_price: position.open_price,
        current_price: position.type === 0 ? quote.bid : quote.ask,
        stop_loss: position.stop_loss ?? 0,
        take_profit: position.take_profit ?? 0,
        profit: profitOf(position),
        swap: 0,
        commission: 0,
        magic: position.magic ?? 700200,
        comment: position.comment ?? 'TradePilot simulator',
        open_time: iso(position.open_time),
      };
    }),
  };
}

function ordersPayload() {
  return {
    orders: [...state.orders.values()].map((order) => ({
      ticket: order.ticket,
      symbol: order.symbol,
      type: order.type,
      volume: order.volume,
      price: order.price,
      stop_limit_price: order.stop_limit_price ?? 0,
      stop_loss: order.stop_loss ?? 0,
      take_profit: order.take_profit ?? 0,
      expiration: iso(0),
      state: 1,
      magic: 700200,
      comment: order.comment ?? 'TradePilot simulator',
      setup_time: iso(order.setup_time),
    })),
  };
}

function dealsPayload(from, to) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return {
    deals: state.deals.filter((deal) => {
      const time = Date.parse(deal.time);
      return (!Number.isFinite(start) || time >= start) && (!Number.isFinite(end) || time <= end);
    }),
  };
}

function ratesPayload(symbol, timeframe, count) {
  const spec = SYMBOLS[symbol] ?? SYMBOLS.XAUUSD;
  const stepMs = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000, W1: 604_800_000 }[timeframe] ?? 900_000;
  const rates = [];
  let close = spec.price;
  for (let index = count - 1; index >= 0; index -= 1) {
    const time = nowMs() - index * stepMs;
    const open = close;
    const wave = Math.sin((index + 1) / 7) * spec.price * 0.004;
    close = spec.price + wave;
    const high = Math.max(open, close) + spec.price * 0.0008;
    const low = Math.min(open, close) - spec.price * 0.0008;
    rates.push({
      time: iso(time),
      open: round(open, spec.digits),
      high: round(high, spec.digits),
      low: round(low, spec.digits),
      close: round(close, spec.digits),
      volume: 100 + ((index * 7) % 400),
    });
  }
  return { rates: rates.slice(-count) };
}

/* ------------------------------------------------------------------ */
/* command verification (identical rule to the EA / backend)           */
/* ------------------------------------------------------------------ */

function numberToPlainString(value) {
  if (!Number.isFinite(value)) return 'null';
  const rounded = Math.round(value * 1e8) / 1e8;
  if (Math.abs(rounded) >= 1e15) return String(rounded);
  if (Number.isInteger(rounded)) return String(rounded);
  const text = rounded.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return text === '' || text === '-0' ? '0' : text;
}

/** Stable JSON: keys sorted recursively, numbers written as plain decimals. */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return numberToPlainString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

/**
 * Byte-for-byte the same canonical string the backend signs
 * (shared/src/lib/bridge-signature.ts) and the EA reproduces in MQL5.
 */
function canonicalCommandPayload(command) {
  return [
    command.command_id,
    command.timestamp,
    command.user_id,
    command.account_id,
    command.symbol ?? '',
    command.action,
    stableStringify(command.parameters ?? {}),
    command.idempotency_key,
    command.nonce,
    '1.0.0',
  ].join('|');
}

function expectedSignature(command) {
  return createHmac('sha256', deviceSecret).update(canonicalCommandPayload(command)).digest('hex');
}

/* ------------------------------------------------------------------ */
/* command execution                                                   */
/* ------------------------------------------------------------------ */

function normalizeVolume(symbol, requested) {
  const step = 0.01;
  const volume = Math.round(requested / step) * step;
  return Number(Math.min(50, Math.max(0.01, volume)).toFixed(2));
}

function openMarket(parameters) {
  const symbol = String(parameters.symbol ?? '').toUpperCase();
  const spec = SYMBOLS[symbol];
  if (!spec) return { success: false, error_code: 'SYMBOL_NOT_FOUND', error_message: `${symbol || 'The symbol'} is not available in this terminal.` };
  const side = String(parameters.side ?? 'BUY').toUpperCase();
  const volume = normalizeVolume(symbol, Number(parameters.volume ?? 0));
  if (!(volume >= 0.01)) return { success: false, error_code: 'INVALID_VOLUME', error_message: 'Volume is below the broker minimum of 0.01 lots.' };
  const quote = price(symbol);
  const entry = side === 'SELL' ? quote.bid : quote.ask;
  const ticket = nextTicket();
  const position = {
    ticket,
    symbol,
    type: side === 'SELL' ? 1 : 0,
    volume,
    open_price: entry,
    stop_loss: Number(parameters.stop_loss ?? 0) || 0,
    take_profit: Number(parameters.take_profit ?? 0) || 0,
    magic: Number(parameters.magic ?? 700200),
    comment: String(parameters.comment ?? 'TradePilot'),
    open_time: nowMs(),
  };
  state.positions.set(ticket, position);

  // A real MT5 history contains BOTH the entry and the exit deal for a position,
  // and the backend aggregates them pairwise. Without this IN deal the trade
  // never reaches TradePilot's history — which is exactly how this simulator
  // behaved before it was verified against the live pipeline.
  state.deals.push({
    ticket: nextTicket(),
    position_id: ticket,
    symbol,
    type: position.type === 0 ? 0 : 1, // DEAL_TYPE_BUY / DEAL_TYPE_SELL
    entry: 0, // DEAL_ENTRY_IN
    volume,
    price: entry,
    commission: 0,
    swap: 0,
    profit: 0,
    time: iso(),
    magic: position.magic,
    comment: position.comment,
  });
  log(`${side} ${volume} ${symbol} @ ${entry} → ticket ${ticket} (SIMULATED)`, 'trade');
  return { success: true, broker_ticket: ticket, execution_price: entry, volume, retcode: 10009, state: 'EXECUTED' };
}

function placePending(parameters) {
  const symbol = String(parameters.symbol ?? '').toUpperCase();
  if (!SYMBOLS[symbol]) return { success: false, error_code: 'SYMBOL_NOT_FOUND', error_message: `${symbol} is not available in this terminal.` };
  const ticket = nextTicket();
  state.orders.set(ticket, {
    ticket,
    symbol,
    type: String(parameters.kind ?? 'BUY_LIMIT'),
    volume: normalizeVolume(symbol, Number(parameters.volume ?? 0.01)),
    price: Number(parameters.price ?? 0),
    stop_limit_price: Number(parameters.stop_limit_price ?? 0) || null,
    stop_loss: Number(parameters.stop_loss ?? 0) || null,
    take_profit: Number(parameters.take_profit ?? 0) || null,
    comment: String(parameters.comment ?? 'TradePilot pending'),
    setup_time: nowMs(),
  });
  log(`pending ${parameters.kind} ${symbol} @ ${parameters.price} → ticket ${ticket} (SIMULATED)`, 'trade');
  return { success: true, broker_ticket: ticket, execution_price: Number(parameters.price ?? 0), volume: Number(parameters.volume ?? 0), retcode: 10008, state: 'PLACED' };
}

function modifyPosition(parameters) {
  const ticket = Number(parameters.ticket);
  const position = state.positions.get(ticket);
  if (!position) return { success: false, error_code: 'TICKET_NOT_FOUND', error_message: `Position #${ticket} does not exist in this terminal.` };
  if (parameters.stop_loss !== undefined && parameters.stop_loss !== null) position.stop_loss = Number(parameters.stop_loss);
  if (parameters.take_profit !== undefined && parameters.take_profit !== null) position.take_profit = Number(parameters.take_profit);
  log(`modified position ${ticket}: SL ${position.stop_loss} TP ${position.take_profit} (SIMULATED)`, 'trade');
  return { success: true, broker_ticket: ticket, execution_price: position.open_price, volume: position.volume, retcode: 10009, state: 'MODIFIED' };
}

function closePosition(parameters) {
  const ticket = Number(parameters.ticket);
  const position = state.positions.get(ticket);
  if (!position) return { success: false, error_code: 'TICKET_NOT_FOUND', error_message: `Position #${ticket} does not exist in this terminal.` };
  const spec = SYMBOLS[position.symbol];
  const quote = price(position.symbol);
  const exit = position.type === 0 ? quote.bid : quote.ask;
  const profit = profitOf(position);
  const volume = parameters.volume ? normalizeVolume(position.symbol, Number(parameters.volume)) : position.volume;
  const partial = volume < position.volume;
  const closedVolume = partial ? volume : position.volume;

  state.deals.push({
    ticket: nextTicket(),
    position_id: position.ticket,
    symbol: position.symbol,
    type: position.type === 0 ? 1 : 0,
    entry: 1,
    volume: closedVolume,
    price: exit,
    commission: -0.08 * closedVolume * 10,
    swap: 0,
    profit: partial ? Number((profit * (closedVolume / position.volume)).toFixed(2)) : profit,
    time: iso(),
    magic: position.magic,
    comment: 'Closed by TradePilot simulator',
  });

  if (partial) {
    position.volume = Number((position.volume - closedVolume).toFixed(2));
  } else {
    state.positions.delete(ticket);
  }
  state.balance = Number((state.balance + (partial ? profit * (closedVolume / (position.volume + closedVolume)) : profit)).toFixed(2));
  void spec;
  log(`closed ${closedVolume} lots of ${position.symbol} @ ${exit} (SIMULATED)`, 'trade');
  return { success: true, broker_ticket: ticket, execution_price: exit, volume: closedVolume, retcode: 10009, state: partial ? 'PARTIALLY_CLOSED' : 'CLOSED', data: { realized_pl: profit } };
}

function cancelOrder(parameters) {
  const ticket = Number(parameters.ticket);
  if (!state.orders.delete(ticket)) {
    return { success: false, error_code: 'TICKET_NOT_FOUND', error_message: `Pending order #${ticket} does not exist in this terminal.` };
  }
  log(`cancelled pending order ${ticket} (SIMULATED)`, 'trade');
  return { success: true, broker_ticket: ticket, retcode: 10009, state: 'CANCELLED' };
}

const ACTION_HANDLERS = {
  PING: () => ({ success: true, state: 'OK', data: { pong: true, terminal_time: iso(), simulated: true } }),
  GET_ACCOUNT: () => ({ success: true, state: 'OK', data: { account: accountPayload() } }),
  GET_POSITIONS: () => ({ success: true, state: 'OK', data: positionsPayload() }),
  GET_ORDERS: () => ({ success: true, state: 'OK', data: ordersPayload() }),
  GET_SYMBOL_INFO: (parameters) => {
    const requested = String(parameters.symbol ?? '').toUpperCase();
    const list = requested ? [requested] : Object.keys(SYMBOLS);
    if (requested && !SYMBOLS[requested]) {
      return { success: false, error_code: 'SYMBOL_NOT_FOUND', error_message: `${requested} is not available in the simulated terminal.` };
    }
    return { success: true, state: 'OK', data: { symbols: list.map(symbolPayload) } };
  },
  GET_HISTORY: (parameters) => ({ success: true, state: 'OK', data: dealsPayload(parameters.from ?? iso(0), parameters.to ?? iso()) }),
  GET_CANDLES: (parameters) => {
    const symbol = String(parameters.symbol ?? 'XAUUSD').toUpperCase();
    if (!SYMBOLS[symbol]) return { success: false, error_code: 'SYMBOL_NOT_FOUND', error_message: `${symbol} is not available in the simulated terminal.` };
    return { success: true, state: 'OK', data: ratesPayload(symbol, String(parameters.timeframe ?? 'M15'), Math.min(1000, Number(parameters.count ?? 300))) };
  },
  OPEN_MARKET_ORDER: (parameters) => openMarket(parameters),
  PLACE_PENDING_ORDER: (parameters) => placePending(parameters),
  MODIFY_POSITION: (parameters) => modifyPosition(parameters),
  MODIFY_ORDER: (parameters) => {
    const ticket = Number(parameters.ticket);
    const order = state.orders.get(ticket);
    if (!order) return { success: false, error_code: 'TICKET_NOT_FOUND', error_message: `Pending order #${ticket} does not exist in this terminal.` };
    if (parameters.price) order.price = Number(parameters.price);
    if (parameters.stop_loss !== undefined && parameters.stop_loss !== null) order.stop_loss = Number(parameters.stop_loss);
    if (parameters.take_profit !== undefined && parameters.take_profit !== null) order.take_profit = Number(parameters.take_profit);
    return { success: true, broker_ticket: ticket, execution_price: order.price, volume: order.volume, retcode: 10009, state: 'MODIFIED' };
  },
  CLOSE_POSITION: (parameters) => closePosition(parameters),
  CLOSE_ALL_POSITIONS: (parameters) => {
    // Mirrors the EA: the exact confirmation text is re-checked inside the terminal.
    if (String(parameters.confirm ?? '').trim() !== 'CONFIRM CLOSE ALL') {
      return { success: false, error_code: 'CONFIRMATION_MISMATCH', error_message: 'Emergency close-all requires the exact confirmation text "CONFIRM CLOSE ALL".' };
    }
    const symbolFilter = parameters.symbol ? String(parameters.symbol).toUpperCase() : null;
    let closed = 0;
    let volume = 0;
    for (const ticket of [...state.positions.keys()]) {
      const position = state.positions.get(ticket);
      if (symbolFilter && position.symbol !== symbolFilter) continue;
      const outcome = closePosition({ ticket });
      if (outcome.success) {
        closed += 1;
        volume += outcome.volume ?? 0;
      }
    }
    log(`close-all: ${closed} position(s) closed (SIMULATED)`, 'trade');
    return { success: true, state: 'CLOSED_ALL', data: { closed_count: closed, closed_volume: Number(volume.toFixed(2)), failures: null } };
  },
  CANCEL_ORDER: (parameters) => cancelOrder(parameters),
  CANCEL_ALL_ORDERS: (parameters) => {
    const symbolFilter = parameters.symbol ? String(parameters.symbol).toUpperCase() : null;
    let cancelled = 0;
    for (const ticket of [...state.orders.keys()]) {
      const order = state.orders.get(ticket);
      if (symbolFilter && order.symbol !== symbolFilter) continue;
      if (state.orders.delete(ticket)) cancelled += 1;
    }
    return { success: true, state: 'CANCELLED', data: { cancelled } };
  },
};

async function reportResult(commandId, outcome) {
  const payload = {
    command_id: commandId,
    success: Boolean(outcome.success),
    broker_ticket: outcome.broker_ticket ?? null,
    execution_price: outcome.execution_price ?? null,
    volume: outcome.volume ?? null,
    retcode: outcome.retcode ?? null,
    error_code: outcome.error_code ?? null,
    error_message: outcome.error_message ?? null,
    timestamp: iso(),
    state: outcome.state ?? null,
    data: outcome.data ?? null,
  };
  const response = await post('/api/v1/bridge/result', payload);
  if (!response.ok) log(`could not report the result of ${commandId}`, 'warn');
}

async function handleCommand(command) {
  const label = `${command.action} (${command.command_id})`;

  if (state.executedCommandIds.has(command.command_id) || state.seenNonces.has(command.nonce)) {
    state.commandsRefused += 1;
    log(`refused ${label}: already executed on this terminal (replay protection)`, 'warn');
    await reportResult(command.command_id, {
      success: false,
      error_code: 'REPLAY_DETECTED',
      error_message: 'This command was already executed by this terminal.',
      state: 'REFUSED',
    });
    return;
  }

  if (expectedSignature(command) !== command.signature) {
    state.commandsRefused += 1;
    log(`refused ${label}: signature verification failed`, 'warn');
    await reportResult(command.command_id, {
      success: false,
      error_code: 'SIGNATURE_INVALID',
      error_message: 'Command signature verification failed — the command was not signed with this device secret.',
      state: 'REFUSED',
    });
    return;
  }

  const driftSeconds = Math.abs((Date.parse(command.timestamp) - nowMs()) / 1000);
  if (!Number.isFinite(driftSeconds) || driftSeconds > 180) {
    state.commandsRefused += 1;
    log(`refused ${label}: timestamp differs by ${driftSeconds.toFixed(0)}s`, 'warn');
    await reportResult(command.command_id, {
      success: false,
      error_code: 'MT5_CLOCK_SKEW',
      error_message: `Command timestamp differs from the terminal clock by ${driftSeconds.toFixed(0)} seconds.`,
      state: 'REFUSED',
    });
    return;
  }

  state.executedCommandIds.add(command.command_id);
  state.seenNonces.add(command.nonce);

  const handler = ACTION_HANDLERS[command.action];
  const outcome = handler
    ? handler({ ...(command.parameters ?? {}), symbol: command.parameters?.symbol ?? command.symbol })
    : { success: false, error_code: 'NOT_SUPPORTED', error_message: `Unsupported action ${command.action}.` };

  state.commandsExecuted += 1;
  if (!outcome.success) state.commandsRefused += 1;
  await reportResult(command.command_id, outcome);
}

/* ------------------------------------------------------------------ */
/* loops                                                               */
/* ------------------------------------------------------------------ */

const symbolNames = Object.keys(SYMBOLS);

async function heartbeat() {
  const response = await post('/api/v1/bridge/heartbeat', {
    device_id: deviceId,
    sequence: state.sequence + 1,
    account: String(accountLogin),
    server: accountServer,
    timestamp: iso(),
    terminal_connected: true,
    trade_allowed: true,
    ea_trade_allowed: true,
    algo_trading_enabled: true,
    ping_ms: 12,
    terminal_build: 'SIMULATOR',
    ea_version: 'SIMULATOR-1.0.0 (synthetic prices)',
    queued_commands: 0,
  });
  if (response.ok) {
    state.lastHeartbeatAck = response.json?.status ?? null;
  }
  return response.ok;
}

async function pushMarket() {
  await post('/api/v1/bridge/market', {
    symbols: symbolNames.map(symbolPayload),
    ticks: symbolNames.map(tickPayload),
  });
  state.ticksReceived += symbolNames.length;
}

async function pushAccount() {
  await post('/api/v1/bridge/account', accountPayload());
}

async function pushPositionsAndOrders() {
  await post('/api/v1/bridge/positions', positionsPayload());
  await post('/api/v1/bridge/orders', ordersPayload());
}

async function pushDeals() {
  await post('/api/v1/bridge/deals', dealsPayload(iso(nowMs() - 30 * 86_400_000), iso(nowMs() + 60_000)));
}

async function pollCommands() {
  const response = await get('/api/v1/bridge/commands?limit=10');
  const commands = response?.commands ?? [];
  for (const command of commands) {
    await handleCommand(command);
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

log('TradePilot MT5 bridge SIMULATOR — synthetic prices only, never a broker feed');
log(`backend ${backendUrl} · device ${deviceId} · account ${accountLogin} @ ${accountServer}`);
log('every quote is sent with a "SIMULATED FEED" description and absurd price levels', 'warn');

const ack = await heartbeat();
if (!ack) {
  log('the backend refused the first heartbeat — check the device token and that the backend is running', 'warn');
  process.exit(1);
}
log(`heartbeat accepted (status ${state.lastHeartbeatAck}) — the terminal now shows MT5 CONNECTED`, 'ok');

await pushMarket();
await pushAccount();
await pushPositionsAndOrders();
await pushDeals();
log(`pushed ${symbolNames.length} symbol specs and ${symbolNames.length} synthetic ticks`, 'ok');

setInterval(() => void heartbeat(), heartbeatMs);
setInterval(() => void pushMarket(), tickMs);
setInterval(() => void pushPositionsAndOrders(), syncMs);
setInterval(() => void pushAccount(), syncMs * 2);
setInterval(() => void pushDeals(), syncMs * 3);
setInterval(() => void pollCommands(), pollMs);

process.on('SIGINT', () => {
  log(`stopping — ${state.commandsExecuted} command(s) executed, ${state.commandsRefused} refused`, 'warn');
  log('the terminal will be marked offline after the heartbeat timeout; live prices stop immediately', 'warn');
  process.exit(0);
});
