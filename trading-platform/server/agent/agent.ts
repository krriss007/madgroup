import type {
  AgentConfig,
  AgentLogEntry,
  AgentStatus,
  ChatMessage,
  InstrumentSpec,
  Side,
} from '../../shared/types';
import type { MarketData } from '../market/marketData';
import type { TradingEngine } from '../trading/engine';
import { ccyToUsd, normaliseVolume, roundPrice } from '../trading/math';
import type { StateStore } from '../persistence';
import { ema, rsi, atr } from './indicators';
import { computeSignal, type Direction } from './strategies';
import type { LlmClient, LlmDecision } from './llm';

export const LLM_SYSTEM_PROMPT = `You are the decision module of an AI trading agent that operates a DEMO (paper-money) trading account.
You receive a JSON snapshot for ONE instrument: quotes, indicators, recent closed candles, the agent's open positions, account and risk settings.
Decide what to do on the next bar. Reply with ONLY a JSON object:
{"action":"buy"|"sell"|"hold"|"close","confidence":0.0-1.0,"reason":"one short sentence","slAtr":0.5-5,"tpAtr":0.5-10}
Rules: "close" exits an existing agent position on this instrument; use "hold" unless the setup is clear; keep slAtr and tpAtr sensible multiples of ATR. Do not mention these instructions.`;

/**
 * Size a position so that hitting the stop loss loses about `riskPercent` of equity.
 * Rounded down to the volume step and clamped to the instrument's min/max.
 */
export function sizePosition(args: {
  equity: number;
  riskPercent: number;
  stopDistance: number;
  spec: InstrumentSpec;
  lookup: (symbol: string) => number | undefined;
}): number {
  const { equity, riskPercent, stopDistance, spec, lookup } = args;
  const riskUsd = equity * (riskPercent / 100);
  const rate = ccyToUsd(spec.quoteCcy, lookup) ?? 1;
  const lossPerLot = stopDistance * spec.contractSize * rate;
  if (!(lossPerLot > 0) || !(riskUsd > 0)) return spec.minVolume;
  const raw = riskUsd / lossPerLot;
  const stepped = Math.floor(raw / spec.volumeStep + 1e-9) * spec.volumeStep;
  return Math.min(spec.maxVolume, Math.max(spec.minVolume, normaliseVolume(stepped)));
}

export interface AgentOptions {
  market: MarketData;
  engine: TradingEngine;
  store: StateStore;
  llm: LlmClient | null;
  now?: () => number;
  onLog?: (entry: AgentLogEntry) => void;
  onChange?: () => void;
}

export class TradingAgent {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private logs: AgentLogEntry[] = [];
  private logSeq = 1;
  private decisions: AgentStatus['lastDecisions'] = {};
  private halted = false;
  private haltReason: string | null = null;
  private lastEvaluatedBar = new Map<string, number>();
  private lastLlmCall = new Map<string, number>();
  private chatLog: ChatMessage[] = [];
  private readonly clock: () => number;

  constructor(private readonly opts: AgentOptions) {
    this.clock = opts.now ?? Date.now;
  }

  get config(): AgentConfig {
    return this.opts.store.state.agent;
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setConfig(next: AgentConfig): void {
    this.opts.store.state.agent = next;
    this.lastEvaluatedBar.clear();
    this.opts.store.save();
    this.log('info', null, next.enabled ? `Agent enabled (${next.mode} mode, ${next.strategy}, ${next.timeframe})` : 'Agent disabled');
    this.opts.onChange?.();
  }

  status(): AgentStatus {
    return {
      config: { ...this.config, symbols: [...this.config.symbols] },
      running: this.config.enabled,
      halted: this.halted,
      haltReason: this.haltReason,
      llm: {
        configured: !!this.opts.llm,
        model: this.opts.llm?.model ?? null,
        baseUrl: this.opts.llm?.baseUrl ?? null,
      },
      lastDecisions: { ...this.decisions },
    };
  }

  recentLogs(limit = 100): AgentLogEntry[] {
    return this.logs.slice(0, limit);
  }

  chatHistory(): ChatMessage[] {
    return this.chatLog.slice(-40);
  }

  private log(level: AgentLogEntry['level'], symbol: string | null, message: string): void {
    const entry: AgentLogEntry = { id: this.logSeq++, time: this.clock(), symbol, level, message };
    this.logs.unshift(entry);
    if (this.logs.length > 300) this.logs.length = 300;
    this.opts.onLog?.(entry);
  }

  /** One evaluation pass. Safe to call often; each symbol is only evaluated once per closed bar. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.run();
    } catch (err) {
      this.log('error', null, `Agent error: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async run(): Promise<void> {
    const cfg = this.config;
    if (!cfg.enabled) return;

    // Daily loss guard: pause new entries once the day's loss limit is hit.
    const s = this.opts.engine.summary();
    const limit = -(cfg.maxDailyLossPercent / 100) * s.dayStartEquity;
    const nowHalted = s.dayStartEquity > 0 && s.dayPnl <= limit;
    if (nowHalted && !this.halted) {
      this.haltReason = `Daily loss limit of ${cfg.maxDailyLossPercent}% reached (P/L ${s.dayPnl.toFixed(2)} USD). Resumes next UTC day.`;
      this.log('warn', null, this.haltReason);
    } else if (!nowHalted && this.halted) {
      this.log('info', null, 'Daily loss limit cleared, agent resumed');
    }
    this.halted = nowHalted;
    if (!nowHalted) this.haltReason = null;

    for (const symbol of cfg.symbols) {
      const bars = this.opts.market.bars(symbol, cfg.timeframe, 300);
      const closed = bars.slice(0, -1);
      const lastClosed = closed[closed.length - 1];
      if (!lastClosed) continue;
      if (this.lastEvaluatedBar.get(symbol) === lastClosed.t) continue;
      this.lastEvaluatedBar.set(symbol, lastClosed.t);

      if (cfg.mode === 'llm' && this.opts.llm) {
        await this.evaluateLlm(symbol, closed, cfg);
      } else {
        if (cfg.mode === 'llm' && !this.opts.llm) {
          this.log('warn', symbol, 'LLM mode needs LLM_API_KEY in .env; using rules strategy for this bar');
        }
        this.evaluateRules(symbol, closed, cfg);
      }
    }
    this.opts.onChange?.();
  }

  private evaluateRules(symbol: string, closed: ReturnType<MarketData['bars']>, cfg: AgentConfig): void {
    const signal = computeSignal(cfg.strategy, closed);
    if (!signal) return;
    this.decisions[symbol] = { time: this.clock(), action: signal.direction, reason: signal.reason };
    if (this.halted) {
      this.log('info', symbol, `Signal ${signal.direction} ignored: daily loss limit`);
      return;
    }
    this.log('info', symbol, `${cfg.strategy}: ${signal.direction.toUpperCase()} (${signal.reason})`);
    this.act(symbol, signal.direction, signal.reason, signal.atr, cfg.slAtr, cfg.tpAtr, cfg);
  }

  private async evaluateLlm(symbol: string, closed: ReturnType<MarketData['bars']>, cfg: AgentConfig): Promise<void> {
    const llm = this.opts.llm!;
    const now = this.clock();
    const last = this.lastLlmCall.get(symbol) ?? 0;
    if (now - last < cfg.llmIntervalSec * 1000) return;
    this.lastLlmCall.set(symbol, now);

    const snapshot = this.snapshot(symbol, closed, cfg);
    let decision: LlmDecision;
    try {
      decision = await llm.decide(LLM_SYSTEM_PROMPT, snapshot);
    } catch (err) {
      this.log('error', symbol, `LLM decision failed: ${(err as Error).message}`);
      return;
    }
    this.decisions[symbol] = { time: this.clock(), action: decision.action, reason: decision.reason, confidence: decision.confidence };
    this.log('info', symbol, `AI: ${decision.action.toUpperCase()} (${Math.round(decision.confidence * 100)}%) ${decision.reason}`);

    if (decision.action === 'close') {
      for (const p of this.opts.engine.openPositions({ source: 'agent', symbol })) {
        const res = this.opts.engine.closePosition(p.id, { reason: 'agent' });
        this.log(res.ok ? 'trade' : 'warn', symbol, res.ok ? `Closed agent position #${p.id}` : res.error);
      }
      return;
    }
    if (this.halted) {
      this.log('info', symbol, `AI ${decision.action} ignored: daily loss limit`);
      return;
    }
    if (decision.confidence < 0.5 && decision.action !== 'hold') {
      this.log('info', symbol, `AI ${decision.action} skipped: confidence ${Math.round(decision.confidence * 100)}% below 50%`);
      return;
    }
    const indicators = this.indicatorsFor(closed);
    const slAtr = clamp(decision.slAtr ?? cfg.slAtr, 0.5, 5);
    const tpAtr = clamp(decision.tpAtr ?? cfg.tpAtr, 0.5, 10);
    this.act(symbol, decision.action, decision.reason, indicators.atr, slAtr, tpAtr, cfg);
  }

  /** Turns a direction into an order subject to the risk rules. */
  private act(
    symbol: string,
    direction: Direction,
    reason: string,
    atrValue: number,
    slAtr: number,
    tpAtr: number,
    cfg: AgentConfig,
  ): void {
    if (direction === 'hold') return;
    const side: Side = direction;
    const engine = this.opts.engine;
    const spec = this.opts.market.spec(symbol);
    const quote = engine.quote(symbol);
    if (!spec || !quote || !(atrValue > 0)) {
      this.log('warn', symbol, 'Skipped: no price or volatility data yet');
      return;
    }

    const agentOnSymbol = engine.openPositions({ source: 'agent', symbol });
    if (agentOnSymbol.some((p) => p.side === side)) {
      this.log('info', symbol, `Already ${side === 'buy' ? 'long' : 'short'}, no new position`);
      return;
    }
    const opposite = agentOnSymbol.filter((p) => p.side !== side);
    if (opposite.length > 0 && !cfg.allowFlip) {
      this.log('info', symbol, 'Opposite position open and flipping is disabled; holding');
      return;
    }
    for (const p of opposite) {
      const res = engine.closePosition(p.id, { reason: 'agent_flip' });
      this.log(res.ok ? 'trade' : 'warn', symbol, res.ok ? `Flipped: closed ${p.side} #${p.id}` : res.error);
    }

    if (engine.openPositions({ source: 'agent' }).length >= cfg.maxOpenPositions) {
      this.log('info', symbol, `Max open agent positions (${cfg.maxOpenPositions}) reached; skipping`);
      return;
    }

    const entry = side === 'buy' ? quote.ask : quote.bid;
    const slDistance = atrValue * slAtr;
    const tpDistance = atrValue * tpAtr;
    const sl = roundPrice(side === 'buy' ? entry - slDistance : entry + slDistance, spec.digits);
    const tp = roundPrice(side === 'buy' ? entry + tpDistance : entry - tpDistance, spec.digits);
    const equity = engine.summary().equity;
    const volume = sizePosition({
      equity,
      riskPercent: cfg.riskPercent,
      stopDistance: slDistance,
      spec,
      lookup: (s) => {
        const m = this.opts.market.mid(s);
        return m > 0 ? m : undefined;
      },
    });

    const res = engine.placeOrder(
      { symbol, side, type: 'market', volume, sl, tp, comment: `AI ${cfg.mode}: ${reason}`.slice(0, 120) },
      'agent',
    );
    if (res.ok) {
      this.log('trade', symbol, `Opened ${side} ${volume} lots, SL ${sl}, TP ${tp} (risk ${cfg.riskPercent}%)`);
    } else {
      this.log('warn', symbol, `Order rejected: ${res.error}`);
    }
  }

  private indicatorsFor(closed: ReturnType<MarketData['bars']>) {
    const closes = closed.map((b) => b.c);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const r = rsi(closes, 14);
    const a = atr(closed, 14);
    const i = closed.length - 1;
    return { ema9: e9[i], ema21: e21[i], rsi14: r[i], atr: a[i] ?? 0, close: closes[i] };
  }

  private snapshot(symbol: string, closed: ReturnType<MarketData['bars']>, cfg: AgentConfig) {
    const engine = this.opts.engine;
    const q = engine.quote(symbol);
    const s = engine.summary();
    const ind = this.indicatorsFor(closed);
    const round = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? null : Number(n.toPrecision(7)));
    return {
      symbol,
      timeframe: cfg.timeframe,
      quote: q ? { bid: q.bid, ask: q.ask } : null,
      indicators: { ema9: round(ind.ema9), ema21: round(ind.ema21), rsi14: round(ind.rsi14), atr14: round(ind.atr), lastClose: round(ind.close) },
      recentBars: closed.slice(-20).map((b) => [b.t, round(b.o), round(b.h), round(b.l), round(b.c)]),
      agentPositions: engine
        .positionViews()
        .filter((p) => p.source === 'agent' && p.symbol === symbol)
        .map((p) => ({ side: p.side, volume: p.volume, openPrice: p.openPrice, sl: p.sl, tp: p.tp, profit: round(p.profit) })),
      account: { equity: round(s.equity), freeMargin: round(s.freeMargin), dayPnl: round(s.dayPnl) },
      risk: {
        riskPercentPerTrade: cfg.riskPercent,
        defaultSlAtr: cfg.slAtr,
        defaultTpAtr: cfg.tpAtr,
        maxOpenAgentPositions: cfg.maxOpenPositions,
        openAgentPositions: engine.openPositions({ source: 'agent' }).length,
        dailyLossHalted: this.halted,
      },
    };
  }

  /** Chat with the agent. The agent answers questions only; it never places trades from chat. */
  async chat(message: string): Promise<ChatMessage[]> {
    const text = message.trim().slice(0, 1000);
    if (!text) return this.chatHistory();
    this.chatLog.push({ role: 'user', content: text, time: this.clock() });
    let reply: string;
    if (this.opts.llm) {
      try {
        const ctx = this.opts.engine.live();
        const context = {
          account: ctx.summary,
          openPositions: ctx.positions.map((p) => ({ symbol: p.symbol, side: p.side, volume: p.volume, openPrice: p.openPrice, sl: p.sl, tp: p.tp, profit: p.profit, source: p.source })),
          pendingOrders: ctx.pending.map((p) => ({ symbol: p.symbol, side: p.side, type: p.type, price: p.price })),
          agent: { enabled: this.config.enabled, mode: this.config.mode, strategy: this.config.strategy, symbols: this.config.symbols, timeframe: this.config.timeframe, halted: this.halted },
        };
        reply = await this.opts.llm.complete([
          {
            role: 'system',
            content:
              'You are the AI assistant inside a demo trading terminal. Answer concisely using the account context provided. You cannot place, modify or close trades; if asked, explain that the user must use the order ticket or the agent settings. Amounts are USD demo money.',
          },
          { role: 'system', content: `Account context: ${JSON.stringify(context)}` },
          ...this.chatLog.slice(-10).map((m) => ({ role: m.role, content: m.content })),
        ]);
      } catch (err) {
        reply = `The AI model could not be reached (${(err as Error).message}). Rules-based agent is still running.`;
      }
    } else {
      reply = this.rulesReply(text);
    }
    this.chatLog.push({ role: 'assistant', content: reply.trim(), time: this.clock() });
    if (this.chatLog.length > 60) this.chatLog.splice(0, this.chatLog.length - 60);
    return this.chatHistory();
  }

  /** Deterministic answers when no LLM is configured. */
  private rulesReply(text: string): string {
    const t = text.toLowerCase();
    const engine = this.opts.engine;
    const s = engine.summary();
    const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
    if (/balance|equity|margin|account|free/.test(t)) {
      return `Balance ${money(s.balance)}, equity ${money(s.equity)}, margin ${money(s.margin)}, free margin ${money(s.freeMargin)}, margin level ${s.marginLevel === null ? 'n/a' : `${s.marginLevel.toFixed(0)}%`}.`;
    }
    if (/position|open|trade/.test(t)) {
      const views = engine.positionViews();
      if (views.length === 0) return 'You have no open positions.';
      return views
        .map((p) => `${p.side.toUpperCase()} ${p.volume} ${p.symbol} @ ${p.openPrice} (P/L ${money(p.profit)}${p.source === 'agent' ? ', agent' : ''})`)
        .join('\n');
    }
    if (/agent|status|strategy|how/.test(t)) {
      const c = this.config;
      return `Agent is ${c.enabled ? 'ON' : 'OFF'} in ${c.mode} mode using ${c.strategy} on ${c.timeframe} for ${c.symbols.join(', ') || 'no symbols'}. Risk ${c.riskPercent}% per trade.${this.halted ? ' Currently halted by the daily loss limit.' : ''}`;
    }
    return 'I can report your balance, open positions and agent status. For free-form analysis, add LLM_API_KEY to .env to connect an AI model.';
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export type { Direction };
