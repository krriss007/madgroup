/**
 * Regression check for the analytics panels.
 *
 * The dashboard crashed with:
 *   TypeError: Cannot read properties of undefined (reading 'slice')
 * because `/analytics` answers `{ mode, summary }` while the hook treated the
 * whole body as the summary, so `summary.dailyPl` was undefined.
 *
 * This renders the panel against four payloads — none of which may throw:
 *   1. null (still loading)
 *   2. the real summary from the running backend
 *   3. a stripped summary (no dailyPl / monthlyPl / distribution / bySymbol)
 *   4. the old buggy wrapper shape (`{ mode, summary }`) passed by mistake
 *
 * Run: npx tsx tests/manual/analytics-render-check.tsx
 */
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnalyticsPanels } from '../../frontend/components/dashboard/analytics-panels';
import type { AnalyticsSummary } from '@tradepilot/shared';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3000/api/v1';

function render(label: string, summary: unknown): string {
  try {
    const html = renderToStaticMarkup(<AnalyticsPanels summary={summary as AnalyticsSummary | null} />);
    console.log(`  ✓ ${label}`);
    return html;
  } catch (error) {
    console.error(`  ✗ ${label} — threw: ${(error as Error).message}`);
    process.exitCode = 1;
    return '';
  }
}

console.log('AnalyticsPanels render checks');

/* 1. loading / no data yet */
const loadingHtml = render('summary = null (loading state)', null);
assert.match(loadingHtml, /animate-pulse|skeleton|rounded/, 'loading state should render skeletons');

/* 2. the payload the backend actually sends */
const response = await fetch(`${API}/analytics?mode=DEMO`, { headers: { accept: 'application/json' } });
assert.equal(response.status, 200, `/analytics responded ${response.status}`);
const body = (await response.json()) as { mode: string; summary?: AnalyticsSummary };
console.log(`  · endpoint contract: keys = ${Object.keys(body).join(', ')}`);

const realHtml = render('real summary from /analytics', body.summary);
assert.match(realHtml, /Daily P\/L|No trades recorded/, 'the panel should render a data or empty state');

/* 3. a summary missing every optional series (the old crash path) */
const strippedHtml = render('summary without dailyPl/monthlyPl/distribution/bySymbol', {
  hasData: true,
  totalTrades: 3,
  wins: 2,
  losses: 1,
  breakEven: 0,
  netProfit: 12.5,
  grossProfit: 20,
  grossLoss: -7.5,
  totalCommission: 0.5,
  totalSwap: 0,
  maxDrawdown: 4,
  maxDrawdownPercent: 0.04,
} as unknown as AnalyticsSummary);
assert.match(strippedHtml, /Daily P\/L/, 'stripped payload should still render the panel frame');

/* 4. the historical bug: the wrapper passed as if it were the summary */
render('wrapper shape { mode, summary } (historical bug)', body as unknown as AnalyticsSummary);

/* 5. a completely empty summary object */
const emptyHtml = render('summary = {} (every field missing)', {});
assert.match(emptyHtml, /Simulated practice results are not real trading performance/, 'disclaimer should fall back');

/* 6. a summary whose series are present but empty */
const emptySeriesHtml = render('summary with empty series', {
  hasData: true,
  totalTrades: 0,
  dailyPl: [],
  monthlyPl: [],
  distribution: { buckets: [], winLoss: { wins: 0, losses: 0, breakEven: 0 } },
  bySymbol: [],
  equityCurve: [],
} as unknown as AnalyticsSummary);
assert.match(emptySeriesHtml, /No distribution available yet|No trades yet/, 'empty series should render empty states');

if (process.exitCode) {
  console.error('\nFAILED — a payload the backend can produce still breaks the panel.');
} else {
  console.log('\nAnalyticsPanels renders every payload shape without throwing.');
}
