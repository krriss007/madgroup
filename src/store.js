// ---------------------------------------------------------------------------
// Tiny atomic JSON persistence for the paper-engine state.
// The snapshot is a convenience (survives restarts); everything in it is
// simulated data. Stored under DATA_DIR (gitignored).
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { logSystem } from './logger.js';

export class StateStore {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.tmp = path.join(dir, 'state.json.tmp');
    this.timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.ok = true;
    } catch (err) {
      logSystem(`State persistence disabled (cannot create data dir): ${err.message}`);
      this.ok = false;
    }
  }

  load() {
    if (!this.ok) return null;
    try {
      if (!fs.existsSync(this.file)) return null;
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      logSystem('Restored paper-trading state snapshot', { file: this.file });
      return parsed;
    } catch (err) {
      logSystem(`Ignoring unreadable state snapshot: ${err.message}`);
      return null;
    }
  }

  scheduleSave(getState) {
    if (!this.ok) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(getState), 800);
    this.timer.unref?.();
  }

  saveNow(getState) {
    if (!this.ok) return;
    try {
      const json = JSON.stringify(getState());
      fs.writeFileSync(this.tmp, json);
      fs.renameSync(this.tmp, this.file);
    } catch (err) {
      logSystem(`State snapshot failed: ${err.message}`);
    }
  }
}
