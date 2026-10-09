import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:3000/ws');   // no cookies, no headers — like the frame
const seen = new Set();
const timer = setTimeout(() => {
  console.log('   socket open:', ws.readyState === WebSocket.OPEN, '| message types received:', [...seen].join(', ') || '(none)');
  ws.close();
  process.exit(0);
}, 6000);
ws.on('open', () => console.log('   upgrade accepted (authenticated with the server-side DEMO session)'));
ws.on('message', (data) => {
  try { const m = JSON.parse(data.toString()); seen.add(m.type); } catch { seen.add('unparseable'); }
  if (seen.size >= 3) { clearTimeout(timer); console.log('   message types received:', [...seen].join(', ')); ws.close(); process.exit(0); }
});
ws.on('unexpected-response', (_req, res) => { console.log('   rejected with HTTP', res.statusCode); process.exit(1); });
ws.on('error', (err) => { console.log('   error:', err.message); process.exit(1); });
