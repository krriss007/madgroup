/**
 * TradePilot — realtime publisher contract.
 *
 * Services (demo engine, bridge, order service, alerts) depend on this small
 * interface instead of the WebSocket hub itself, which keeps the trading logic
 * testable and free of transport concerns.
 */

import type { ServerMessage } from '@tradepilot/shared';

export interface RealtimePublisher {
  /** Send a message to every socket of one user. */
  toUser(userId: string, message: ServerMessage): void;
  /** Fan out market quotes to the sockets subscribed to those symbols. */
  quotes(quotes: { symbol: string; canonical: string }[]): void;
  /** Number of connected sockets (diagnostics). */
  clientCount(): number;
}

export class NullPublisher implements RealtimePublisher {
  toUser(): void {
    /* no-op when realtime is disabled (tests) */
  }

  quotes(): void {
    /* no-op */
  }

  clientCount(): number {
    return 0;
  }
}
