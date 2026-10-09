import WebSocket from 'ws';
// Proves the LIVE tick path: the EA pushes ticks → backend publishes on the WS
// 'quotes' channel → the browser watchlist updates without polling.
const API = 'http://127.0.0.1:3000/api/v1';
const S = ['XAUUSD','EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD','EURGBP','EURJPY','GBPJPY'];

const r = await fetch(`${API}/auth/demo-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const body = await r.json();
const token = body?.session?.token ?? body?.token;
if (!token) { console.log('no token', JSON.stringify(body).slice(0,200)); process.exit(1); }

const ws = new WebSocket('ws://127.0.0.1:3000/ws', { headers: { authorization: `Bearer ${token}` } });
let n = 0, modes = new Set(), sources = new Set();
const done = (msg) => { console.log(msg); ws.close(); process.exit(0); };
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', channels: ['quotes','connection'], symbols: S, mode: 'LIVE' }));
  // the dashboard switches environment client-side; the socket follows
  setTimeout(() => ws.send(JSON.stringify({ type: 'switch_mode', mode: 'LIVE' })), 300);
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'quotes' && m.quotes?.length) {
    n += 1;
    for (const q of m.quotes) { modes.add(q.mode); sources.add(q.source); }
    if (n === 1) console.log(`   first push: ${m.quotes.length} quotes, e.g. ${m.quotes[0].symbol} ${m.quotes[0].bid}/${m.quotes[0].ask}`);
    if (n <= 3) console.log(`   push ${n}: ${m.quotes.length} quotes | ${[...new Set(m.quotes.map((q) => q.source))].join(',')} | ${m.quotes.map((q) => q.canonical).slice(0, 4).join(' ')}`);
  }
});
setTimeout(() => done(`   WS 'quotes' pushes in 7 s: ${n} | modes: ${[...modes].join(',')||'-'} | sources: ${[...sources].join(',')||'-'}`), 7000);
ws.on('error', (e) => { console.log('ws error', e.message); process.exit(1); });
