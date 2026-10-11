import { useState } from 'react';
import type { AccountSummary, AccountType, MarketStatus } from '../../../shared/types';
import { ACCOUNT_TYPES, LEVERAGE_OPTIONS } from '../../../shared/types';
import { api, fmtMoney } from '../lib';

interface Props {
  summary: AccountSummary | null;
  connected: boolean;
  market: MarketStatus | null;
  onToast: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

export function TopBar({ summary, connected, market, onToast }: Props) {
  const [funds, setFunds] = useState<null | 'deposit' | 'withdraw' | 'reset'>(null);
  const [amount, setAmount] = useState('1000');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      onToast('success', ok);
      setFunds(null);
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const level = summary?.marginLevel ?? null;
  const levelClass = level === null ? '' : level <= 50 ? 'neg' : level < 100 ? 'warn' : 'pos';
  const feedsLive = market?.live.length ?? 0;
  const total = market ? market.live.length + market.simulated.length : 0;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">M</span>
        <div>
          <b>MadTrade</b>
          <small>DEMO</small>
        </div>
      </div>

      <div className="account-box">
        <small className="muted">{summary?.accountId ?? '—'} · USD</small>
        <div className="row-inline">
          <select
            value={summary?.settings.accountType ?? 'standard'}
            onChange={(e) =>
              run(() => api('PUT', '/api/account/settings', { accountType: e.target.value as AccountType }), 'Account type updated')
            }
            disabled={!summary || busy}
            title="Account type"
          >
            {(Object.keys(ACCOUNT_TYPES) as AccountType[]).map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPES[t].label}
              </option>
            ))}
          </select>
          <select
            value={summary?.settings.leverage ?? 100}
            onChange={(e) => run(() => api('PUT', '/api/account/settings', { leverage: Number(e.target.value) }), 'Leverage updated')}
            disabled={!summary || busy}
            title="Leverage"
          >
            {LEVERAGE_OPTIONS.map((l) => (
              <option key={l} value={l}>
                1:{l}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="stats">
        <Stat label="Balance" value={fmtMoney(summary?.balance)} />
        <Stat label="Equity" value={fmtMoney(summary?.equity)} />
        <Stat label="Floating P/L" value={fmtMoney(summary?.floatingPnl, { sign: true })} cls={(summary?.floatingPnl ?? 0) >= 0 ? 'pos' : 'neg'} />
        <Stat label="Margin" value={fmtMoney(summary?.margin)} />
        <Stat label="Free margin" value={fmtMoney(summary?.freeMargin)} />
        <Stat label="Margin level" value={level === null ? '—' : `${level.toFixed(0)}%`} cls={levelClass} />
        <Stat label="Day P/L" value={fmtMoney(summary?.dayPnl, { sign: true })} cls={(summary?.dayPnl ?? 0) >= 0 ? 'pos' : 'neg'} />
      </div>

      <div className="actions-top">
        <button className="primary" onClick={() => setFunds('deposit')} disabled={!summary}>
          Deposit
        </button>
        <button onClick={() => setFunds('withdraw')} disabled={!summary}>
          Withdraw
        </button>
        <button className="ghost" onClick={() => setFunds('reset')} disabled={!summary}>
          Reset
        </button>
        <span className={`conn ${connected ? 'ok' : 'bad'}`} title={connected ? 'Connected' : 'Reconnecting…'}>
          ● {connected ? 'Online' : 'Offline'}
        </span>
        {market && (
          <span className="feedinfo" title={market.feeds.map((f) => `${f.name}: ${f.connected ? 'connected' : f.enabled ? 'connecting' : 'off'}`).join('\n')}>
            {feedsLive}/{total} live
          </span>
        )}
      </div>

      {funds && (
        <div className="modal-backdrop" onClick={() => !busy && setFunds(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {funds === 'deposit' && 'Deposit demo funds'}
              {funds === 'withdraw' && 'Withdraw demo funds'}
              {funds === 'reset' && 'Reset demo account'}
            </h3>
            {funds === 'reset' ? (
              <>
                <p className="muted">
                  This clears positions, orders, history and the ledger, and restores a ${summary?.startingBalance ?? 10000} demo balance.
                </p>
                <div className="row-end">
                  <button onClick={() => setFunds(null)}>Cancel</button>
                  <button className="danger" disabled={busy} onClick={() => run(() => api('POST', '/api/account/reset'), 'Demo account reset')}>
                    Reset account
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="presets">
                  {[100, 1000, 10000, 50000].map((v) => (
                    <button key={v} onClick={() => setAmount(String(v))}>
                      ${v.toLocaleString('en-US')}
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>Amount (USD)</span>
                  <input className="num" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
                {funds === 'withdraw' && <small className="muted">Withdrawals are limited to free margin.</small>}
                <div className="row-end">
                  <button onClick={() => setFunds(null)}>Cancel</button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => api('POST', funds === 'deposit' ? '/api/account/deposit' : '/api/account/withdraw', { amount: Number(amount) }),
                        funds === 'deposit' ? 'Funds deposited' : 'Funds withdrawn',
                      )
                    }
                  >
                    {funds === 'deposit' ? 'Deposit' : 'Withdraw'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="stat">
      <small>{label}</small>
      <b className={`num ${cls}`}>{value}</b>
    </div>
  );
}
