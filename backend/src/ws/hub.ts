/**
 * TradePilot — WebSocket hub.
 *
 * Realtime channels required by the platform:
 *   quotes • account • positions • orders • execution reports • MT5 heartbeat
 *
 * Authentication happens during the HTTP upgrade using the same signed session
 * cookie as the REST API — an unauthenticated socket is rejected before a
 * connection is established. Each client subscribes to its own symbols and is
 * only ever sent data belonging to its user.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import {
  type ClientMessage,
  type Quote,
  type ServerMessage,
  type TradingMode,
  type Timeframe,
} from '@tradepilot/shared';
import type { Logger } from '../lib/logger';
import type { Env } from '../config/env';
import type { RealtimePublisher } from './publisher';
import type { RealtimeService } from '../services/realtime.service';

interface ClientState {
  id: string;
  socket: WebSocket;
  userId: string;
  mode: TradingMode;
  symbols: Set<string>;
  timeframes: Set<Timeframe>;
  channels: Set<string>;
  isAlive: boolean;
  connectedAt: number;
  messageCount: number;
}

export interface WsHubOptions {
  server: Server;
  path: string;
  env: Env;
  logger: Logger;
  authenticate: (request: IncomingMessage) => Promise<{ userId: string } | null>;
  snapshots: RealtimeService;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGES_PER_MINUTE = 600;

export class WsHub implements RealtimePublisher {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, ClientState>();
  private readonly byUser = new Map<string, Set<string>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WsHubOptions) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, path: options.path });
    options.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== options.path) return; // other upgrades are not ours
      void this.handleUpgrade(request, socket as never, head);
    });
  }

  private async handleUpgrade(request: IncomingMessage, socket: never, head: Buffer): Promise<void> {
    const rawSocket = socket as unknown as import('node:net').Socket;
    try {
      const auth = await this.options.authenticate(request);
      if (!auth) {
        rawSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        rawSocket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, rawSocket, head, (ws) => {
        this.register(ws, auth.userId);
      });
    } catch (error) {
      this.options.logger.warn({ error: (error as Error).message }, 'websocket upgrade rejected');
      rawSocket.destroy();
    }
  }

  private register(socket: WebSocket, userId: string): void {
    const id = `${userId}#${Math.random().toString(36).slice(2, 10)}`;
    const state: ClientState = {
      id,
      socket,
      userId,
      mode: 'DEMO',
      symbols: new Set(),
      timeframes: new Set(),
      channels: new Set(['account', 'positions', 'orders', 'connection', 'risk']),
      isAlive: true,
      connectedAt: Date.now(),
      messageCount: 0,
    };
    this.clients.set(id, state);
    const set = this.byUser.get(userId) ?? new Set<string>();
    set.add(id);
    this.byUser.set(userId, set);

    socket.on('message', (data) => void this.onMessage(state, data.toString()));
    socket.on('pong', () => {
      state.isAlive = true;
    });
    socket.on('close', () => this.unregister(state));
    socket.on('error', (error) => {
      this.options.logger.debug({ userId, error: error.message }, 'websocket error');
    });

    void this.sendHello(state);
    this.startHeartbeat();
  }

  private unregister(state: ClientState): void {
    this.clients.delete(state.id);
    const set = this.byUser.get(state.userId);
    set?.delete(state.id);
    if (set && set.size === 0) this.byUser.delete(state.userId);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.isAlive) {
          client.socket.terminate();
          this.unregister(client);
          continue;
        }
        client.isAlive = false;
        try {
          client.socket.ping();
        } catch {
          /* socket already closing */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async sendHello(state: ClientState): Promise<void> {
    try {
      const payload = await this.options.snapshots.build(state.userId, state.mode);
      this.send(state, {
        type: 'hello',
        serverTime: new Date().toISOString(),
        userId: state.userId,
        sessionId: state.id,
        mode: state.mode,
        subscriptions: {
          symbols: [...state.symbols],
          timeframes: [...state.timeframes],
          channels: [...state.channels],
        },
      });
      for (const message of payload) this.send(state, message);
    } catch (error) {
      this.send(state, { type: 'error', code: 'SNAPSHOT_FAILED', message: (error as Error).message });
    }
  }

  private send(state: ClientState, message: ServerMessage): void {
    try {
      if (state.socket.readyState === state.socket.OPEN) {
        state.socket.send(JSON.stringify(message));
      }
    } catch (error) {
      this.options.logger.debug({ error: (error as Error).message }, 'websocket send failed');
    }
  }

  private async onMessage(state: ClientState, raw: string): Promise<void> {
    state.messageCount += 1;
    if (state.messageCount > MAX_MESSAGES_PER_MINUTE) {
      this.send(state, { type: 'error', code: 'RATE_LIMITED', message: 'Too many messages on this socket.' });
      state.socket.close(1008, 'rate limited');
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(state, { type: 'error', code: 'BAD_REQUEST', message: 'Malformed JSON message.' });
      return;
    }

    switch (message.type) {
      case 'ping':
        this.send(state, { type: 'pong', at: new Date().toISOString() });
        break;
      case 'subscribe': {
        const limit = this.options.env.MAX_QUOTE_SUBSCRIPTIONS;
        for (const symbol of message.symbols ?? []) {
          if (state.symbols.size >= limit) break;
          state.symbols.add(symbol.toUpperCase());
        }
        for (const timeframe of message.timeframes ?? []) state.timeframes.add(timeframe);
        for (const channel of message.channels ?? []) state.channels.add(channel);
        this.send(state, {
          type: 'subscribed',
          channels: [...state.channels],
          symbols: [...state.symbols],
        });
        break;
      }
      case 'unsubscribe': {
        for (const symbol of message.symbols ?? []) state.symbols.delete(symbol.toUpperCase());
        for (const channel of message.channels ?? []) state.channels.delete(channel);
        this.send(state, {
          type: 'subscribed',
          channels: [...state.channels],
          symbols: [...state.symbols],
        });
        break;
      }
      case 'switch_mode': {
        state.mode = message.mode === 'LIVE' ? 'LIVE' : 'DEMO';
        await this.sendHello(state);
        break;
      }
      case 'request_snapshot': {
        const payload = await this.options.snapshots.build(state.userId, state.mode);
        for (const item of payload) this.send(state, item);
        break;
      }
      default:
        this.send(state, { type: 'error', code: 'BAD_REQUEST', message: 'Unsupported message type.' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* RealtimePublisher                                                  */
  /* ------------------------------------------------------------------ */

  toUser(userId: string, message: ServerMessage): void {
    const ids = this.byUser.get(userId);
    if (!ids) return;
    for (const id of ids) {
      const state = this.clients.get(id);
      if (!state) continue;
      if (message.type === 'positions' && !state.channels.has('positions')) continue;
      if (message.type === 'orders' && !state.channels.has('orders')) continue;
      if (message.type === 'account' && !state.channels.has('account')) continue;
      // Never leak live data to a demo session or vice versa.
      if ((message.type === 'positions' || message.type === 'orders' || message.type === 'execution') && message.mode !== state.mode) {
        continue;
      }
      this.send(state, message);
    }
  }

  quotes(quotes: Quote[]): void {
    if (!quotes.length) return;
    // Quotes reach this method from two independent producers (the DEMO market
    // simulator and the MT5 bridge tick stream), so the same method must never
    // fan both into one socket: a LIVE-mode terminal showing DEMO_SIMULATED
    // prices would be publishing simulated numbers as if they were the broker's,
    // and a DEMO terminal would be showing live prices as if they were simulated.
    // The separation follows the data itself (`source`), not a caller flag.
    const simulated = quotes.filter((q) => q.source === 'DEMO_SIMULATED');
    const live = quotes.filter((q) => q.source !== 'DEMO_SIMULATED');
    for (const state of this.clients.values()) {
      if (!state.channels.has('quotes')) continue;
      const index = new Map((state.mode === 'LIVE' ? live : simulated).map((q) => [q.canonical, q]));
      const payload: ServerMessage = {
        type: 'quotes',
        quotes: [...state.symbols].map((symbol) => index.get(symbol)).filter((q): q is Quote => Boolean(q)),
      };
      if (payload.type === 'quotes' && payload.quotes.length) this.send(state, payload);
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  stats(): { clients: number; users: number } {
    return { clients: this.clients.size, users: this.byUser.size };
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients.values()) client.socket.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
