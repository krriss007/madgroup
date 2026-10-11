import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader (no dependency). Existing process env vars win over the file. */
export function loadDotEnv(path = resolve(ROOT, '.env')): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface AppConfig {
  root: string;
  port: number;
  host: string;
  dataFile: string | null;
  marketMode: 'auto' | 'sim';
  finnhubApiKey: string | null;
  finnhubRestUrl: string;
  finnhubWsUrl: string;
  binanceEnabled: boolean;
  binanceRestUrl: string;
  binanceWsUrl: string;
  llmApiKey: string | null;
  llmBaseUrl: string;
  llmModel: string;
}

export function loadConfig(env: Record<string, string | undefined> = { ...loadDotEnv(), ...process.env }): AppConfig {
  const str = (k: string, d: string) => (env[k] && env[k]!.trim() !== '' ? env[k]!.trim() : d);
  const opt = (k: string) => (env[k] && env[k]!.trim() !== '' ? env[k]!.trim() : null);
  return {
    root: ROOT,
    port: Number(str('PORT', '3000')),
    host: str('HOST', '0.0.0.0'),
    dataFile: opt('DATA_FILE') ?? resolve(ROOT, 'data/state.json'),
    marketMode: str('MARKET_MODE', 'auto') === 'sim' ? 'sim' : 'auto',
    finnhubApiKey: opt('FINNHUB_API_KEY'),
    finnhubRestUrl: str('FINNHUB_REST_URL', 'https://finnhub.io/api/v1'),
    finnhubWsUrl: str('FINNHUB_WS_URL', 'wss://ws.finnhub.io'),
    binanceEnabled: str('BINANCE_ENABLED', '1') !== '0',
    binanceRestUrl: str('BINANCE_REST_URL', 'https://api.binance.com'),
    binanceWsUrl: str('BINANCE_WS_URL', 'wss://stream.binance.com:9443'),
    llmApiKey: opt('LLM_API_KEY'),
    llmBaseUrl: str('LLM_BASE_URL', 'https://api.openai.com/v1'),
    llmModel: str('LLM_MODEL', 'gpt-4o-mini'),
  };
}
