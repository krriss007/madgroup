import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ACCOUNT_TYPES,
  LEVERAGE_OPTIONS,
  TIMEFRAMES,
  type AgentLogEntry,
  type Bar,
  type ClientMessage,
  type ServerMessage,
  type Timeframe,
} from '../shared/types';
import { INSTRUMENTS } from './market/instruments';
import type { MarketData } from './market/marketData';
import type { TradingEngine } from './trading/engine';
import type { TradingAgent } from './agent/agent';

interface Client {
  ws: WebSocket;
  symbol: string | null;
  tf: Timeframe | null;
  lastBar: Bar | null;
}

export interface RealtimeOptions {
  market: MarketData;
  engine: TradingEngine;
  agent: TradingAgent;
  marketStatus: () => import('../shared/types').MarketStatus;
  /** Milliseconds between price/account pushes. */
  intervalMs?: number;
}

/**
 * WebSocket hub on /ws. Pushes quotes, live account state and forming candles
 * on a timer, and pushes discrete events (fills, toasts, agent logs) immediately.
 */
export class Realtime {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private timer: NodeJS.Timeout | null = null;
  private lastMarketPush = 0;

  constructor(
    server: HttpServer,
    private readonly opts: RealtimeOptions,
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  start(): void {
    const interval = this.opts.intervalMs ?? 500;
    this.timer = setInterval(() => this.pushTick(), interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients) c.ws.close();
    this.wss.close();
  }

  broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const c of this.clients) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, symbol: null, tf: null, lastBar: null };
    this.clients.add(client);
    const { engine, agent } = this.opts;
    this.send(ws, {
      type: 'hello',
      instruments: INSTRUMENTS,
      accountTypes: ACCOUNT_TYPES,
      leverageOptions: LEVERAGE_OPTIONS,
      market: this.opts.marketStatus(),
    });
    this.send(ws, { type: 'quotes', quotes: engine.quotes() });
    this.send(ws, { type: 'account_full', state: engine.full() });
    this.send(ws, { type: 'agent', status: agent.status() });
    this.send(ws, { type: 'agent_logs', entries: agent.recentLogs(100) });

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg?.type === 'subscribe' && this.opts.market.has(msg.symbol) && TIMEFRAMES.includes(msg.tf)) {
        client.symbol = msg.symbol;
        client.tf = msg.tf;
        client.lastBar = null;
        this.pushBarFor(client);
      }
    });
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
  }

  /** Periodic push: quotes, live account, forming candles, market status. */
  pushTick(): void {
    if (this.clients.size === 0) return;
    const { engine } = this.opts;
    this.broadcast({ type: 'quotes', quotes: engine.quotes() });
    this.broadcast({ type: 'account', state: engine.live() });
    for (const c of this.clients) this.pushBarFor(c);
    const now = Date.now();
    if (now - this.lastMarketPush > 5000) {
      this.lastMarketPush = now;
      this.broadcast({ type: 'market', market: this.opts.marketStatus() });
    }
  }

  private pushBarFor(client: Client): void {
    if (!client.symbol || !client.tf) return;
    const bar = this.opts.market.bars(client.symbol, client.tf, 1)[0];
    if (!bar) return;
    const prev = client.lastBar;
    if (prev && prev.t === bar.t && prev.o === bar.o && prev.h === bar.h && prev.l === bar.l && prev.c === bar.c) return;
    client.lastBar = bar;
    this.send(client.ws, { type: 'bar', symbol: client.symbol, tf: client.tf, bar });
  }

  /** Immediate push of an agent log entry. */
  agentLog(entry: AgentLogEntry): void {
    this.broadcast({ type: 'agent_log', entry });
  }
}
