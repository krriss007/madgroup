import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_TYPES,
  LEVERAGE_OPTIONS,
  type AccountSettings,
  type AccountStateFull,
  type AccountStateLive,
  type AccountSummary,
  type AccountType,
  type ClosedTrade,
  type CloseReason,
  type LedgerEntry,
  type OrderRecord,
  type OrderRequest,
  type OrderSource,
  type OrderStatus,
  type PendingOrder,
  type Position,
  type PositionView,
  type Quote,
  type Side,
} from '../../shared/types';
import type { MarketData, RawQuote } from '../market/marketData';
import {
  grossProfitUsd,
  marginLevelPct,
  normaliseVolume,
  requiredMargin,
  roundPrice,
  utcDay,
  validateStops,
  validateStopsForClose,
  validateVolume,
} from './math';

export const STARTING_BALANCE = 10_000;
/** Margin level (%) below which new orders are refused. */
export const MARGIN_CALL_LEVEL = 100;
/** Margin level (%) at which open positions are closed automatically (worst first). */
export const STOP_OUT_LEVEL = 50;
const LIST_LIMIT = 1000;
const FIRST_TICKET = 100_001;

export interface PersistedAccount {
  accountId: string;
  balance: number;
  startingBalance: number;
  settings: AccountSettings;
  nextId: number;
  nextLedgerId: number;
  positions: Position[];
  pending: PendingOrder[];
  history: ClosedTrade[];
  orders: OrderRecord[];
  ledger: LedgerEntry[];
  lastRolloverDay: string;
  dayStartEquity: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export type EngineEvent =
  | { type: 'notice'; level: 'info' | 'success' | 'warn' | 'error'; message: string; symbol?: string; source?: OrderSource }
  | { type: 'changed'; history: boolean };

export function createAccount(now = Date.now(), balance = STARTING_BALANCE): PersistedAccount {
  return {
    accountId: `DEMO-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    balance,
    startingBalance: balance,
    settings: { accountType: 'standard', leverage: 100 },
    nextId: FIRST_TICKET,
    nextLedgerId: 1,
    positions: [],
    pending: [],
    history: [],
    orders: [],
    ledger: [
      {
        id: 0,
        time: now,
        type: 'deposit',
        amount: balance,
        balanceAfter: balance,
        note: 'Initial demo balance',
      },
    ],
    lastRolloverDay: utcDay(now),
    dayStartEquity: balance,
  };
}

export interface EngineOptions {
  market: MarketData;
  state: PersistedAccount;
  now?: () => number;
  onEvent?: (e: EngineEvent) => void;
}

/**
 * Demo trading engine. Implements market/pending orders, SL/TP, partial closes,
 * margin & free margin, margin call / stop-out, swap rollover and a ledger.
 * All amounts are in USD. Prices come from the MarketData store.
 */
export class TradingEngine {
  private readonly market: MarketData;
  readonly state: PersistedAccount;
  private readonly clock: () => number;
  private readonly onEvent: (e: EngineEvent) => void;

  constructor(opts: EngineOptions) {
    this.market = opts.market;
    this.state = opts.state;
    this.clock = opts.now ?? Date.now;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  // ---------------------------------------------------------------- quotes

  private lookup = (symbol: string): number | undefined => {
    const m = this.market.mid(symbol);
    return m > 0 ? m : undefined;
  };

  /** Bid/ask for this account (spread scaled by the account type). */
  quote(symbol: string): { bid: number; ask: number; mid: number; raw: RawQuote } | null {
    const raw = this.market.raw(symbol);
    if (!raw) return null;
    const mult = ACCOUNT_TYPES[this.state.settings.accountType].spreadMultiplier;
    const half = (raw.spread * mult) / 2;
    return {
      bid: roundPrice(raw.mid - half, raw.digits),
      ask: roundPrice(raw.mid + half, raw.digits),
      mid: raw.mid,
      raw,
    };
  }

  quotes(): Quote[] {
    const out: Quote[] = [];
    for (const symbol of this.market.symbols()) {
      const q = this.quote(symbol);
      if (!q) continue;
      const { raw } = q;
      const change = raw.mid - raw.dayOpen;
      out.push({
        symbol,
        bid: q.bid,
        ask: q.ask,
        mid: raw.mid,
        spread: roundPrice(q.ask - q.bid, raw.digits + 2),
        digits: raw.digits,
        dayOpen: raw.dayOpen,
        change,
        changePct: raw.dayOpen > 0 ? (change / raw.dayOpen) * 100 : 0,
        high: raw.high,
        low: raw.low,
        source: raw.source,
        time: raw.time,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- views

  positionViews(): PositionView[] {
    const views: PositionView[] = [];
    for (const pos of this.state.positions) {
      const spec = this.market.spec(pos.symbol);
      const q = this.quote(pos.symbol);
      if (!spec || !q) continue;
      const close = pos.side === 'buy' ? q.bid : q.ask;
      const profit = grossProfitUsd(spec, pos.side, pos.volume, pos.openPrice, close, this.lookup);
      views.push({
        ...pos,
        currentPrice: close,
        profit,
        roe: pos.margin > 0 ? (profit / pos.margin) * 100 : 0,
      });
    }
    return views;
  }

  summary(): AccountSummary {
    const floating = this.positionViews().reduce((acc, p) => acc + p.profit, 0);
    const margin = this.state.positions.reduce((acc, p) => acc + p.margin, 0);
    const balance = this.state.balance;
    const equity = balance + floating;
    return {
      accountId: this.state.accountId,
      currency: 'USD',
      balance,
      equity,
      margin,
      freeMargin: equity - margin,
      marginLevel: marginLevelPct(equity, margin),
      floatingPnl: floating,
      marginCallLevel: MARGIN_CALL_LEVEL,
      stopOutLevel: STOP_OUT_LEVEL,
      settings: { ...this.state.settings },
      dayStartEquity: this.state.dayStartEquity,
      dayPnl: equity - this.state.dayStartEquity,
      startingBalance: this.state.startingBalance,
    };
  }

  live(): AccountStateLive {
    return {
      summary: this.summary(),
      positions: this.positionViews(),
      pending: this.state.pending.map((p) => ({ ...p })),
    };
  }

  full(): AccountStateFull {
    return {
      ...this.live(),
      history: this.state.history.slice(0, 200).map((t) => ({ ...t })),
      orders: this.state.orders.slice(0, 200).map((o) => ({ ...o })),
      ledger: this.state.ledger.slice(0, 200).map((l) => ({ ...l })),
    };
  }

  openPositions(filter: { source?: OrderSource; symbol?: string } = {}): Position[] {
    return this.state.positions.filter(
      (p) => (!filter.source || p.source === filter.source) && (!filter.symbol || p.symbol === filter.symbol),
    );
  }

  // ---------------------------------------------------------------- orders

  placeOrder(req: OrderRequest, source: OrderSource = 'manual'): Result<{ ticket: number; kind: 'position' | 'pending' }> {
    const comment = req.comment ?? '';
    const symbol = req.symbol;
    const spec = this.market.spec(symbol);
    const reject = (message: string) => {
      this.recordOrder({
        id: this.nextId(),
        time: this.clock(),
        updatedAt: this.clock(),
        symbol,
        side: req.side,
        type: req.type,
        volume: Number(req.volume) || 0,
        price: req.price ?? null,
        fillPrice: null,
        sl: req.sl ?? null,
        tp: req.tp ?? null,
        status: 'rejected',
        message,
        source,
        comment,
      });
      this.notice('error', message, symbol, source);
      return fail(message);
    };

    if (!spec) return reject(`Unknown symbol ${symbol}`);
    if (req.side !== 'buy' && req.side !== 'sell') return reject('Side must be buy or sell');
    if (!['market', 'limit', 'stop'].includes(req.type)) return reject('Unsupported order type');
    const volErr = validateVolume(req.volume, spec);
    if (volErr) return reject(volErr);
    const volume = normaliseVolume(req.volume);
    const q = this.quote(symbol);
    if (!q) return reject(`No price available for ${symbol}`);
    const sl = req.sl ?? null;
    const tp = req.tp ?? null;
    const digits = spec.digits;

    if (req.type === 'market') {
      const entry = req.side === 'buy' ? q.ask : q.bid;
      const stopErr = validateStops(req.side, entry, sl, tp);
      if (stopErr) return reject(stopErr);
      const ticket = this.nextId();
      const opened = this.tryOpen({
        id: ticket,
        symbol,
        side: req.side,
        volume,
        entry,
        sl: sl === null ? null : roundPrice(sl, digits),
        tp: tp === null ? null : roundPrice(tp, digits),
        source,
        comment,
      });
      if (!opened.ok) return reject(opened.error);
      this.recordOrder({
        id: ticket,
        time: this.clock(),
        updatedAt: this.clock(),
        symbol,
        side: req.side,
        type: 'market',
        volume,
        price: null,
        fillPrice: entry,
        sl: opened.data.sl,
        tp: opened.data.tp,
        status: 'filled',
        message: 'Filled',
        source,
        comment,
      });
      this.notice('success', `${req.side.toUpperCase()} ${volume} ${symbol} filled at ${entry}`, symbol, source);
      this.emit({ type: 'changed', history: true });
      return ok({ ticket, kind: 'position' });
    }

    // Pending order (limit or stop).
    const price = req.price;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return reject('Pending orders need a valid price');
    const p = roundPrice(price, digits);
    const label = `${req.side === 'buy' ? 'Buy' : 'Sell'} ${req.type === 'limit' ? 'Limit' : 'Stop'}`;
    // Guard against fat-finger prices far from the market.
    const reference = req.side === 'buy' ? q.ask : q.bid;
    if (Math.abs(p / reference - 1) > 0.5) return reject(`${label} price must be within 50% of the current market price`);
    if (req.type === 'limit') {
      if (req.side === 'buy' && p >= q.ask) return reject(`${label} must be below the current ask (${q.ask})`);
      if (req.side === 'sell' && p <= q.bid) return reject(`${label} must be above the current bid (${q.bid})`);
    } else {
      if (req.side === 'buy' && p <= q.ask) return reject(`${label} must be above the current ask (${q.ask})`);
      if (req.side === 'sell' && p >= q.bid) return reject(`${label} must be below the current bid (${q.bid})`);
    }
    const stopErr = validateStops(req.side, p, sl, tp);
    if (stopErr) return reject(stopErr);

    const id = this.nextId();
    const pending: PendingOrder = {
      id,
      symbol,
      side: req.side,
      type: req.type,
      volume,
      price: p,
      sl: sl === null ? null : roundPrice(sl, digits),
      tp: tp === null ? null : roundPrice(tp, digits),
      createdAt: this.clock(),
      source,
      comment,
    };
    this.state.pending.unshift(pending);
    this.recordOrder({
      id,
      time: this.clock(),
      updatedAt: this.clock(),
      symbol,
      side: req.side,
      type: req.type,
      volume,
      price: p,
      fillPrice: null,
      sl: pending.sl,
      tp: pending.tp,
      status: 'pending',
      message: `${label} placed`,
      source,
      comment,
    });
    this.notice('info', `${label} ${volume} ${symbol} @ ${p} placed`, symbol, source);
    this.emit({ type: 'changed', history: true });
    return ok({ ticket: id, kind: 'pending' });
  }

  /** Close all or part of a position at the current price. */
  closePosition(
    id: number,
    opts: { volume?: number; reason?: CloseReason } = {},
  ): Result<{ closed: number; profit: number }> {
    const idx = this.state.positions.findIndex((p) => p.id === id);
    if (idx < 0) return fail('Position not found');
    const pos = this.state.positions[idx]!;
    const spec = this.market.spec(pos.symbol);
    const q = this.quote(pos.symbol);
    if (!spec || !q) return fail(`No price available for ${pos.symbol}`);

    // Validate the raw request before normalising so off-step volumes are rejected, not rounded.
    const requested = opts.volume ?? pos.volume;
    const volErr = validateVolume(requested, spec);
    if (volErr) return fail(volErr);
    const vol = normaliseVolume(requested);
    if (!(vol > 0)) return fail('Volume must be greater than zero');
    if (vol > pos.volume + 1e-9) return fail('Volume is larger than the open position');
    const remaining = normaliseVolume(pos.volume - vol);
    if (remaining > 1e-9 && remaining < spec.minVolume) {
      return fail(`Remaining volume would be below ${spec.minVolume} lots. Close the full position instead.`);
    }

    const reason = opts.reason ?? 'manual';
    const full = remaining <= 1e-9;
    const closePrice = pos.side === 'buy' ? q.bid : q.ask;
    const fraction = vol / pos.volume;
    const gross = grossProfitUsd(spec, pos.side, vol, pos.openPrice, closePrice, this.lookup);
    const commPerLot = ACCOUNT_TYPES[this.state.settings.accountType].commissionPerLot;
    const closeComm = -commPerLot * vol;
    const openCommShare = pos.commission * fraction;
    const swapShare = pos.swap * fraction;
    const net = gross + openCommShare + swapShare + closeComm;

    this.state.balance += gross + closeComm;
    this.ledgerEntry('trade', gross, `${pos.side.toUpperCase()} ${pos.symbol} ${vol} lots closed (${reason})`);
    if (closeComm !== 0) this.ledgerEntry('commission', closeComm, `Commission on close ${pos.symbol}`);

    if (full) {
      this.state.positions.splice(idx, 1);
    } else {
      pos.volume = remaining;
      pos.margin -= pos.margin * fraction;
      pos.commission -= openCommShare;
      pos.swap -= swapShare;
    }

    this.pushHistory({
      id: this.nextId(),
      symbol: pos.symbol,
      side: pos.side,
      volume: vol,
      openPrice: pos.openPrice,
      closePrice,
      openTime: pos.openTime,
      closeTime: this.clock(),
      profit: net,
      commission: openCommShare + closeComm,
      swap: swapShare,
      reason,
      source: pos.source,
      comment: pos.comment,
    });

    const reasonText: Record<CloseReason, string> = {
      manual: '',
      sl: ' (stop loss)',
      tp: ' (take profit)',
      stop_out: ' (stop out)',
      agent: '',
      agent_flip: ' (agent flip)',
      close_all: '',
    };
    const sign = net >= 0 ? '+' : '-';
    this.notice(
      net >= 0 ? 'success' : 'warn',
      `Closed ${vol} ${pos.symbol} @ ${closePrice}${reasonText[reason]}: ${sign}$${Math.abs(net).toFixed(2)}`,
      pos.symbol,
      pos.source,
    );
    this.emit({ type: 'changed', history: true });
    return ok({ closed: vol, profit: net });
  }

  modifyPosition(id: number, patch: { sl?: number | null; tp?: number | null }): Result<true> {
    const pos = this.state.positions.find((p) => p.id === id);
    if (!pos) return fail('Position not found');
    const spec = this.market.spec(pos.symbol);
    const q = this.quote(pos.symbol);
    if (!spec || !q) return fail(`No price available for ${pos.symbol}`);
    const sl = patch.sl === undefined ? pos.sl : patch.sl;
    const tp = patch.tp === undefined ? pos.tp : patch.tp;
    const closePrice = pos.side === 'buy' ? q.bid : q.ask;
    const err = validateStopsForClose(pos.side, closePrice, sl, tp);
    if (err) return fail(err);
    pos.sl = sl === null ? null : roundPrice(sl, spec.digits);
    pos.tp = tp === null ? null : roundPrice(tp, spec.digits);
    this.notice('info', `Modified ${pos.symbol} #${pos.id}: SL ${pos.sl ?? '—'}, TP ${pos.tp ?? '—'}`, pos.symbol, pos.source);
    this.emit({ type: 'changed', history: false });
    return ok(true);
  }

  cancelOrder(id: number): Result<true> {
    const idx = this.state.pending.findIndex((p) => p.id === id);
    if (idx < 0) return fail('Pending order not found');
    const [order] = this.state.pending.splice(idx, 1);
    this.updateOrder(id, { status: 'cancelled', message: 'Cancelled by user' });
    this.notice('info', `Cancelled pending ${order!.symbol} #${id}`, order!.symbol, order!.source);
    this.emit({ type: 'changed', history: true });
    return ok(true);
  }

  closeAll(filter: { source?: OrderSource; symbol?: string } = {}, reason: CloseReason = 'close_all'): Result<number> {
    const ids = this.openPositions(filter).map((p) => p.id);
    let closed = 0;
    for (const id of ids) {
      if (this.closePosition(id, { reason }).ok) closed++;
    }
    return ok(closed);
  }

  // ---------------------------------------------------------------- account

  deposit(amount: number): Result<true> {
    if (!Number.isFinite(amount) || amount <= 0) return fail('Amount must be positive');
    if (amount > 1_000_000) return fail('Maximum demo deposit is $1,000,000');
    this.state.balance += amount;
    this.state.dayStartEquity += amount;
    this.ledgerEntry('deposit', amount, 'Demo deposit');
    this.notice('success', `Deposited $${amount.toLocaleString('en-US')} demo funds`);
    this.emit({ type: 'changed', history: true });
    return ok(true);
  }

  withdraw(amount: number): Result<true> {
    if (!Number.isFinite(amount) || amount <= 0) return fail('Amount must be positive');
    const s = this.summary();
    if (amount > s.freeMargin + 1e-9) return fail('Withdrawal exceeds free margin');
    if (amount > this.state.balance + 1e-9) return fail('Withdrawal exceeds balance');
    this.state.balance -= amount;
    this.state.dayStartEquity -= amount;
    this.ledgerEntry('withdrawal', -amount, 'Demo withdrawal');
    this.notice('info', `Withdrew $${amount.toLocaleString('en-US')} demo funds`);
    this.emit({ type: 'changed', history: true });
    return ok(true);
  }

  reset(): Result<true> {
    this.state.positions = [];
    this.state.pending = [];
    this.state.history = [];
    this.state.orders = [];
    this.state.ledger = [];
    this.state.balance = STARTING_BALANCE;
    this.state.startingBalance = STARTING_BALANCE;
    this.state.dayStartEquity = STARTING_BALANCE;
    this.state.lastRolloverDay = utcDay(this.clock());
    this.ledgerEntry('reset', STARTING_BALANCE, 'Account reset to demo balance');
    this.notice('info', 'Demo account reset');
    this.emit({ type: 'changed', history: true });
    return ok(true);
  }

  setSettings(patch: { accountType?: AccountType; leverage?: number }): Result<AccountSettings> {
    if (patch.accountType !== undefined) {
      if (!(patch.accountType in ACCOUNT_TYPES)) return fail('Unknown account type');
      this.state.settings.accountType = patch.accountType;
    }
    if (patch.leverage !== undefined) {
      if (!(LEVERAGE_OPTIONS as readonly number[]).includes(patch.leverage)) return fail('Unsupported leverage');
      this.state.settings.leverage = patch.leverage;
    }
    this.notice('info', `Account set to ${ACCOUNT_TYPES[this.state.settings.accountType].label}, 1:${this.state.settings.leverage}`);
    this.emit({ type: 'changed', history: false });
    return ok({ ...this.state.settings });
  }

  // ---------------------------------------------------------------- market reactions

  /** Called on every market tick. Handles rollover, SL/TP, pending fills and stop-out. */
  onMarketTick(symbol: string): void {
    let changed = false;
    changed = this.rolloverIfNeeded() || changed;

    // Stop loss / take profit.
    const hits: Array<{ id: number; reason: CloseReason }> = [];
    for (const pos of this.state.positions) {
      if (pos.symbol !== symbol) continue;
      const q = this.quote(symbol);
      if (!q) continue;
      if (pos.side === 'buy') {
        if (pos.sl !== null && q.bid <= pos.sl) hits.push({ id: pos.id, reason: 'sl' });
        else if (pos.tp !== null && q.bid >= pos.tp) hits.push({ id: pos.id, reason: 'tp' });
      } else {
        if (pos.sl !== null && q.ask >= pos.sl) hits.push({ id: pos.id, reason: 'sl' });
        else if (pos.tp !== null && q.ask <= pos.tp) hits.push({ id: pos.id, reason: 'tp' });
      }
    }
    for (const hit of hits) {
      if (this.closePosition(hit.id, { reason: hit.reason }).ok) changed = true;
    }

    // Pending orders.
    const q = this.quote(symbol);
    if (q) {
      const triggered = this.state.pending.filter((o) => {
        if (o.symbol !== symbol) return false;
        if (o.side === 'buy') return o.type === 'limit' ? q.ask <= o.price : q.ask >= o.price;
        return o.type === 'limit' ? q.bid >= o.price : q.bid <= o.price;
      });
      for (const order of triggered) {
        this.state.pending = this.state.pending.filter((p) => p.id !== order.id);
        const entry = order.side === 'buy' ? q.ask : q.bid;
        const opened = this.tryOpen({
          id: order.id,
          symbol: order.symbol,
          side: order.side,
          volume: order.volume,
          entry,
          sl: order.sl,
          tp: order.tp,
          source: order.source,
          comment: order.comment,
        });
        if (opened.ok) {
          this.updateOrder(order.id, { status: 'filled', fillPrice: entry, message: 'Pending order filled' });
          this.notice('success', `Pending ${order.type} ${order.side} ${order.volume} ${symbol} filled at ${entry}`, symbol, order.source);
        } else {
          this.updateOrder(order.id, { status: 'cancelled', message: opened.error });
          this.notice('warn', `Pending order #${order.id} cancelled: ${opened.error}`, symbol, order.source);
        }
        changed = true;
      }
    }

    changed = this.checkStopOut() || changed;
    if (changed) this.emit({ type: 'changed', history: false });
  }

  /** Closes positions (worst first) while margin level is at or below the stop-out level. */
  checkStopOut(): boolean {
    let s = this.summary();
    if (s.marginLevel === null || s.marginLevel > STOP_OUT_LEVEL) return false;
    const worstFirst = this.positionViews().sort((a, b) => a.profit - b.profit);
    let closedAny = false;
    for (const view of worstFirst) {
      this.closePosition(view.id, { reason: 'stop_out' });
      closedAny = true;
      s = this.summary();
      if (s.marginLevel === null || s.marginLevel > STOP_OUT_LEVEL) break;
    }
    if (closedAny) this.notice('error', `Stop out: margin level fell to ${s.marginLevel?.toFixed(1) ?? '—'}%`);
    return closedAny;
  }

  /** Charges swap once per UTC day for every open position and resets the day's starting equity. */
  rolloverIfNeeded(): boolean {
    const today = utcDay(this.clock());
    if (today === this.state.lastRolloverDay) return false;
    let total = 0;
    for (const pos of this.state.positions) {
      const spec = this.market.spec(pos.symbol);
      const mid = this.market.mid(pos.symbol);
      if (!spec || mid <= 0) continue;
      const rate = pos.side === 'buy' ? spec.swapLongPct : spec.swapShortPct;
      const notional = requiredMargin(spec, pos.volume, mid, 1, this.lookup);
      const amount = (notional * rate) / 100;
      pos.swap += amount;
      this.state.balance += amount;
      total += amount;
    }
    if (total !== 0) this.ledgerEntry('swap', total, 'Daily swap rollover');
    this.state.lastRolloverDay = today;
    this.state.dayStartEquity = this.summary().equity;
    this.notice('info', `Daily rollover applied${total !== 0 ? `: swap ${total >= 0 ? '+' : '-'}$${Math.abs(total).toFixed(2)}` : ''}`);
    return true;
  }

  // ---------------------------------------------------------------- internals

  private tryOpen(a: {
    id: number;
    symbol: string;
    side: Side;
    volume: number;
    entry: number;
    sl: number | null;
    tp: number | null;
    source: OrderSource;
    comment: string;
  }): Result<Position> {
    const spec = this.market.spec(a.symbol);
    if (!spec) return fail(`Unknown symbol ${a.symbol}`);
    const s = this.summary();
    if (s.equity <= 0) return fail('Account equity is not positive');
    const leverage = this.state.settings.leverage;
    const marginReq = requiredMargin(spec, a.volume, a.entry, leverage, this.lookup);
    const commission = ACCOUNT_TYPES[this.state.settings.accountType].commissionPerLot * a.volume;
    if (marginReq + commission > s.freeMargin + 1e-9) {
      return fail(
        `Not enough free margin: need $${(marginReq + commission).toFixed(2)}, available $${Math.max(0, s.freeMargin).toFixed(2)}`,
      );
    }
    const projectedMargin = s.margin + marginReq;
    const projectedEquity = s.equity - commission;
    if (projectedMargin > 0 && (projectedEquity / projectedMargin) * 100 < MARGIN_CALL_LEVEL) {
      return fail(`Margin level would fall below ${MARGIN_CALL_LEVEL}%`);
    }
    const pos: Position = {
      id: a.id,
      symbol: a.symbol,
      side: a.side,
      volume: a.volume,
      openPrice: a.entry,
      openTime: this.clock(),
      sl: a.sl,
      tp: a.tp,
      margin: marginReq,
      commission: -commission,
      swap: 0,
      source: a.source,
      comment: a.comment,
    };
    this.state.positions.push(pos);
    if (commission > 0) {
      this.state.balance -= commission;
      this.ledgerEntry('commission', -commission, `Commission on open ${a.symbol} ${a.volume} lots`);
    }
    return ok(pos);
  }

  private nextId(): number {
    return this.state.nextId++;
  }

  private recordOrder(order: OrderRecord): void {
    this.state.orders.unshift(order);
    if (this.state.orders.length > LIST_LIMIT) this.state.orders.length = LIST_LIMIT;
  }

  private updateOrder(id: number, patch: { status: OrderStatus; message: string; fillPrice?: number }): void {
    const order = this.state.orders.find((o) => o.id === id);
    if (!order) return;
    order.status = patch.status;
    order.message = patch.message;
    if (patch.fillPrice !== undefined) order.fillPrice = patch.fillPrice;
    order.updatedAt = this.clock();
  }

  private pushHistory(trade: ClosedTrade): void {
    this.state.history.unshift(trade);
    if (this.state.history.length > LIST_LIMIT) this.state.history.length = LIST_LIMIT;
  }

  private ledgerEntry(type: LedgerEntry['type'], amount: number, note: string): void {
    this.state.ledger.unshift({
      id: this.state.nextLedgerId++,
      time: this.clock(),
      type,
      amount,
      balanceAfter: this.state.balance,
      note,
    });
    if (this.state.ledger.length > LIST_LIMIT) this.state.ledger.length = LIST_LIMIT;
  }

  private notice(level: 'info' | 'success' | 'warn' | 'error', message: string, symbol?: string, source?: OrderSource): void {
    this.emit({ type: 'notice', level, message, symbol, source });
  }

  private emit(e: EngineEvent): void {
    this.onEvent(e);
  }
}
