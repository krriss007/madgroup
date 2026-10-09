/**
 * Simulates the browser's worst case (cookies blocked by the embedding frame)
 * against the frontend proxy, mirroring lib/api.ts loginWithPassword().
 */
const BASE = 'http://127.0.0.1:3000/api/v1';
const log = (...a) => console.log(...a);

const json = async (r) => {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; }
};

// --- 1. plain login (as the login page does first) ------------------------
const r1 = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ email: 'demo@tradepilot.local', password: 'demo1234' }),
});
log('1. POST /auth/login →', r1.status, '(cookies the browser would drop)');

// --- 2. cookie probe: does an authenticated call work? --------------------
const probe = await fetch(`${BASE}/auth/session`, { headers: { accept: 'application/json' }, cache: 'no-store' });
log('2. GET /auth/session without cookies →', probe.status, probe.ok ? 'cookie mode' : 'cookie blocked → bearer fallback');

// --- 3. re-login asking for a bearer session -----------------------------
const r3 = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', 'x-tradepilot-transport': 'bearer' },
  body: JSON.stringify({ email: 'demo@tradepilot.local', password: 'demo1234' }),
});
const b3 = await json(r3);
const token = b3.session?.token;
log('3. POST /auth/login (bearer) →', r3.status, '| token:', token ? `${token.slice(0, 18)}…` : 'MISSING');
if (!token) process.exit(1);

const auth = { authorization: `Bearer ${token}`, accept: 'application/json' };

// --- 4. authenticated reads ----------------------------------------------
const session = await json(await fetch(`${BASE}/auth/session`, { headers: auth, cache: 'no-store' }));
log('4. GET /auth/session →', session.user?.email, '| transport:', session.transport, '| sliding token:', Boolean(session.session?.token));

const account = await json(await fetch(`${BASE}/account?mode=DEMO`, { headers: auth, cache: 'no-store' }));
log('   GET /account →', account.account?.login, account.account?.currency, 'balance', account.account?.balance);

const watch = await json(await fetch(`${BASE}/watchlists?mode=DEMO`, { headers: auth, cache: 'no-store' }));
log('   GET /watchlists →', watch.items?.length, 'symbols, quotes:', watch.quotes?.length, '| online', watch.online);

// --- 5. place a DEMO order over the bearer transport ---------------------
const preview = await json(
  await fetch(`${BASE}/trading/preview`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'sim-preview-1', mode: 'DEMO', symbol: 'XAUUSD', side: 'BUY', type: 'MARKET', volume: 0.01, stopLoss: 2600, takeProfit: 2700 }),
  }),
);
log('5. POST /trading/preview →', preview.price, '| risk', preview.estimatedRisk, '| errors', JSON.stringify(preview.errors ?? []));

const order = await json(
  await fetch(`${BASE}/trading/orders`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: `sim-order-${Date.now()}`,
      mode: 'DEMO', symbol: 'XAUUSD', side: 'BUY', type: 'MARKET', volume: 0.01,
      stopLoss: 2600, takeProfit: 2700, confirm: true,
    }),
  }),
);
const report = order.report ?? order;
log('   POST /trading/orders → success:', report.success, '| ticket', report.ticket, '| @', report.executionPrice, '| status', report.status,
    report.success ? '' : `| ${order.error?.code ?? ''}: ${order.error?.message ?? JSON.stringify(order).slice(0, 160)}`);

const positions = await json(await fetch(`${BASE}/trading/positions?mode=DEMO`, { headers: auth, cache: 'no-store' }));
log('   positions:', positions.positions?.map((p) => `${p.side} ${p.volume} ${p.canonical} #${p.ticket} ${p.profit >= 0 ? '+' : ''}${p.profit}`).join(' ; '));

// --- 6. modify + close the same position over bearer ---------------------
const ticket = (order.report ?? order).ticket;
const modify = await json(
  await fetch(`${BASE}/trading/positions/${ticket}`, {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'DEMO', stopLoss: 2620, takeProfit: 2710, clientRequestId: `sim-mod-${Date.now()}` }),
  }),
);
const mod = modify.report ?? modify;
log('6. PATCH /trading/positions/' + ticket + ' →', mod.success, '| sl', mod.stopLoss ?? mod.position?.stopLoss ?? modify.error?.message);

const close = await json(
  await fetch(`${BASE}/trading/positions/${ticket}/close`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'DEMO', clientRequestId: `sim-close-${Date.now()}` }),
  }),
);
const done = close.report ?? close;
log('   POST close →', done.success, '| status', done.status, '| pl', done.profit ?? done.realizedPl ?? close.error?.message);

const history = await json(await fetch(`${BASE}/history?mode=DEMO&range=all`, { headers: auth, cache: 'no-store' }));
log('   history records:', history.trades?.length ?? history.items?.length ?? '?');
log('\nBEARER-TRANSPORT FLOW OK');
