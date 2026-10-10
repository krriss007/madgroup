// Minimal .env loader (no dependency): reads ./.env if present and fills
// process.env for keys that are not already set. Values must be KEY=VALUE.
// .env files are gitignored - real secrets must never be committed.
import fs from 'node:fs';
import path from 'node:path';

const candidate = path.resolve(process.cwd(), '.env');
try {
  if (fs.existsSync(candidate)) {
    const text = fs.readFileSync(candidate, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch {
  // A missing/unreadable .env is not fatal - defaults apply.
}
