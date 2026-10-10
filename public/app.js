// ---------------------------------------------------------------------------
// Candlebench frontend. Talks only to this app's same-origin /api endpoints.
// No secrets, keys, or credentials exist in this file or anywhere client-side.
// ---------------------------------------------------------------------------
import { createChart, fmt } from './chart.js';
import { collectLive } from './liveFeed.js';

const $ = (id) => document.getElementById(id);
const S = {
  meta: null,
  sel: { symbol: 'BTC-USDT', tf: '5m' },
  watch: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
  candles: [],
  analysis: null,
  state: null,
  logs: { items: [], after: 0, filter: '' },
  lastLogTs: 0,
  live: { enabled: true, inflight: false, provider: null, error: null, lastIngest: 0 },
};

// ------------------------------------------------------------------ api ----
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (body && body.error) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}
const GET = (p) => api(p);
const POST = (p, body = {}) => api(p, { method: 'POST', body: JSON.stringify(body) });

// ----------------------------------------------------------- formatting ----
function money(x, sign = false) {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pre = x < 0 ? '−' : sign && x > 0 ? '+' : '';
  return `${pre}${s}`;
}
function pct(x, sign = true) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}${Math.abs(x).toFixed(2)}%`;
}
function utc(t) {
  return new Date(t).toISOString().replace('T', ' ').slice(0, 19);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- toasts ----
function toast(title, sub = '', kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'err' : kind}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}`;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 5200);
  setTimeout(() => el.remove(), 5700);
}

// ------------------------------------------------------------------ boot ----
async function boot() {
  try {
    S.meta = await GET('/api/meta');
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin',
      `<div class="risk-banner" style="background:#7f1d1d">Cannot reach the Candlebench server: ${esc(e.message)}</div>`);
    return;
  }

  // restore local prefs
  try {
    const saved = JSON.parse(localStorage.getItem('cb.prefs') || '{}');
    if (saved.watch?.length) S.watch = saved.watch;
    if (saved.sel && S.meta.markets.some((m) => m.symbol === saved.sel.symbol)) S.sel.symbol = saved.sel.symbol;
    if (saved.sel?.tf && S.meta.timeframes.some((t) => t.id === saved.sel.tf)) S.sel.tf = saved.sel.tf;
    S.live.enabled = JSON.parse(localStorage.getItem('cb.live') ?? 'true') !== false;
  } catch { /* fresh start */ }
  $('liveToggle').checked = S.live.enabled;
  renderLiveStatus();

  renderTfTabs();
  renderMarketList();
  renderWatchlist();
  bindEvents();
  fillConfigInputs(S.meta.defaultConfig);
  await refreshAll().catch(() => {});
  setInterval(loopCandles, 4000);
  setInterval(loopState, 2500);
  setInterval(loopLogs, 2000);
  loopCandles(); loopState(); loopLogs();
}

function savePrefs() {
  localStorage.setItem('cb.prefs', JSON.stringify({ watch: S.watch, sel: S.sel }));
}

// ------------------------------------------------------- refresh plumbing ----
async function refreshAll() {
  await Promise.all([loopCandles(), loopState(), loopLogs()]);
}

async function loopCandles() {
  if (!S.meta) return;
  kickCollector();
  try {
    const [cd, an] = await Promise.all([
      GET(`/api/candles?symbol=${encodeURIComponent(S.sel.symbol)}&tf=${S.sel.tf}&limit=300`),
      GET(`/api/analysis?symbol=${encodeURIComponent(S.sel.symbol)}&tf=${S.sel.tf}`),
    ]);
    S.candles = cd.candles;
    S.analysis = an;
    $('offlineBanner').hidden = true;
    renderDataBadge(cd.source, cd.provider, cd.label);
    renderChartHead(cd);
    renderChart();
    renderAnalysis(an);
  } catch (e) {
    $('offlineBanner').hidden = false;
    console.warn('candles refresh failed:', e.message);
  }
}

// ---- client-direct live feed -----------------------------------------------
// The browser fetches public exchange candles and relays them to the server.
// Feeds BOTH the chart selection and the bot's target (if different) so the
// paper engine can run on live prices too. Non-blocking, single flight,
// pauses when the tab is hidden or the toggle is off.
function kickCollector() {
  if (!S.live.enabled || S.live.inflight || document.visibilityState !== 'visible') return;
  S.live.inflight = true;
  runCollector().finally(() => { S.live.inflight = false; });
}

async function runCollector() {
  const jobs = [{ symbol: S.sel.symbol, tf: S.sel.tf }];
  const t = S.state?.bot?.target;
  if (
    t && (t.symbol !== S.sel.symbol || t.tf !== S.sel.tf) &&
    S.meta.markets.some((m) => m.symbol === t.symbol) &&
    S.meta.timeframes.some((x) => x.id === t.tf)
  ) jobs.push({ symbol: t.symbol, tf: t.tf });

  let provider = null;
  let err = null;
  for (const job of jobs) {
    try {
      const res = await collectLive(job.symbol, job.tf);
      if (!res) { err = 'no public provider reachable from your browser'; continue; }
      provider = res.provider;
      await POST('/api/market/ingest', { symbol: job.symbol, tf: job.tf, provider: res.provider, candles: res.candles });
      S.live.lastIngest = Date.now();
    } catch (e) {
      err = e.message;
    }
  }
  if (provider) S.live.provider = provider;
  S.live.error = err;
  renderLiveStatus();
}

function renderLiveStatus() {
  const el = $('liveStatus');
  if (!el) return;
  if (!S.live.enabled) {
    el.textContent = 'off — server data only';
    el.className = 'live-status';
    return;
  }
  const fresh = Date.now() - S.live.lastIngest < 30_000;
  if (S.live.provider && fresh && !S.live.error) {
    el.textContent = `${S.live.provider} · feeding live prices`;
    el.className = 'live-status on';
  } else if (S.live.error) {
    el.textContent = `unavailable — ${S.live.error}`;
    el.className = 'live-status err';
  } else {
    el.textContent = S.live.provider ? `${S.live.provider} · reconnecting…` : 'connecting to a public provider…';
    el.className = 'live-status';
  }
}

async function loopState() {
  if (!S.meta) return;
  try {
    S.state = await GET('/api/state');
    $('offlineBanner').hidden = true;
    renderPortfolio();
    renderPositions();
    renderHistory();
    renderBot();
  } catch (e) {
    $('offlineBanner').hidden = false;
    console.warn('state refresh failed:', e.message);
  }
}

async function loopLogs() {
  if (!S.meta) return;
  try {
    const q = new URLSearchParams({ after: String(S.logs.after), limit: '120' });
    if (S.logs.filter) q.set('type', S.logs.filter);
    const { events } = await GET(`/api/logs?${q}`);
    if (events.length) {
      S.logs.items.push(...events);
      S.logs.after = events[events.length - 1].id;
      if (S.logs.items.length > 400) S.logs.items.splice(0, S.logs.items.length - 400);
      // toast interesting events (skip on first load)
      for (const ev of events) {
        if (S.lastLogTs && ev.ts > S.lastLogTs + 1500) {
          if (ev.type === 'ORDER') toast('Simulated order', ev.message, 'ok');
          if (ev.type === 'RISK') toast('Risk limit', ev.message, 'warn');
        }
        S.lastLogTs = Math.max(S.lastLogTs, ev.ts);
      }
      renderLogs();
    }
    $('logCount').textContent = String(S.logs.items.length);
  } catch { /* non-fatal */ }
}

// ------------------------------------------------------------ market list ----
function renderMarketList() {
  const q = $('marketSearch').value.trim().toUpperCase();
  const list = $('marketList');
  const items = S.meta.markets.filter((m) => !q || m.symbol.includes(q) || m.label.replace('/', '').includes(q));
  if (!items.length) {
    list.innerHTML = `<div class="market-empty">No markets match “${esc(q)}”. Results come from a fixed educational list.</div>`;
    return;
  }
  list.innerHTML = items.map((m) => {
    const last = S.candles.length && S.sel.symbol === m.symbol ? S.candles[S.candles.length - 1].c : null;
    const on = S.watch.includes(m.symbol) ? ' on' : '';
    const sel = S.sel.symbol === m.symbol ? ' selected' : '';
    return `<div class="market-item${sel}" role="option" aria-selected="${!!sel}" data-symbol="${m.symbol}">
      <button class="star${on}" data-star="${m.symbol}" title="Add/remove watchlist star">${on ? '★' : '☆'}</button>
      <span class="sym">${esc(m.label)}</span>
      <span class="px">${last != null ? fmt(last) : ''}</span>
    </div>`;
  }).join('');
}

function renderWatchlist() {
  const ul = $('watchlist');
  if (!S.watch.length) {
    ul.innerHTML = '<li class="market-empty" style="padding:8px 10px">Empty — star a market to pin it.</li>';
    return;
  }
  ul.innerHTML = S.watch.map((sym) => {
    const last = sym === S.sel.symbol && S.candles.length ? S.candles[S.candles.length - 1].c : null;
    const sel = sym === S.sel.symbol ? ' selected' : '';
    return `<li class="watch-item${sel}" data-symbol="${sym}" title="Select ${esc(sym)}">
      <span class="sym">${esc(sym.replace('-USDT', '/USDT'))}</span>
      <span class="px">${last != null ? fmt(last) : ''}</span>
      <button class="rm" data-rm="${sym}" title="Remove from watchlist" aria-label="Remove ${esc(sym)}">✕</button>
    </li>`;
  }).join('');
}

// ----------------------------------------------------------------- chart ----
const chart = createChart($('chart'), $('chartTooltip'));

// Display-only EMA overlay (mirror of the server formula; the server's
// evaluation in the analysis panel remains the source of truth).
function emaOverlay(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function renderChart() {
  const closes = S.candles.map((c) => c.c);
  const cfg = S.state?.config || S.meta.defaultConfig;
  const openPos = S.state?.positions?.find((p) => p.symbol === S.sel.symbol);
  const signals = S.analysis?.recentSignals || [];
  chart.setData({
    candles: S.candles,
    emaFast: emaOverlay(closes, cfg.fastEma),
    emaSlow: emaOverlay(closes, cfg.slowEma),
    levels: openPos ? { entry: openPos.entryPrice, stopLoss: openPos.stopLoss, takeProfit: openPos.takeProfit } : null,
    signals,
    isSample: S.analysis ? S.analysis.isSample : true,
    provider: S.analysis?.provider || null,
  });
}

function renderChartHead(cd) {
  const m = S.meta.markets.find((x) => x.symbol === S.sel.symbol);
  $('selSymbol').textContent = m ? m.label : S.sel.symbol;
  const last = cd.candles[cd.candles.length - 1];
  const first = cd.candles[0];
  $('selPrice').textContent = last ? fmt(last.c) : '—';
  const chgEl = $('selChg');
  if (first && last) {
    const chg = ((last.c - first.o) / first.o) * 100;
    chgEl.textContent = `${pct(chg)} (window)`;
    chgEl.className = `chg ${chg >= 0 ? 'up' : 'down'}`;
  }
  const src = $('srcLine');
  src.textContent = cd.label;
  src.className = `src-line ${cd.isSample ? 'warn' : ''}`;
}

function renderDataBadge(source, provider, label) {
  const b = $('dataBadge');
  if (source === 'client') {
    b.dataset.mode = 'live';
    b.textContent = `DATA: LIVE — ${provider} (client feed)`;
  } else if (source === 'okx') {
    b.dataset.mode = 'live';
    b.textContent = 'DATA: LIVE — OKX public (server-side)';
  } else {
    b.dataset.mode = 'sample';
    b.textContent = 'DATA: SAMPLE (simulated)';
  }
  b.title = label || '';
}

function renderTfTabs() {
  $('tfTabs').innerHTML = S.meta.timeframes
    .map((t) => `<button class="tf-tab${t.id === S.sel.tf ? ' active' : ''}" role="tab" aria-selected="${t.id === S.sel.tf}" data-tf="${t.id}">${t.label}</button>`)
    .join('');
}

// -------------------------------------------------------------- analysis ----
function renderAnalysis(an) {
  const body = $('analysisBody');
  if (an.insufficientData || !an.evaluation) {
    body.innerHTML = `<p class="hint">Not enough closed candles on this timeframe to evaluate the strategy yet. Pick a shorter timeframe or wait for more ${an.isSample ? 'sample' : 'market'} data.</p>`;
    return;
  }
  const ev = an.evaluation;
  const cls = ev.action === 'BUY' ? 'buy' : ev.action === 'SELL' ? 'sell' : 'hold';
  const actionLabel = ev.action === 'SELL' && !ev.params.allowShorts ? 'SELL / EXIT LONGS' : ev.action;

  const rules = ev.rules.map((r) => {
    const ico = r.passed ? '✓' : '✗';
    const kind = r.passed ? 'rule-pass' : 'rule-fail';
    const detail = r.detail ? ` <span style="color:var(--muted)">(${esc(r.detail)})</span>` : '';
    return `<li><span class="rule-ico ${kind}">${ico}</span><span>${esc(r.label)}${detail}</span></li>`;
  }).join('');

  const rationale = ev.rationale.map((r) => `<li>${esc(r)}</li>`).join('');

  const ind = ev.indicators;
  const indHtml = `
    <div class="ind-grid">
      <span class="k">EMA ${ev.params.fastEma}</span><span class="v">${fmt(ind.emaFast)}</span>
      <span class="k">EMA ${ev.params.slowEma}</span><span class="v">${fmt(ind.emaSlow)}</span>
      <span class="k">RSI ${ev.params.rsiPeriod}</span><span class="v">${ind.rsi == null ? '—' : ind.rsi.toFixed(1)}</span>
      <span class="k">ATR ${ev.params.atrPeriod}</span><span class="v">${fmt(ind.atr)}</span>
      <span class="k">Last closed candle</span><span class="v">${utc(ev.symbolTime).slice(0, 16)}</span>
    </div>`;

  const chipLabel = an.source === 'client'
    ? `LIVE — ${an.provider || 'browser feed'}`
    : an.isSample ? 'SAMPLE DATA' : 'LIVE — OKX (server)';

  const lv = ev.levels;
  const levelsHtml = lv ? `
    <div class="levels">
      <div class="level"><span class="lv-label">Entry (ref.)</span><span class="lv-value">${fmt(lv.entry)}</span></div>
      <div class="level sl"><span class="lv-label">Stop-loss</span><span class="lv-value">${fmt(lv.stopLoss)}</span></div>
      <div class="level tp"><span class="lv-label">Take-profit</span><span class="lv-value">${fmt(lv.takeProfit)}</span></div>
    </div>
    <p class="tiny-note">SL/TP use ${ev.params.atrMultSL}× / ${ev.params.atrMultTP}× ATR(${ev.params.atrPeriod}) from the reference entry. Actual simulated fills add ~${S.state?.config.slippageBps ?? 5} bps slippage and ${S.state?.config.feeBps ?? 10} bps fees per side.</p>`
    : (ev.note ? `<p class="hint">${esc(ev.note)}</p>` : '<p class="hint">No entry levels proposed on the last closed candle (no crossover trigger).</p>');

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <span class="signal-badge ${cls}">${actionLabel}</span>
      <span class="src-chip ${an.isSample ? 'sample' : 'okx'}">${esc(chipLabel)}</span>
    </div>
    ${levelsHtml}
    <ul class="rules">${rules}</ul>
    <ul class="rationale">${rationale}</ul>
    ${indHtml}`;
}

// ------------------------------------------------------------- portfolio ----
function renderPortfolio() {
  const st = S.state;
  if (!st) return;
  const a = st.account;
  $('pfCash').textContent = money(a.cash);
  $('pfEquity').textContent = money(a.equity);
  const day = $('pfDayPnl');
  day.textContent = `${money(a.dayPnl, true)} (${pct(a.dayPnlPct)})`;
  day.className = `kpi-value ${a.dayPnl >= 0 ? 'up' : 'down'}`;
  const net = $('pfNet');
  net.textContent = money(st.stats.netPnlTotal, true);
  net.className = `kpi-value ${st.stats.netPnlTotal >= 0 ? 'up' : 'down'}`;
  $('pfStart').textContent = money(a.startBalance);
  $('pfFees').textContent = money(st.stats.feesTotal);
  $('pfSlip').textContent = money(st.stats.slippageTotal);

  const used = st.risk.usedPct || 0;
  const lim = st.config.dailyLossLimitPct;
  const frac = lim > 0 ? Math.min(100, (used / lim) * 100) : 0;
  const bar = $('pfLimitBar');
  bar.style.width = `${frac}%`;
  bar.className = `meter-fill ${frac > 80 ? 'hot' : ''}`;
  $('pfLimitTxt').textContent = lim > 0 ? `${used.toFixed(2)}% of ${lim}%` : 'limit off';

  $('posCount').textContent = String(st.positions.length);
}

function renderPositions() {
  const st = S.state;
  const body = $('positionsBody');
  if (!st || !st.positions.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="9">No open positions.</td></tr>';
    return;
  }
  body.innerHTML = st.positions.map((p) => {
    const up = p.unrealizedPnl >= 0;
    return `<tr class="pos">
      <td class="sym">${esc(p.symbol)}</td>
      <td>${esc(p.side)}</td>
      <td>${p.qty}</td>
      <td>${fmt(p.entryPrice)}</td>
      <td>${fmt(p.markPrice)}</td>
      <td class="down">${fmt(p.stopLoss)}</td>
      <td class="up">${fmt(p.takeProfit)}</td>
      <td class="${up ? 'pnl-up' : 'pnl-down'}">${money(p.unrealizedPnl, true)} (${pct(p.unrealizedPct)})</td>
      <td><button class="btn" style="padding:4px 10px;font-size:11.5px" data-close="${p.id}" ${st.bot.status === 'KILLED' ? 'disabled' : ''}>Close</button></td>
    </tr>`;
  }).join('');
}

function renderHistory() {
  const st = S.state;
  const body = $('historyBody');
  if (!st || !st.trades.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="11">No simulated trades yet.</td></tr>';
    return;
  }
  body.innerHTML = st.trades.map((t) => {
    const up = t.netPnl >= 0;
    return `<tr>
      <td>${utc(t.closedAt)}</td>
      <td class="sym">${esc(t.symbol)}</td>
      <td>${esc(t.side)}</td>
      <td>${t.qty}</td>
      <td>${fmt(t.entryPrice)}</td>
      <td>${fmt(t.exitPrice)}</td>
      <td class="${t.grossPnl >= 0 ? 'pnl-up' : 'pnl-down'}">${money(t.grossPnl, true)}</td>
      <td>${money(t.fees)}</td>
      <td>${money(t.slippageCost)}</td>
      <td class="${up ? 'pnl-up' : 'pnl-down'}"><strong>${money(t.netPnl, true)}</strong></td>
      <td>${esc(t.exitReason)}</td>
    </tr>`;
  }).join('');
}

// ------------------------------------------------------------------- bot ----
function renderBot() {
  const st = S.state;
  const pill = $('botStatus');
  pill.dataset.status = st.bot.status;
  pill.textContent = st.bot.status.replace('_', ' ');
  const top = $('botPill');
  top.dataset.status = st.bot.status;
  top.textContent = `BOT: ${st.bot.status}`;

  $('botTarget').textContent = st.bot.target
    ? `target: ${st.bot.target.symbol} @ ${st.bot.target.tf}`
    : 'no target set — press Start to use the chart selection';

  const hint = $('botHint');
  if (st.bot.status === 'STOPPED') hint.textContent = 'Stopped: positions remain open but are NOT managed (no SL/TP checks). Start or Resume to manage again.';
  else if (st.bot.status === 'PAUSED') hint.textContent = 'Paused: no new signals. Protective SL/TP checks stay active.';
  else if (st.bot.status === 'KILLED') hint.textContent = 'Emergency stop: all positions were force-closed and trading is halted. Reset to start over.';
  else if (st.bot.status === 'RUNNING') hint.textContent = `Running: evaluating closed ${st.bot.target?.tf ?? ''} candles on ${st.bot.target?.symbol ?? '—'} once per candle. Chart selection changes do NOT move the bot.`;
  else hint.textContent = 'Start runs the example strategy against the market & timeframe selected on the chart. Signals are evaluated once per closed candle.';

  const rb = $('riskBlock');
  if (st.risk.dayHalted) {
    rb.hidden = false;
    rb.textContent = `Daily loss limit reached (${st.config.dailyLossLimitPct}% of day-start equity). New entries are halted until the next UTC day.`;
  } else if (st.risk.lastBlock && Date.now() - st.risk.lastBlock.ts < 60000) {
    rb.hidden = false;
    rb.textContent = `Last blocked entry — ${st.risk.lastBlock.reason}`;
  } else {
    rb.hidden = true;
  }

  const b = (id, dis) => { $(id).disabled = dis; };
  const s = st.bot.status;
  b('btnStart', !(s === 'IDLE' || s === 'STOPPED'));
  b('btnPause', s !== 'RUNNING');
  b('btnResume', s !== 'PAUSED' || st.risk.dayHalted || st.risk.killActive);
  b('btnStop', !(s === 'RUNNING' || s === 'PAUSED'));
  b('btnKill', s === 'KILLED');
  $('btnReset').disabled = false;
}

function fillConfigInputs(cfg) {
  document.querySelectorAll('[data-cfg]').forEach((el) => {
    const key = el.dataset.cfg;
    if (el.type === 'checkbox') el.checked = !!cfg[key];
    else el.value = cfg[key];
  });
}

async function pushConfig(el) {
  const key = el.dataset.cfg;
  const payload = el.type === 'checkbox' ? { [key]: el.checked } : { [key]: Number(el.value) };
  try {
    const r = await POST('/api/config', payload);
    fillConfigInputs(r.config);
    const msgs = Object.entries(r.rejected).map(([k, v]) => `${k}: ${v}`);
    $('cfgFeedback').textContent = msgs.length ? `⚠ ${msgs.join(' · ')}` : '';
    if (Object.keys(r.applied).length && !msgs.length) $('cfgFeedback').textContent = 'Saved.';
  } catch (e) {
    $('cfgFeedback').textContent = `⚠ ${e.message}`;
  }
}

// ------------------------------------------------------------------ logs ----
function renderLogs() {
  const body = $('logBody');
  const items = [...S.logs.items].reverse();
  if (!items.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="3">No events yet.</td></tr>';
    return;
  }
  body.innerHTML = items.slice(0, 200).map((ev) => `
    <tr>
      <td>${utc(ev.ts)}</td>
      <td><span class="log-type ${esc(ev.type)}">${esc(ev.type)}</span></td>
      <td>
        ${esc(ev.message)}
        ${ev.detail && Object.keys(ev.detail).length ? `<div class="log-detail">${esc(JSON.stringify(ev.detail))}</div>` : ''}
      </td>
    </tr>`).join('');
}

// ---------------------------------------------------------------- backtest ----
async function runBacktest() {
  const btn = $('btnBacktest');
  btn.disabled = true;
  btn.textContent = 'Running…';
  $('backtestBody').innerHTML = '<p class="hint">Computing…</p>';
  try {
    const r = await POST('/api/backtest', { symbol: S.sel.symbol, tf: S.sel.tf, bars: 500 });
    if (r.error) {
      $('backtestBody').innerHTML = `<p class="hint">⚠ ${esc(r.error)}</p>`;
      return;
    }
    const s = r.stats;
    $('backtestBody').innerHTML = `
      <div class="bt-stats">
        <span class="k">Bars tested</span><span class="v">${r.barsTested}</span>
        <span class="k">Trades</span><span class="v">${r.tradesCount}</span>
        <span class="k">Net P/L</span><span class="v ${s.netPnl >= 0 ? 'pnl-up' : 'pnl-down'}">${money(s.netPnl, true)} (${pct(s.netPnlPct)})</span>
        <span class="k">Win rate</span><span class="v">${s.winRatePct == null ? '—' : s.winRatePct + '%'}</span>
        <span class="k">Max drawdown</span><span class="v">${s.maxDrawdownPct}%</span>
        <span class="k">Profit factor</span><span class="v">${s.profitFactor ?? '—'}</span>
        <span class="k">Fees paid</span><span class="v">${money(s.feesTotal)}</span>
        <span class="k">End equity</span><span class="v">${money(s.endEquity)}</span>
      </div>
      <p class="tiny-note" style="margin-top:8px">⚠ HYPOTHETICAL — computed on ${r.isSample ? 'labelled SAMPLE data' : 'public history'} with fixed fee/slippage estimates. Not predictive of future returns.</p>`;
    drawSparkline(r.equityCurve);
  } catch (e) {
    $('backtestBody').innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run backtest (~500 bars)';
  }
}

function drawSparkline(curve) {
  const cv = $('btEquity');
  cv.hidden = false;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || cv.parentElement.clientWidth;
  const H = 90;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!curve || curve.length < 2) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of curve) { lo = Math.min(lo, p.equity); hi = Math.max(hi, p.equity); }
  const pad = (hi - lo) * 0.1 || 1;
  lo -= pad; hi += pad;
  ctx.strokeStyle = curve[curve.length - 1].equity >= curve[0].equity ? '#34d399' : '#f87171';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  curve.forEach((p, i) => {
    const x = (i / (curve.length - 1)) * (W - 8) + 4;
    const y = H - 6 - ((p.equity - lo) / (hi - lo)) * (H - 12);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

// ---------------------------------------------------------------- events ----
function bindEvents() {
  $('marketSearch').addEventListener('input', renderMarketList);

  $('marketList').addEventListener('click', (e) => {
    const star = e.target.closest('[data-star]');
    if (star) {
      const sym = star.dataset.star;
      S.watch = S.watch.includes(sym) ? S.watch.filter((s) => s !== sym) : [...S.watch, sym];
      savePrefs();
      renderMarketList();
      renderWatchlist();
      return;
    }
    const item = e.target.closest('.market-item');
    if (item) selectSymbol(item.dataset.symbol);
  });

  $('watchlist').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      S.watch = S.watch.filter((s) => s !== rm.dataset.rm);
      savePrefs();
      renderWatchlist();
      renderMarketList();
      return;
    }
    const item = e.target.closest('.watch-item');
    if (item) selectSymbol(item.dataset.symbol);
  });

  $('tfTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tf]');
    if (!tab) return;
    S.sel.tf = tab.dataset.tf;
    savePrefs();
    renderTfTabs();
    loopCandles();
  });

  document.querySelectorAll('[data-cfg]').forEach((el) => {
    el.addEventListener('change', () => pushConfig(el));
  });

  $('btnStart').addEventListener('click', async () => {
    try {
      await POST('/api/bot/start', { symbol: S.sel.symbol, tf: S.sel.tf });
      toast('Bot started (paper)', `${S.sel.symbol} @ ${S.sel.tf} — simulated only`, 'ok');
      loopState();
    } catch (e) { toast('Cannot start', e.message, 'error'); }
  });
  $('btnPause').addEventListener('click', () => POST('/api/bot/pause').then(loopState).catch((e) => toast('Cannot pause', e.message, 'error')));
  $('btnResume').addEventListener('click', () => POST('/api/bot/resume').then(loopState).catch((e) => toast('Cannot resume', e.message, 'error')));
  $('btnStop').addEventListener('click', () => POST('/api/bot/stop').then(loopState).catch((e) => toast('Cannot stop', e.message, 'error')));
  $('btnKill').addEventListener('click', () => {
    if (!confirm('EMERGENCY STOP — force-close ALL simulated positions and halt the bot?')) return;
    POST('/api/bot/kill').then(() => { toast('Emergency stop engaged', 'All simulated positions force-closed.', 'warn'); loopState(); })
      .catch((e) => toast('Kill switch failed', e.message, 'error'));
  });
  $('btnReset').addEventListener('click', () => {
    if (!confirm('Reset the simulator? Balance returns to the starting amount; positions, trades and logs are cleared.')) return;
    POST('/api/bot/reset').then(() => {
      S.logs = { items: [], after: 0, filter: S.logs.filter };
      renderLogs();
      toast('Simulator reset', 'Paper balance restored to defaults.', 'ok');
      loopState();
    }).catch((e) => toast('Reset failed', e.message, 'error'));
  });

  $('positionsBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-close]');
    if (!btn) return;
    POST('/api/positions/close', { id: btn.dataset.close })
      .then(() => loopState())
      .catch((err) => toast('Close failed', err.message, 'error'));
  });

  $('btnBacktest').addEventListener('click', runBacktest);

  $('logToggle').addEventListener('click', () => {
    const panel = $('logPanelWrap');
    panel.hidden = !panel.hidden;
    $('logToggle').setAttribute('aria-expanded', String(!panel.hidden));
    $('logToggle').firstChild.textContent = panel.hidden ? '▲ ' : '▼ ';
  });

  $('logFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-type]');
    if (!chip) return;
    document.querySelectorAll('#logFilters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    S.logs.filter = chip.dataset.type;
    S.logs.items = [];
    S.logs.after = 0;
    loopLogs();
  });

  $('liveToggle').addEventListener('change', (e) => {
    S.live.enabled = e.target.checked;
    localStorage.setItem('cb.live', JSON.stringify(S.live.enabled));
    if (!S.live.enabled) S.live.error = null;
    renderLiveStatus();
    if (S.live.enabled) kickCollector();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kickCollector();
  });

  window.addEventListener('resize', () => renderChart());
}

async function selectSymbol(symbol) {
  S.sel.symbol = symbol;
  savePrefs();
  renderMarketList();
  renderWatchlist();
  await loopCandles();
}

boot();
