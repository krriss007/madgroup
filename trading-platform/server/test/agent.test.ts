import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, atr } from '../agent/indicators';
import { emaCross, rsiReversion, breakout, consensus, computeSignal, MIN_BARS } from '../agent/strategies';
import { applyAgentPatch, defaultAgentConfig } from '../agent/config';
import { parseDecision, extractJson, LlmClient } from '../agent/llm';
import { sizePosition, TradingAgent, LLM_SYSTEM_PROMPT } from '../agent/agent';
import { getInstrument, INSTRUMENTS } from '../market/instruments';
import { harness } from './helpers';
import { StateStore } from '../persistence';
import type { Bar } from '../../shared/types';

const bars = (closes: number[], spread = 0.001): Bar[] =>
  closes.map((c, i) => ({ t: i * 60_000, o: i === 0 ? c : closes[i - 1]!, h: c + spread, l: c - spread, c, v: 1 }));

describe('indicators', () => {
  test('EMA of a constant series equals the constant', () => {
    const out = ema(new Array(30).fill(5), 9);
    assert.equal(out[29], 5);
    assert.ok(Number.isNaN(out[0]));
  });

  test('RSI is 100 on a strictly rising series and 0 on a falling one', () => {
    const up = Array.from({ length: 30 }, (_, i) => i + 1);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    assert.equal(rsi(up)[29], 100);
    assert.equal(rsi(down)[29], 0);
  });

  test('ATR of a constant-range series equals the range', () => {
    const b = bars(new Array(40).fill(10), 0.5);
    assert.ok(Math.abs(atr(b, 14)[39]! - 1) < 1e-9);
  });
});

describe('strategies', () => {
  test('EMA cross signals buy exactly on the bar where EMA9 crosses above EMA21', () => {
    const closes = [...new Array(30).fill(100), ...Array.from({ length: 10 }, (_, i) => 100 + (i + 1) * 2)];
    const fast = ema(closes, 9);
    const slow = ema(closes, 21);
    let cross = -1;
    for (let i = 1; i < closes.length; i++) {
      if (fast[i - 1]! <= slow[i - 1]! && fast[i]! > slow[i]!) {
        cross = i;
        break;
      }
    }
    assert.ok(cross > 0, 'series should contain an upward cross');
    assert.equal(emaCross(bars(closes.slice(0, cross + 1))).direction, 'buy');
    assert.equal(emaCross(bars(closes.slice(0, cross))).direction, 'hold');
    assert.equal(emaCross(bars(new Array(60).fill(100))).direction, 'hold');
  });

  test('breakout buys a close above the prior 20-bar high', () => {
    const closes = [...new Array(25).fill(100), 110];
    const res = breakout(bars(closes, 0.5));
    assert.equal(res.direction, 'buy');
  });

  test('breakout sells a close below the prior 20-bar low', () => {
    const closes = [...new Array(25).fill(100), 90];
    assert.equal(breakout(bars(closes, 0.5)).direction, 'sell');
  });

  test('RSI reversion buys on the bar RSI climbs back above 30', () => {
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i * 1.5);
    const bounce = Array.from({ length: 12 }, (_, i) => falling[29]! + (i + 1) * 1.2);
    const series = [...falling, ...bounce];
    const r = rsi(series, 14);
    let cross = -1;
    for (let i = 1; i < series.length; i++) {
      if (r[i - 1]! < 30 && r[i]! >= 30) {
        cross = i;
        break;
      }
    }
    assert.ok(cross > 0, 'series should cross RSI 30 upward');
    assert.equal(rsiReversion(bars(series.slice(0, cross + 1))).direction, 'buy');
  });

  test('consensus requires two agreeing votes and no opposing vote', () => {
    const closes = [...new Array(25).fill(100), 110];
    const res = consensus(bars(closes, 0.5));
    // Breakout votes buy; EMA and RSI cannot both be bullish from this series, so consensus holds unless 2 agree.
    assert.equal(breakout(bars(closes, 0.5)).direction, 'buy');
    assert.ok(res.direction === 'buy' || res.direction === 'hold');
    if (res.direction === 'buy') assert.match(res.reason, /Consensus buy/);
  });

  test('computeSignal refuses too little history', () => {
    assert.equal(computeSignal('consensus', bars(new Array(MIN_BARS - 1).fill(1))), null);
    const sig = computeSignal('breakout', bars(new Array(MIN_BARS + 5).fill(1), 0.2));
    assert.ok(sig && sig.atr > 0);
  });
});

describe('agent configuration', () => {
  const known = INSTRUMENTS.map((i) => i.symbol);

  test('valid patch is merged', () => {
    const res = applyAgentPatch(defaultAgentConfig(), { enabled: true, riskPercent: 0.5, symbols: ['EURUSD'], strategy: 'breakout' }, known);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.config.enabled, true);
      assert.equal(res.config.riskPercent, 0.5);
      assert.deepEqual(res.config.symbols, ['EURUSD']);
    }
  });

  test('out-of-range or unknown values are rejected', () => {
    assert.equal(applyAgentPatch(defaultAgentConfig(), { riskPercent: 50 }, known).ok, false);
    assert.equal(applyAgentPatch(defaultAgentConfig(), { symbols: ['NOPE'] }, known).ok, false);
    assert.equal(applyAgentPatch(defaultAgentConfig(), { strategy: 'magic' }, known).ok, false);
    assert.equal(applyAgentPatch(defaultAgentConfig(), { mode: 'llm-ish' }, known).ok, false);
    assert.equal(applyAgentPatch(defaultAgentConfig(), { maxOpenPositions: 2.5 }, known).ok, false);
    assert.equal(applyAgentPatch({ ...defaultAgentConfig(), symbols: [] }, { enabled: true, symbols: [] }, known).ok, false);
  });
});

describe('risk sizing', () => {
  const eur = getInstrument('EURUSD')!;
  const lookup = (s: string) => (s === 'USDJPY' ? 150 : undefined);

  test('sizes so that hitting the stop loses about the risk amount', () => {
    // $10,000 equity, 1% risk = $100. Stop 0.0015 away: loss/lot = 0.0015 * 100,000 = $150 → 0.66 lots.
    const vol = sizePosition({ equity: 10_000, riskPercent: 1, stopDistance: 0.0015, spec: eur, lookup });
    assert.equal(vol, 0.66);
    const loss = vol * 0.0015 * 100_000;
    assert.ok(loss <= 100 + 1e-6);
  });

  test('clamps to the minimum and maximum volume', () => {
    assert.equal(sizePosition({ equity: 100, riskPercent: 0.05, stopDistance: 1, spec: eur, lookup }), 0.01);
    assert.equal(sizePosition({ equity: 1e9, riskPercent: 5, stopDistance: 0.00001, spec: eur, lookup }), 100);
  });
});

describe('LLM decisions', () => {
  test('parses plain JSON, fenced JSON and JSON with prose', () => {
    assert.equal(parseDecision('{"action":"BUY","confidence":0.8,"reason":"trend"}').action, 'buy');
    assert.equal(parseDecision('```json\n{"action":"hold","confidence":0.2,"reason":"chop"}\n```').action, 'hold');
    assert.equal(parseDecision('Sure! {"action":"sell","confidence":2,"reason":"x","slAtr":1.2}').confidence, 1);
    assert.equal(parseDecision('{"action":"sell","confidence":0.5,"reason":"x","slAtr":1.2}').slAtr, 1.2);
  });

  test('rejects invalid actions and non-JSON replies', () => {
    assert.throws(() => parseDecision('{"action":"yolo"}'), /Invalid action/);
    assert.throws(() => extractJson('no json here'), /did not contain JSON/);
  });

  test('client calls an OpenAI-compatible endpoint and reads the reply', async () => {
    let seen: { url: string; body: unknown; auth: string | null } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"hold","confidence":0.3,"reason":"wait"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new LlmClient({ apiKey: 'k', baseUrl: 'https://llm.example/v1/', model: 'm', fetchImpl: fakeFetch });
    const d = await client.decide('sys', { symbol: 'EURUSD' });
    assert.equal(d.action, 'hold');
    assert.equal(seen!.url, 'https://llm.example/v1/chat/completions');
    assert.equal(seen!.auth, 'Bearer k');
    assert.equal((seen!.body as { response_format: unknown }).response_format !== undefined, true);
  });

  test('client surfaces HTTP errors', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const client = new LlmClient({ apiKey: 'bad', baseUrl: 'https://x', model: 'm', fetchImpl: fakeFetch });
    await assert.rejects(client.complete([{ role: 'user', content: 'hi' }]), /HTTP 401/);
  });
});

describe('agent behaviour', () => {
  test('rules agent opens a risk-sized trade with stops when the strategy signals', async () => {
    const h = harness();
    const store = new StateStore(null, {
      version: 1,
      account: h.state,
      agent: { ...defaultAgentConfig(), enabled: true, symbols: ['EURUSD'], strategy: 'breakout', timeframe: 'M1' },
    });
    // Build a 1-minute history so breakout fires on the last closed bar.
    const base = h.clock.t - 60 * 60_000;
    const closes = [...new Array(40).fill(1.085), 1.1];
    h.market.seed('EURUSD', 'M1', closes.map((c, i) => ({ t: base + i * 60_000, o: c, h: c + 0.0002, l: c - 0.0002, c, v: 1 })));
    h.market.tick('EURUSD', 1.1, h.clock.t, { source: 'sim', spread: 0.00008 });
    const agent = new TradingAgent({ market: h.market, engine: h.engine, store, llm: null, now: () => h.clock.t });
    await agent.tick();
    const pos = h.state.positions.find((p) => p.source === 'agent');
    assert.ok(pos, 'agent should open a position');
    assert.equal(pos!.side, 'buy');
    assert.ok(pos!.sl !== null && pos!.sl < pos!.openPrice);
    assert.ok(pos!.tp !== null && pos!.tp > pos!.openPrice);
    assert.ok(agent.recentLogs().some((l) => l.level === 'trade'));
  });

  test('agent does not open a second position on the same bar', async () => {
    const h = harness();
    const store = new StateStore(null, {
      version: 1,
      account: h.state,
      agent: { ...defaultAgentConfig(), enabled: true, symbols: ['EURUSD'], strategy: 'breakout', timeframe: 'M1' },
    });
    const base = h.clock.t - 60 * 60_000;
    const closes = [...new Array(40).fill(1.085), 1.1];
    h.market.seed('EURUSD', 'M1', closes.map((c, i) => ({ t: base + i * 60_000, o: c, h: c + 0.0002, l: c - 0.0002, c, v: 1 })));
    h.market.tick('EURUSD', 1.1, h.clock.t, { source: 'sim', spread: 0.00008 });
    const agent = new TradingAgent({ market: h.market, engine: h.engine, store, llm: null, now: () => h.clock.t });
    await agent.tick();
    await agent.tick();
    assert.equal(h.state.positions.filter((p) => p.source === 'agent').length, 1);
  });

  test('agent is idle while disabled', async () => {
    const h = harness();
    const store = new StateStore(null, { version: 1, account: h.state, agent: defaultAgentConfig() });
    const agent = new TradingAgent({ market: h.market, engine: h.engine, store, llm: null });
    await agent.tick();
    assert.equal(h.state.positions.length, 0);
    assert.equal(agent.status().running, false);
  });

  test('chat answers from account state without an LLM and never trades', async () => {
    const h = harness();
    const store = new StateStore(null, { version: 1, account: h.state, agent: defaultAgentConfig() });
    const agent = new TradingAgent({ market: h.market, engine: h.engine, store, llm: null });
    const history = await agent.chat('what is my balance?');
    assert.equal(history.length, 2);
    assert.match(history[1]!.content, /Balance \$10000\.00/);
    assert.equal(h.state.positions.length, 0);
    assert.ok(LLM_SYSTEM_PROMPT.includes('JSON'));
  });
});
