// ---------------------------------------------------------------------------
// Paper-trading engine.
//
// HARD RULE (v1): this engine NEVER contacts an exchange to place orders.
// Every "order" below is a simulated fill against market-data prices, with
// estimated fees and slippage deducted. Balances are fictional.
//
// Design notes
//  * Signals are evaluated once per CLOSED candle of the bot target
//    (no lookahead, no repainting). A candle is never evaluated twice
//    (duplicate-order prevention at the signal level).
//  * Protective exits (SL/TP) are checked every tick against the latest
//    price, even while PAUSED - pausing stops new signals, not protection.
//  * STOPPED freezes everything (no evaluation, no exits).
//  * KILLED (emergency stop) force-closes every position and halts until
//    the user explicitly resets the simulator.
// ---------------------------------------------------------------------------
import { evaluateStrategy } from './strategy.js';
import { gateEntry, checkDailyLoss } from './risk.js';
import { logSignal, logOrder, logRisk, logSystem, logError } from './logger.js';
import { defaultEngineConfig, configLimits } from './config.js';
import { tfMs } from './data/databus.js';

const BPS = 10_000;
const now = () => Date.now();
const round8 = (x) => Math.round(x * 1e8) / 1e8;
const round2 = (x) => Math.round(x * 100) / 100;

export class PaperEngine {
  constructor(bus, store, { config } = {}) {
    this.bus = bus;
    this.store = store;
    this.config = { ...defaultEngineConfig, ...(config || {}) };
    this.state = this.freshState();
    this.tickTimer = null;
    this.ticking = false;
    const saved = store?.load();
    if (saved && saved.v === 1) this.restore(saved);
  }

  // ------------------------------------------------------------- state ----
  freshState() {
    const day = new Date().toISOString().slice(0, 10);
    return {
      v: 1,
      bot: { status: 'IDLE', target: null, startedAt: null, haltReason: null },
      config: { ...this.config },
      account: {
        startBalance: this.config.startBalance,
        cash: this.config.startBalance,
        dayKey: day,
        dayStartEquity: this.config.startBalance,
      },
      risk: { dayHalted: false, lastLossAt: null, lastBlock: null, killActive: false },
      positions: [], // open simulated positions
      trades: [],    // closed simulated trades (newest last)
      processed: {}, // "symbol|tf" -> last processed closed-candle time
      seq: 1,
    };
  }

  restore(saved) {
    try {
      this.state = saved;
      this.config = { ...defaultEngineConfig, ...saved.config };
      // A restart must never silently resume an autonomous bot.
      if (this.state.bot.status === 'RUNNING') {
        this.state.bot.status = 'PAUSED';
        this.state.bot.haltReason = 'Paused automatically on server restart - press Resume.';
        logSystem('Bot restored as PAUSED after restart (never auto-resumes).');
      }
    } catch (err) {
      logError(`State restore failed, starting fresh: ${err.message}`);
      this.state = this.freshState();
    }
  }

  persist() {
    this.store?.scheduleSave(() => this.state);
  }

  // ------------------------------------------------------- bot controls ----
  start(target) {
    const st = this.state;
    if (st.bot.status === 'KILLED') {
      logRisk('Start refused - emergency stop active. Reset required.', {});
      return { error: 'Emergency stop is active. Use Reset to start over.' };
    }
    st.bot.target = { symbol: target.symbol, tf: target.tf };
    st.bot.status = 'RUNNING';
    st.bot.startedAt = now();
    st.bot.haltReason = null;
    logSystem(`Bot started (paper mode) - target ${target.symbol} @ ${target.tf}`, { target });
    this.rollDayIfNeeded();
    this.persist();
    return { ok: true };
  }

  pause() {
    const st = this.state;
    if (st.bot.status !== 'RUNNING') return { error: 'Bot is not running.' };
    st.bot.status = 'PAUSED';
    logSystem('Bot paused - new signals suspended, protective exits stay active.', {});
    this.persist();
    return { ok: true };
  }

  resume() {
    const st = this.state;
    if (st.bot.status !== 'PAUSED') return { error: 'Bot is not paused.' };
    if (st.risk.dayHalted) return { error: 'Daily loss limit active - entries resume next UTC day.' };
    if (st.risk.killActive) return { error: 'Emergency stop active - Reset required.' };
    st.bot.status = 'RUNNING';
    st.bot.haltReason = null;
    logSystem('Bot resumed.', {});
    this.persist();
    return { ok: true };
  }

  stop() {
    const st = this.state;
    if (st.bot.status === 'KILLED') return { error: 'Emergency stop already active.' };
    st.bot.status = 'STOPPED';
    st.bot.haltReason = 'Stopped by user. Positions remain open and are NOT being managed.';
    logSystem('Bot stopped by user - positions left untouched (not managed while stopped).', {});
    this.persist();
    return { ok: true };
  }

  async kill() {
    const st = this.state;
    st.bot.status = 'KILLED';
    st.risk.killActive = true;
    st.bot.haltReason = 'EMERGENCY STOP - all positions force-closed. Reset required to continue.';
    logRisk('EMERGENCY STOP engaged - force-closing all paper positions.', {});
    for (const p of [...st.positions]) {
      await this.closePosition(p, 'EMERGENCY');
    }
    this.persist();
    return { ok: true };
  }

  reset() {
    this.config = { ...defaultEngineConfig, ...this.configOverridesOnReset() };
    this.state = this.freshState();
    logSystem('Simulator reset - balance, positions, trades and risk state restored to defaults.', {});
    this.persist();
    return { ok: true };
  }

  configOverridesOnReset() {
    // Keep user-tuned risk numbers across a reset except the balance knob,
    // which resets the simulated account to its default start balance.
    return { startBalance: defaultEngineConfig.startBalance };
  }

  // -------------------------------------------------------- validation ----
  updateConfig(patch = {}) {
    const st = this.state;
    const applied = {};
    const rejected = {};
    for (const [key, raw] of Object.entries(patch)) {
      const lim = configLimits[key];
      if (!lim) {
        rejected[key] = 'unknown setting';
        continue;
      }
      let v = Number(raw);
      if (!Number.isFinite(v)) {
        rejected[key] = 'must be a number';
        continue;
      }
      if (lim.int) v = Math.round(v);
      const clamped = Math.min(lim.max, Math.max(lim.min, v));
      if (key === 'fastEma' && this.config.slowEma <= clamped) {
        rejected[key] = 'fast EMA must stay below slow EMA';
        continue;
      }
      if (key === 'slowEma' && this.config.fastEma >= clamped) {
        rejected[key] = 'slow EMA must stay above fast EMA';
        continue;
      }
      this.config[key] = clamped;
      st.config[key] = clamped;
      applied[key] = clamped;
    }
    if (Object.keys(applied).length) {
      logSystem('Configuration updated', applied);
      this.persist();
    }
    return { applied, rejected, config: { ...this.config } };
  }

  // ------------------------------------------------------------- ticks ----
  startTicking(intervalMs = 5000) {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => logError(`Tick failed: ${err.message}`));
    }, intervalMs);
    this.tickTimer.unref?.();
  }

  async tick() {
    const st = this.state;
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.rollDayIfNeeded();

      // Protective exit management runs while RUNNING or PAUSED.
      if (st.bot.status === 'RUNNING' || st.bot.status === 'PAUSED') {
        await this.manageExits();
      }

      // Daily loss limit check (equity mark-to-market).
      const equity = await this.equity();
      const { halted } = checkDailyLoss(this.config, st.account, equity, now());
      if (halted && !st.risk.dayHalted) {
        st.risk.dayHalted = true;
        if (st.bot.status === 'RUNNING') {
          st.bot.status = 'PAUSED';
          st.bot.haltReason = 'Daily loss limit reached - new entries halted until next UTC day.';
        }
        this.persist();
      }

      // Signal evaluation only while RUNNING.
      if (st.bot.status === 'RUNNING' && st.bot.target) {
        await this.evaluateTarget();
      }
    } finally {
      this.ticking = false;
    }
  }

  rollDayIfNeeded() {
    const st = this.state;
    const day = new Date().toISOString().slice(0, 10);
    if (st.account.dayKey !== day) {
      // async equity not needed for a decent approximation at rollover:
      st.account.dayKey = day;
      st.account.dayStartEquity = st.account.cash + st.positions.reduce(
        (acc, p) => acc + (p.side === 'LONG' ? p.qty * p.entryPrice : p.qty * p.entryPrice), 0
      );
      st.risk.dayHalted = false;
      logSystem(`UTC day rolled over - daily loss budget reset (day-start equity ${round2(st.account.dayStartEquity)}).`, {});
      this.persist();
    }
  }

  async evaluateTarget() {
    const st = this.state;
    const { symbol, tf } = st.bot.target;
    const ms = tfMs(tf);

    const { candles, source } = await this.bus.candles(symbol, tf, 400);
    if (candles.length < Math.max(this.config.slowEma, this.config.rsiPeriod, this.config.atrPeriod) + 5) {
      return; // not enough history yet
    }

    // Consider only CLOSED candles (the last candle may still be forming).
    const closed = candles.filter((c) => c.complete);
    if (!closed.length) return;
    const lastClosed = closed[closed.length - 1];

    const key = `${symbol}|${tf}`;
    if (st.processed[key] === lastClosed.t) return; // already evaluated - no duplicate signals
    st.processed[key] = lastClosed.t;

    const evaluation = evaluateStrategy(closed, this.config);
    logSignal(`${evaluation.action} signal on ${symbol} @ ${tf}`, {
      symbol, tf, action: evaluation.action, candleTime: lastClosed.t,
      price: evaluation.price, crossover: evaluation.crossover,
      indicators: evaluation.indicators, data: String(source).toUpperCase(),
    });

    if (evaluation.action === 'BUY') await this.tryEnter(symbol, tf, evaluation, source);
    else if (evaluation.action === 'SELL') await this.tryExitOnSignal(symbol, evaluation);

    this.persist();
  }

  async tryEnter(symbol, tf, evaluation, source) {
    const st = this.state;
    const equity = await this.equity();
    const decision = gateEntry({
      config: this.config,
      account: st.account,
      equity,
      positions: st.positions,
      symbol,
      now: now(),
      state: st,
    });
    st.risk.lastBlock = decision.allowed ? null : { code: decision.code, reason: decision.reason, ts: now() };
    if (!decision.allowed) return;

    const { feeBps, slippageBps } = this.config;
    const ideal = evaluation.price;
    const fill = round8(ideal * (1 + slippageBps / BPS)); // pay slippage on entry
    const notional = (equity * this.config.positionSizePct) / 100;
    const qty = round8(notional / fill);
    const fee = round8(notional * (feeBps / BPS));

    const pos = {
      id: `pos-${st.seq++}`,
      symbol,
      tf,
      side: 'LONG',
      qty,
      entryPrice: fill,
      entryIdeal: ideal,
      entryTime: now(),
      signalCandle: evaluation.symbolTime,
      stopLoss: evaluation.levels.stopLoss,
      takeProfit: evaluation.levels.takeProfit,
      feeEntry: fee,
      slippageEntry: round8((fill - ideal) * qty),
    };
    st.positions.push(pos);
    st.account.cash = round8(st.account.cash - fee); // notional is "held" in the position

    logOrder(`Simulated OPEN ${pos.side} ${symbol} x${qty} @ ${fill}`, {
      id: pos.id, symbol, tf, side: pos.side, qty, fillPrice: fill,
      idealPrice: ideal, slippageBps, fee, feeBps,
      stopLoss: pos.stopLoss, takeProfit: pos.takeProfit,
      positionSizePct: this.config.positionSizePct, data: source,
    });
    this.persist();
  }

  async tryExitOnSignal(symbol, evaluation) {
    const st = this.state;
    const pos = st.positions.find((p) => p.symbol === symbol);
    if (!pos) return;
    await this.closePosition(pos, 'SIGNAL', evaluation);
  }

  /** Check SL/TP for every open position against the latest price. */
  async manageExits() {
    const st = this.state;
    for (const pos of [...st.positions]) {
      const { price } = await this.bus.lastPrice(pos.symbol, pos.tf);
      if (price == null) continue;
      if (pos.side === 'LONG') {
        if (price <= pos.stopLoss) await this.closePosition(pos, 'STOP_LOSS');
        else if (price >= pos.takeProfit) await this.closePosition(pos, 'TAKE_PROFIT');
      } else {
        if (price >= pos.stopLoss) await this.closePosition(pos, 'STOP_LOSS');
        else if (price <= pos.takeProfit) await this.closePosition(pos, 'TAKE_PROFIT');
      }
    }
  }

  async closePosition(pos, reason, evaluation = null) {
    const st = this.state;
    const idx = st.positions.indexOf(pos);
    if (idx === -1) return;
    st.positions.splice(idx, 1);

    const { price: mark, source: exitSource } = await this.bus.lastPrice(pos.symbol, pos.tf);
    const exitIdeal = mark ?? pos.entryPrice;
    const fill = round8(exitIdeal * (1 - this.config.slippageBps / BPS));
    const exitNotional = pos.qty * fill;
    const feeExit = round8(exitNotional * (this.config.feeBps / BPS));
    const slippageExit = round8((exitIdeal - fill) * pos.qty);

    const gross = pos.side === 'LONG' ? (fill - pos.entryPrice) * pos.qty : (pos.entryPrice - fill) * pos.qty;
    const fees = round8(pos.feeEntry + feeExit);
    const slippageCost = round8(pos.slippageEntry + slippageExit);
    const net = round8(gross - fees - slippageCost);

    st.account.cash = round8(st.account.cash + pos.qty * fill - feeExit);

    const trade = {
      id: `trd-${st.seq++}`,
      positionId: pos.id,
      symbol: pos.symbol,
      tf: pos.tf,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitPrice: fill,
      openedAt: pos.entryTime,
      closedAt: now(),
      grossPnl: round8(gross),
      fees,
      slippageCost,
      netPnl: net,
      exitReason: reason,
    };
    st.trades.push(trade);
    if (st.trades.length > 500) st.trades.splice(0, st.trades.length - 500);

    if (net < 0) st.risk.lastLossAt = now();

    logOrder(`Simulated CLOSE ${pos.side} ${pos.symbol} @ ${fill} (${reason}) net ${net >= 0 ? '+' : ''}${round2(net)}`, {
      id: trade.id, symbol: pos.symbol, tf: pos.tf, side: pos.side, qty: pos.qty,
      exitPrice: fill, idealPrice: exitIdeal, grossPnl: trade.grossPnl,
      fees, slippageCost, netPnl: net, exitReason: reason,
      data: String(exitSource).toUpperCase(),
      ...(reason === 'SIGNAL' && evaluation ? { signalPrice: evaluation.price } : {}),
    });
    this.persist();
  }

  async closePositionById(id, reason = 'MANUAL') {
    const pos = this.state.positions.find((p) => p.id === id);
    if (!pos) return { error: `No open position ${id}` };
    await this.closePosition(pos, reason);
    return { ok: true };
  }

  // ------------------------------------------------------------ metrics ----
  async equity() {
    const st = this.state;
    let eq = st.account.cash;
    for (const pos of st.positions) {
      const { price } = await this.bus.lastPrice(pos.symbol, pos.tf);
      const mark = price ?? pos.entryPrice;
      eq += pos.side === 'LONG' ? pos.qty * mark : pos.qty * (2 * pos.entryPrice - mark);
    }
    return eq;
  }

  async publicState() {
    const st = this.state;
    const equity = await this.equity();
    const positions = [];
    for (const pos of st.positions) {
      const { price } = await this.bus.lastPrice(pos.symbol, pos.tf);
      const mark = price ?? pos.entryPrice;
      const un = pos.side === 'LONG' ? (mark - pos.entryPrice) * pos.qty : (pos.entryPrice - mark) * pos.qty;
      positions.push({
        ...pos,
        markPrice: mark,
        unrealizedPnl: round8(un),
        unrealizedPct: round2(((mark - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === 'LONG' ? 1 : -1)),
      });
    }
    const today = st.trades.filter((t) => new Date(t.closedAt).toISOString().slice(0, 10) === st.account.dayKey);
    return {
      paperTrading: true,
      bot: { ...st.bot },
      config: { ...this.config },
      account: {
        startBalance: st.account.startBalance,
        cash: round2(st.account.cash),
        equity: round2(equity),
        dayStartEquity: round2(st.account.dayStartEquity),
        dayPnl: round2(equity - st.account.dayStartEquity),
        dayPnlPct: round2(((equity - st.account.dayStartEquity) / st.account.dayStartEquity) * 100),
        currency: 'USDT (simulated)',
      },
      risk: {
        ...st.risk,
        dailyLossLimitPct: this.config.dailyLossLimitPct,
        usedPct: round2(Math.max(0, ((st.account.dayStartEquity - equity) / st.account.dayStartEquity) * 100)),
      },
      positions,
      trades: st.trades.slice(-100).reverse(),
      stats: {
        openPositions: positions.length,
        tradesToday: today.length,
        totalTrades: st.trades.length,
        netPnlTotal: round2(st.trades.reduce((a, t) => a + t.netPnl, 0)),
        feesTotal: round2(st.trades.reduce((a, t) => a + t.fees, 0)),
        slippageTotal: round2(st.trades.reduce((a, t) => a + t.slippageCost, 0)),
      },
    };
  }
}
