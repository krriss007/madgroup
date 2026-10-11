import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { loadConfig } from './config';
import { INSTRUMENTS } from './market/instruments';
import { MarketData } from './market/marketData';
import { seedSimulatedHistory, stepSimulator } from './market/simulator';
import { FinnhubFeed, type FinnhubStatus } from './market/finnhub';
import { BinanceFeed, type BinanceStatus } from './market/binance';
import { TradingEngine } from './trading/engine';
import { TradingAgent } from './agent/agent';
import { LlmClient } from './agent/llm';
import { StateStore } from './persistence';
import { createRequestHandler } from './http';
import { Realtime } from './realtime';
import type { MarketStatus } from '../shared/types';

const config = loadConfig();
const store = StateStore.load(config.dataFile);
const market = new MarketData(INSTRUMENTS);
seedSimulatedHistory(market, { anchors: store.state.lastMids });

const log = (level: 'info' | 'warn' | 'error', message: string) => {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
};

// ---------------------------------------------------------------- market feeds
const liveEnabled = config.marketMode === 'auto';
// Source per symbol (one feed per symbol, so two feeds never write the same price):
//   crypto  → Binance public streams (no key needed), when enabled
//   forex & metals → Finnhub, when FINNHUB_API_KEY is set
//   everything else (indices, or any symbol whose feed is off) → simulator
const finnhubSpecs = liveEnabled && config.finnhubApiKey ? INSTRUMENTS.filter((s) => s.finnhubSymbol && !s.binanceSymbol) : [];
const binanceSpecs = liveEnabled && config.binanceEnabled ? INSTRUMENTS.filter((s) => s.binanceSymbol) : [];

let finnhubStatus: FinnhubStatus | null = null;
let binanceStatus: BinanceStatus | null = null;

const finnhub = finnhubSpecs.length
  ? new FinnhubFeed(market, {
      apiKey: config.finnhubApiKey!,
      restUrl: config.finnhubRestUrl,
      wsUrl: config.finnhubWsUrl,
      log,
      onStatus: (s) => {
        finnhubStatus = s;
        pushMarket();
      },
    })
  : null;

const binance = binanceSpecs.length
  ? new BinanceFeed(market, {
      restUrl: config.binanceRestUrl,
      wsUrl: config.binanceWsUrl,
      log,
      onStatus: (s) => {
        binanceStatus = s;
        pushMarket();
      },
    })
  : null;

function marketStatus(): MarketStatus {
  const now = Date.now();
  const live: string[] = [];
  const simulated: string[] = [];
  for (const symbol of market.symbols()) {
    const st = market.state(symbol)!;
    if (st.source === 'live' && now - st.lastLiveTick < 60_000) live.push(symbol);
    else simulated.push(symbol);
  }
  const fh = finnhubStatus;
  const finnhubError =
    fh?.error ?? (fh && fh.historyFailures.length > 0 ? 'Candle history not included in this Finnhub plan; streaming prices with simulated history' : null);
  const bn = binanceStatus;
  return {
    mode: config.marketMode,
    live,
    simulated,
    feeds: [
      {
        name: 'finnhub',
        enabled: !!finnhub,
        connected: fh?.connected ?? false,
        error: finnhub ? finnhubError : null,
        symbols: finnhubSpecs.map((s) => s.symbol),
        // expose only what is streaming
      },
      {
        name: 'binance',
        enabled: !!binance,
        connected: bn?.connected ?? false,
        error: bn?.error ?? null,
        symbols: binanceSpecs.map((s) => s.symbol),
      },
      {
        name: 'simulator',
        enabled: true,
        connected: true,
        error: null,
        symbols: simulated,
      },
    ],
  };
}

// ---------------------------------------------------------------- services
let realtime: Realtime | null = null;
const pushMarket = () => realtime?.broadcast({ type: 'market', market: marketStatus() });

const engine = new TradingEngine({
  market,
  state: store.state.account,
  onEvent: (e) => {
    if (e.type === 'notice') {
      realtime?.broadcast({ type: 'toast', level: e.level, message: e.message });
    } else {
      store.save();
      realtime?.broadcast({ type: 'account_full', state: engine.full() });
    }
  },
});

const llm = config.llmApiKey
  ? new LlmClient({ apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl, model: config.llmModel })
  : null;

const agent = new TradingAgent({
  market,
  engine,
  store,
  llm,
  onLog: (entry) => realtime?.agentLog(entry),
  onChange: () => realtime?.broadcast({ type: 'agent', status: agent.status() }),
});

market.on('tick', (symbol: string) => engine.onMarketTick(symbol));

// ---------------------------------------------------------------- http + ws
const handler = createRequestHandler({
  market,
  engine,
  agent,
  store,
  marketStatus,
  webDist: resolve(config.root, 'dist'),
});
const server = createServer((req, res) => void handler(req, res));
realtime = new Realtime(server, { market, engine, agent, marketStatus });
realtime.start();

// ---------------------------------------------------------------- background loops
const simTimer = setInterval(() => stepSimulator(market, Date.now()), 1000);
const saveMidsTimer = setInterval(() => {
  store.state.lastMids = Object.fromEntries(market.symbols().map((s) => [s, market.mid(s)]));
  store.save();
}, 15_000);
agent.start(2000);

// Live feeds load history in the background; the server starts immediately.
void (async () => {
  if (finnhub) await finnhub.start(finnhubSpecs);
  if (binance) await binance.start(binanceSpecs);
  pushMarket();
})();

server.listen(config.port, config.host, () => {
  log('info', `MadTrade demo terminal listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  log('info', `Market data: ${finnhub ? 'Finnhub (key set)' : 'no Finnhub key'}, ${binance ? 'Binance public streams' : 'Binance off'}, simulator for the rest`);
  log('info', `AI agent: ${llm ? `LLM ${llm.model}` : 'rules-based (no LLM key)'}${store.state.agent.enabled ? ', ENABLED' : ', disabled until switched on'}`);
});

// ---------------------------------------------------------------- shutdown
function shutdown(signal: string) {
  log('info', `${signal} received, shutting down`);
  clearInterval(simTimer);
  clearInterval(saveMidsTimer);
  store.state.lastMids = Object.fromEntries(market.symbols().map((s) => [s, market.mid(s)]));
  agent.stop();
  realtime?.stop();
  finnhub?.stop();
  binance?.stop();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
