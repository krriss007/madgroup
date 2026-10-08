/**
 * TradePilot — frontend/backend payload contract check.
 *
 * Every field below is one the UI actually reads. When the dashboard broke with
 * "Cannot read properties of undefined (reading 'slice')" the cause was a shape
 * mismatch (`/analytics` answers `{ mode, summary }`, the hook expected a bare
 * summary). This script asserts the contract line by line so a payload change
 * fails here — in a test — instead of in the browser.
 *
 * Run: node tests/manual/contract-check.mjs [API_BASE]
 */
const API = process.argv[2] ?? process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';

const failures = [];
let checks = 0;

function pathValue(object, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
}

/**
 * Assert that each dotted path exists in the response.
 *
 * A path prefixed with `?` may legitimately be null/empty (no MT5 bridge
 * connected, no live account yet) — those must still be *present* as keys, which
 * is what the UI checks for before it renders.
 */
function expectFields(label, body, paths) {
  for (const rawPath of paths) {
    const optional = rawPath.startsWith('?');
    const path = optional ? rawPath.slice(1) : rawPath;
    checks++;
    const value = pathValue(body, path);
    if (value !== undefined && (optional || value !== null)) continue;

    // `summary.winRate` is `number | null` by design: it is null only while the
    // account has no closed trades, where a percentage would be meaningless.
    // Accept null there *only* when the response itself reports zero trades, so
    // losing the field for a traded account still fails this check.
    if (path.endsWith('winRate') && value === null && pathValue(body, 'summary.trades') === 0) continue;
    if (path.endsWith('winRate') && value === null && pathValue(body, 'summary.totalTrades') === 0) continue;

    failures.push(`${label}: missing "${path}"`);
  }
}

async function get(label, url, paths) {
  const response = await fetch(`${API}${url}`, { headers: { accept: 'application/json' } });
  if (response.status !== 200) {
    failures.push(`${label}: HTTP ${response.status} from ${url}`);
    return null;
  }
  const body = await response.json();
  if (paths?.length) expectFields(label, body, paths);
  console.log(`  ${label.padEnd(26)} 200`);
  return body;
}

console.log(`Payload contract check → ${API}`);

const account = await get('GET /account', '/account?mode=DEMO', ['mode', 'account.balance', 'account.equity', 'account.currency', 'risk.locked']);
await get('GET /account/risk', '/account/risk?mode=DEMO', [
  'mode',
  'risk.tradingEnabled',
  'risk.locked',
  'risk.dailyLossLimitAmount',
  'risk.dailyRealizedLoss',
  'risk.openPositionsCount',
  'risk.remainingRiskToday',
  'settings.maxRiskPerTradePercent',
  'settings.maxDailyLossPercent',
  'settings.maxOpenPositions',
  'settings.maxLotSize',
  'settings.tradingHoursEnabled',
  'presets',
]);
await get('GET /account/portfolio', '/account/portfolio?mode=DEMO', ['series', 'headline.dayPl', 'headline.totalPl', 'headline.openPl']);

/* the shape the dashboard's analytics panel depends on */
const analytics = await get('GET /analytics', '/analytics?mode=DEMO', [
  'mode',
  'summary',
  'summary.hasData',
  'summary.totalTrades',
  'summary.netProfit',
  'summary.winRate',
  'summary.grossProfit',
  'summary.grossLoss',
  'summary.totalCommission',
  'summary.totalSwap',
  'summary.maxDrawdown',
  'summary.maxDrawdownPercent',
  'summary.dailyPl',
  'summary.monthlyPl',
  'summary.distribution.buckets',
  'summary.distribution.winLoss.wins',
  'summary.distribution.winLoss.losses',
  'summary.distribution.winLoss.breakEven',
  'summary.bySymbol',
  'summary.equityCurve',
  'summary.disclaimer',
]);
if (analytics && Array.isArray(analytics.summary?.dailyPl) === false) failures.push('GET /analytics: summary.dailyPl must be an array (the UI calls .slice on it)');

await get('GET /watchlists', '/watchlists?mode=DEMO', ['mode', 'watchlist.id', 'items', 'quotes', 'online', 'defaults']);
await get('GET /market/symbols', '/market/symbols?mode=DEMO', ['mode', 'count', 'symbols']);
await get('GET /market/instruments', '/market/instruments', ['instruments']);
await get('GET /market/status', '/market/status', ['mode', 'online', '?message', 'symbolCount', '?mt5', 'serverTime']);
await get('GET /trading/positions', '/trading/positions?mode=DEMO', ['mode', 'positions', 'totals.count']);
await get('GET /trading/orders', '/trading/orders?mode=DEMO', ['mode', 'orders']);
await get('GET /settings/risk', '/settings/risk?mode=DEMO', [
  'settings.maxRiskPerTradePercent',
  'settings.maxDailyLossPercent',
  'settings.maxOpenPositions',
  'settings.maxTotalExposureLots',
  'settings.maxLotSize',
  'settings.requireLiveConfirmation',
  'presets',
]);
// `mt5` is null until a terminal connects — the status card reads it exactly that way.
await get('GET /settings/mt5/status', '/settings/mt5/status', ['status', '?mt5', 'message', 'liveTradingEnabled', 'tradeAllowed', 'algoTradingEnabled']);
await get('GET /settings/mt5', '/settings/mt5', ['connections', '?active', 'online', '?liveAccount', 'commandStats', 'heartbeatTimeoutMs', 'instructions', 'warnings', 'credentialsPolicy']);
await get('GET /notifications', '/notifications', ['notifications', 'unread']);
await get('GET /journal', '/journal?mode=DEMO', ['entries']);
await get('GET /alerts', '/alerts?mode=DEMO', ['alerts']);
await get('GET /history', '/history?mode=DEMO&range=30d', ['mode', 'range.label', 'trades', 'total', 'summary.trades', 'summary.volume', 'summary.netProfit', 'summary.wins', 'summary.losses', 'summary.commission', 'summary.swap', 'summary.winRate']);
// liveAccount is null until an MT5 account is linked; the top bar switches on it.
await get('GET /auth/session', '/auth/session', ['user.email', 'accounts', 'activeAccount.login', '?liveAccount', 'liveTradingEnabled', 'killSwitchEngaged']);

/* quotes, candles and the order funnel */
const quotes = await get('GET /market/quotes', '/market/quotes?symbols=XAUUSD,EURUSD', ['mode', 'quotes']);
if (quotes?.quotes?.length) {
  expectFields('GET /market/quotes', quotes.quotes[0], ['symbol', 'canonical', 'bid', 'ask', 'spread', 'spreadPoints', 'digits', 'high', 'low', 'open', 'close', 'changePercent', 'time', 'source']);
} else {
  failures.push('GET /market/quotes: expected at least one DEMO quote');
}

const candles = await get('GET /market/candles', '/market/candles?symbol=XAUUSD&timeframe=M15&limit=50', ['mode', 'source', 'symbol', 'canonical', 'timeframe', 'candles', 'atr', 'count']);
if (candles?.candles?.length) expectFields('GET /market/candles', candles.candles[0], ['time', 'open', 'high', 'low', 'close', 'volume']);

const preview = await fetch(`${API}/trading/preview`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
  body: JSON.stringify({ clientRequestId: `contract-${Date.now()}`, mode: 'DEMO', symbol: 'XAUUSD', side: 'BUY', type: 'MARKET', volume: 0.01 }),
});
if (preview.status === 200) {
  const body = await preview.json();
  expectFields('POST /trading/preview', body, [
    'symbol',
    'canonical',
    'mode',
    'side',
    'type',
    'price',
    'volume',
    'lots',
    'spread',
    'spreadPoints',
    'estimatedRisk',
    'estimatedReward',
    // riskReward is null without a stop loss; confirmationText/liveWarning only
    // exist for LIVE orders — the UI treats all three as optional.
    '?riskReward',
    'maxRiskAmount',
    'riskPercentOfBalance',
    'checks',
    'errors',
    'warnings',
    'requiresConfirmation',
    '?confirmationText',
    '?liveWarning',
  ]);
  console.log('  POST /trading/preview     200');
} else {
  failures.push(`POST /trading/preview: HTTP ${preview.status}`);
}

console.log(`\n${checks} field checks, ${failures.length} failure(s)`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('Every field the UI reads is present in the payloads the backend returns.');
