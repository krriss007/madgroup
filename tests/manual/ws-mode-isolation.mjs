import WebSocket from 'ws';
const API = 'http://127.0.0.1:3000/api/v1';
const S = ['XAUUSD','EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD','EURGBP','EURJPY','GBPJPY'];
const r = await fetch(`${API}/auth/demo-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const token = (await r.json())?.session?.token;
const run = (label, live) => new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:3000/ws', { headers: { authorization: `Bearer ${token}` } });
  const sources = new Set();
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['quotes'], symbols: S }));
    if (live) setTimeout(() => ws.send(JSON.stringify({ type: 'switch_mode', mode: 'LIVE' })), 200);
  });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'quotes' && m.quotes?.length) for (const q of m.quotes) sources.add(q.source);
  });
  setTimeout(() => { console.log(`   ${label}: sources seen = ${[...sources].join(', ') || '(none)'}`); ws.close(); resolve(); }, 6000);
});
await run('DEMO socket', false);
await run('LIVE socket', true);
