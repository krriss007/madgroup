import { mkdirSync, readFileSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentConfig } from '../shared/types';
import { createAccount, type PersistedAccount } from './trading/engine';
import { defaultAgentConfig } from './agent/config';

export interface AppState {
  version: 1;
  account: PersistedAccount;
  agent: AgentConfig;
  /** Last simulated mid price per symbol, used to anchor the simulator on restart. */
  lastMids?: Record<string, number>;
}

/**
 * JSON file persistence with a debounced, atomic write. Pass `path = null` for
 * an in-memory store (used by tests).
 */
export class StateStore {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly path: string | null,
    readonly state: AppState,
    private readonly debounceMs = 300,
  ) {}

  static load(path: string | null, now = Date.now()): StateStore {
    if (path && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as AppState;
        if (raw?.version === 1 && raw.account && raw.agent) {
          return new StateStore(path, { ...raw, agent: { ...defaultAgentConfig(), ...raw.agent } });
        }
      } catch {
        // Corrupt file: fall through and start fresh (the old file is kept as .bak).
        try {
          renameSync(path, `${path}.bak`);
        } catch {
          /* ignore */
        }
      }
    }
    return new StateStore(path, { version: 1, account: createAccount(now), agent: defaultAgentConfig() });
  }

  /** Schedule a save. Multiple calls within the debounce window coalesce. */
  save(): void {
    if (!this.path) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }
}
