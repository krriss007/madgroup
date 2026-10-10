// ---------------------------------------------------------------------------
// Minimal dependency-free candlestick chart on a <canvas>.
// Draws: candles, EMA overlays, signal markers, position level lines
// (entry/SL/TP), last-price tag, axes, and a data-source watermark.
// ---------------------------------------------------------------------------

const PAD = { top: 14, right: 74, bottom: 26, left: 8 };

export function createChart(canvas, tooltipEl) {
  const ctx = canvas.getContext('2d');
  let data = null; // {candles, emaFast, emaSlow, signals, levels, isSample}
  let hoverIdx = -1;
  let geom = null; // cached layout for hit-testing

  const resizeObserver = new ResizeObserver(() => draw());
  resizeObserver.observe(canvas.parentElement);

  canvas.addEventListener('mousemove', (e) => {
    if (!geom || !data || !data.candles.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { x0, x1, slot } = geom;
    if (x < x0 || x > x1) { hoverIdx = -1; tooltipEl.hidden = true; draw(); return; }
    hoverIdx = Math.min(data.candles.length - 1, Math.max(0, Math.floor((x - x0) / slot)));
    showTooltip(x, y);
    draw();
  });
  canvas.addEventListener('mouseleave', () => {
    hoverIdx = -1;
    tooltipEl.hidden = true;
    draw();
  });

  function showTooltip(x, y) {
    const c = data.candles[hoverIdx];
    if (!c) return;
    const d = new Date(c.t);
    const rows = [
      `<b>${d.toISOString().replace('T', ' ').slice(0, 16)} UTC</b>`,
      `O ${fmt(c.o)}  H ${fmt(c.h)}`,
      `L ${fmt(c.l)}  C ${fmt(c.c)}`,
      `Vol ${fmt(c.v)}`,
      c.complete ? '' : '<i>forming candle</i>',
    ].filter(Boolean);
    tooltipEl.innerHTML = rows.join('<br>');
    tooltipEl.hidden = false;
    const wrap = canvas.parentElement.getBoundingClientRect();
    const tw = tooltipEl.offsetWidth;
    tooltipEl.style.left = `${Math.min(Math.max(4, x + 14), wrap.width - tw - 4)}px`;
    tooltipEl.style.top = `${Math.max(4, y - 60)}px`;
  }

  function setData(d) {
    data = d;
    draw();
  }

  function draw() {
    const wrap = canvas.parentElement;
    if (!wrap || !data) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (W === 0 || H === 0) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const candles = data.candles;
    if (!candles || candles.length < 2) {
      ctx.fillStyle = '#93a4bf';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Not enough data to draw a chart yet…', 20, H / 2);
      return;
    }

    // ----- scales -----
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
    const lv = [];
    if (data.levels) lv.push(data.levels.entry, data.levels.stopLoss, data.levels.takeProfit);
    for (const v of lv) { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
    lo -= pad; hi += pad;

    const x0 = PAD.left;
    const x1 = W - PAD.right;
    const y0 = PAD.top;
    const y1 = H - PAD.bottom;
    const slot = (x1 - x0) / candles.length;
    const bodyW = Math.max(1.5, Math.min(11, slot * 0.62));
    const py = (p) => y1 - ((p - lo) / (hi - lo)) * (y1 - y0);
    const px = (i) => x0 + slot * (i + 0.5);
    geom = { x0, x1, slot };

    // ----- grid + price axis -----
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const ticks = niceTicks(lo, hi, 6);
    ctx.strokeStyle = 'rgba(34,49,79,0.55)';
    ctx.fillStyle = '#7387a6';
    ctx.lineWidth = 1;
    for (const t of ticks) {
      const yy = Math.round(py(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
      ctx.stroke();
      ctx.fillText(fmtTick(t), x1 + 6, yy);
    }

    // ----- time axis -----
    const labelEvery = Math.max(1, Math.floor(candles.length / Math.max(3, Math.floor((x1 - x0) / 90))));
    ctx.fillStyle = '#7387a6';
    ctx.textAlign = 'center';
    for (let i = 0; i < candles.length; i += labelEvery) {
      const d = new Date(candles[i].t);
      const lab = candles[candles.length - 1].t - candles[0].t > 4 * 86400000
        ? d.toISOString().slice(5, 10)
        : d.toISOString().slice(11, 16);
      ctx.fillText(lab, px(i), y1 + 13);
    }
    ctx.textAlign = 'left';

    // ----- watermark -----
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = data.isSample ? '#f59e0b' : '#2dd4bf';
    ctx.font = '800 20px system-ui, sans-serif';
    const watermark = data.isSample
      ? 'SAMPLE DATA — SIMULATED PRICES'
      : `LIVE — ${String(data.provider || 'PUBLIC EXCHANGE').toUpperCase()} DATA (VIA BROWSER)`;
    ctx.fillText(watermark, x0 + 14, y0 + 26);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText('Paper trading only — not investment advice', x0 + 14, y0 + 44);
    ctx.restore();

    // ----- level lines (open position) -----
    if (data.levels) {
      levelLine(data.levels.entry, '#0ea5e9', 'ENTRY', dashed([6, 4]));
      levelLine(data.levels.stopLoss, '#f87171', 'SL', dashed([6, 4]));
      levelLine(data.levels.takeProfit, '#34d399', 'TP', dashed([6, 4]));
    }

    // ----- candles -----
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const up = c.c >= c.o;
      const col = up ? '#34d399' : '#f87171';
      const xx = px(i);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      // wick
      ctx.beginPath();
      ctx.moveTo(Math.round(xx) + 0.5, py(c.h));
      ctx.lineTo(Math.round(xx) + 0.5, py(c.l));
      ctx.stroke();
      // body
      const yO = py(c.o);
      const yC = py(c.c);
      const top = Math.min(yO, yC);
      const hgt = Math.max(1, Math.abs(yC - yO));
      if (c.complete) {
        ctx.globalAlpha = 1;
        ctx.fillRect(xx - bodyW / 2, top, bodyW, hgt);
      } else {
        ctx.globalAlpha = 0.55; // forming candle shown translucent
        ctx.fillRect(xx - bodyW / 2, top, bodyW, hgt);
        ctx.globalAlpha = 1;
      }
    }

    // ----- EMA overlays -----
    line(data.emaFast, '#fbbf24', 1.6);
    line(data.emaSlow, '#818cf8', 1.6);

    // ----- signal markers -----
    if (data.signals) {
      for (const s of data.signals) {
        const i = timeIndex(s.t);
        if (i === -1) continue;
        const xx = px(i);
        const c = candles[i];
        if (s.action === 'BUY') {
          marker(xx, py(c.l) + 14, '#34d399', 'up');
        } else if (s.action === 'SELL') {
          marker(xx, py(c.h) - 14, '#f87171', 'down');
        }
      }
    }

    // ----- last price tag -----
    const lastC = candles[candles.length - 1];
    const yLast = py(lastC.c);
    const lastCol = lastC.c >= lastC.o ? '#34d399' : '#f87171';
    ctx.strokeStyle = lastCol;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(yLast) + 0.5);
    ctx.lineTo(x1, Math.round(yLast) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lastCol;
    roundRect(x1 + 2, yLast - 9, PAD.right - 6, 18, 4);
    ctx.fill();
    ctx.fillStyle = '#08101f';
    ctx.font = '700 10.5px ui-monospace, monospace';
    ctx.fillText(fmtTick(lastC.c), x1 + 7, yLast + 0.5);

    // ----- hover highlight -----
    if (hoverIdx >= 0 && hoverIdx < candles.length) {
      ctx.strokeStyle = 'rgba(147,164,191,0.5)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(px(hoverIdx)) + 0.5, y0);
      ctx.lineTo(Math.round(px(hoverIdx)) + 0.5, y1);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---------- helpers ----------
    function line(series, color, width) {
      if (!series) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (v == null || !Number.isFinite(v)) { started = false; continue; }
        const xx = px(i);
        const yy = py(v);
        if (!started) { ctx.moveTo(xx, yy); started = true; }
        else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }

    function levelLine(v, color, label, dash) {
      if (v == null || !Number.isFinite(v) || v < lo || v > hi) return;
      const yy = Math.round(py(v)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.fillText(label, x0 + 4, yy - 7);
    }

    function marker(x, y, color, dir) {
      ctx.fillStyle = color;
      ctx.beginPath();
      if (dir === 'up') {
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x - 5.5, y + 3);
        ctx.lineTo(x + 5.5, y + 3);
      } else {
        ctx.moveTo(x, y + 7);
        ctx.lineTo(x - 5.5, y - 3);
        ctx.lineTo(x + 5.5, y - 3);
      }
      ctx.closePath();
      ctx.fill();
    }

    function timeIndex(t) {
      // exact or next-existing candle at/after t
      for (let i = candles.length - 1; i >= 0; i--) {
        if (candles[i].t === t) return i;
        if (candles[i].t < t) return i;
      }
      return -1;
    }
  }

  function dashed(pattern) { return pattern; }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  return { setData };
}

// ------------------------------ formatting ---------------------------------
export function fmt(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 1) return x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return x.toPrecision(4);
}

function fmtTick(x) {
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  return x.toPrecision(4);
}

function niceTicks(lo, hi, count) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi; v += step) out.push(v);
  return out;
}
