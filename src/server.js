// ---------------------------------------------------------------------------
// HTTP API + static file server.
// Security posture for v1:
//   * Same-origin only: no CORS headers are emitted, so other origins cannot
//     call this API from a browser.
//   * Every query/body input is validated against whitelists/limits.
//   * No secrets exist client-side; the server reads env config once.
//   * JSON errors with clear messages; API responses are no-store.
// ---------------------------------------------------------------------------
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverConfig, configLimits } from './config.js';
import { DataBus, TIMEFRAMES, MARKETS, tfMs } from './data/databus.js';
import { PaperEngine } from './engine.js';
import { runBacktest } from './backtest.js';
import { getEvents, logSystem, logError } from './logger.js';
import { evaluateStrategy } from './strategy.js';
import { StateStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bus = new DataBus();
const store = new StateStore(serverConfig.dataDir);
const engine = new PaperEngine(bus, store);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

// Minimal security headers; API responses must never be cached.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

const api = express.Router();

// ---- validation helpers ---------------------------------------------------
function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}
function validSymbol(req, res) {
  const symbol = String(req.query.symbol || '');
  if (!MARKETS.some((m) => m.symbol === symbol)) {
    bad(res, `Unknown symbol "${symbol}". Use GET /api/meta for the list.`);
    return null;
  }
  return symbol;
}
function validTf(req, res) {
  const tf = String(req.query.tf || '');
  if (!TIMEFRAMES.some((t) => t.id === tf)) {
    bad(res, `Unknown timeframe "${tf}". Use GET /api/meta for the list.`);
    return null;
  }
  return tf;
}
function intParam(req, name, def, min, max) {
  const raw = req.query[name];
  if (raw === undefined) return def;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ---- meta & health ---------------------------------------------------------
api.get('/health', (req, res) => {
  res.json({ ok: true, paperTrading: true, uptimeSec: Math.round(process.uptime()) });
});

api.get('/meta', (req, res) => {
  res.json({
    app: 'Candlebench',
    paperTrading: true,
    notice:
      'Paper trading only. All balances, orders and results are SIMULATED. Signals are informational and are not financial advice.',
    markets: MARKETS,
    timeframes: TIMEFRAMES,
    defaultConfig: engine.config,
    configLimits,
  });
});

// ---- market data & analysis ------------------------------------------------
api.get('/candles', async (req, res, next) => {
  try {
    const symbol = validSymbol(req, res); if (!symbol) return;
    const tf = validTf(req, res); if (!tf) return;
    const limit = intParam(req, 'limit', 300, 50, 1000);
    const { candles, source, isSample, label } = await bus.candles(symbol, tf, limit);
    res.json({ symbol, tf, source, isSample, label, candles });
  } catch (err) { next(err); }
});

api.get('/analysis', async (req, res, next) => {
  try {
    const symbol = validSymbol(req, res); if (!symbol) return;
    const tf = validTf(req, res); if (!tf) return;
    const { candles, source, isSample, label } = await bus.candles(symbol, tf, 400);
    const closed = candles.filter((c) => c.complete);
    const cfg = engine.config;
    const warm = Math.max(cfg.slowEma, cfg.rsiPeriod, cfg.atrPeriod) + 5;
    const evaluation = closed.length > warm
      ? evaluateStrategy(closed, cfg)
      : null;
    res.json({
      symbol,
      tf,
      source,
      isSample,
      label,
      lastUpdate: Date.now(),
      candleCount: candles.length,
      closedCount: closed.length,
      insufficientData: evaluation == null,
      evaluation,
      botTarget: engine.state.bot.target,
    });
  } catch (err) { next(err); }
});

// ---- bot control -----------------------------------------------------------
api.post('/bot/start', async (req, res, next) => {
  try {
    const { symbol, tf } = req.body || {};
    if (!MARKETS.some((m) => m.symbol === symbol)) return bad(res, 'Invalid or missing symbol');
    if (!TIMEFRAMES.some((t) => t.id === tf)) return bad(res, 'Invalid or missing timeframe');
    const r = engine.start({ symbol, tf });
    if (r.error) return bad(res, r.error, 409);
    res.json({ ok: true, bot: engine.state.bot });
  } catch (err) { next(err); }
});

api.post('/bot/pause', (req, res) => {
  const r = engine.pause();
  if (r.error) return bad(res, r.error, 409);
  res.json({ ok: true, bot: engine.state.bot });
});

api.post('/bot/resume', (req, res) => {
  const r = engine.resume();
  if (r.error) return bad(res, r.error, 409);
  res.json({ ok: true, bot: engine.state.bot });
});

api.post('/bot/stop', (req, res) => {
  const r = engine.stop();
  if (r.error) return bad(res, r.error, 409);
  res.json({ ok: true, bot: engine.state.bot });
});

api.post('/bot/kill', async (req, res, next) => {
  try {
    await engine.kill();
    res.json({ ok: true, bot: engine.state.bot });
  } catch (err) { next(err); }
});

api.post('/bot/reset', (req, res) => {
  engine.reset();
  res.json({ ok: true, bot: engine.state.bot });
});

api.post('/config', (req, res) => {
  const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const r = engine.updateConfig(patch);
  res.json(r);
});

api.post('/positions/close', async (req, res, next) => {
  try {
    const { id } = req.body || {};
    if (typeof id !== 'string' || !/^pos-\d+$/.test(id)) return bad(res, 'Invalid position id');
    const r = await engine.closePositionById(id, 'MANUAL');
    if (r.error) return bad(res, r.error, 404);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- state, logs, backtest --------------------------------------------------
api.get('/state', async (req, res, next) => {
  try {
    res.json(await engine.publicState());
  } catch (err) { next(err); }
});

api.get('/logs', (req, res) => {
  const limit = intParam(req, 'limit', 200, 1, 500);
  const after = intParam(req, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
  const type = req.query.type ? String(req.query.type) : undefined;
  res.json({ events: getEvents({ after, limit, type }), lastId: getEvents({ limit: 1 }).pop()?.id || 0 });
});

api.post('/backtest', async (req, res, next) => {
  try {
    const { symbol, tf, bars } = req.body || {};
    if (!MARKETS.some((m) => m.symbol === symbol)) return bad(res, 'Invalid symbol');
    if (!TIMEFRAMES.some((t) => t.id === tf)) return bad(res, 'Invalid timeframe');
    const want = Math.min(Math.max(Number(bars) || 500, 100), 1000);
    const { candles, source, isSample, label } = await bus.candles(symbol, tf, want);
    const closed = candles.filter((c) => c.complete);
    const result = runBacktest({ candles: closed, config: engine.config });
    res.json({ symbol, tf, source, isSample, label, requestedBars: want, ...result });
  } catch (err) { next(err); }
});

app.use('/api', api);

// Unknown API route -> JSON 404 (never HTML).
app.use('/api', (req, res) => bad(res, `No such API endpoint: ${req.method} ${req.path}`, 404));

// ---- static frontend --------------------------------------------------------
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));

// Error handler (JSON).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logError(`Request failed: ${req.method} ${req.path} - ${err.message}`);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

engine.startTicking(5000);
logSystem(`Candlebench starting (paper trading only) - data source mode: ${serverConfig.dataSource}`);

app.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`Candlebench (paper trading) listening on http://${serverConfig.host}:${serverConfig.port}`);
  console.log('DISCLAIMER: simulated data and results. Not financial advice. No real orders are placed.');
});
