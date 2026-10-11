import { useState } from 'react';
import type { AccountStateFull, AccountStateLive, InstrumentSpec, PositionView } from '../../../shared/types';
import { api, fmtMoney, fmtPrice, fmtTime } from '../lib';

type Tab = 'positions' | 'pending' | 'orders' | 'history' | 'ledger';

interface Props {
  instruments: InstrumentSpec[];
  live: AccountStateLive | null;
  full: AccountStateFull | null;
  onToast: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

const specOf = (instruments: InstrumentSpec[], symbol: string) => instruments.find((i) => i.symbol === symbol);

export function BottomPanel({ instruments, live, full, onToast }: Props) {
  const [tab, setTab] = useState<Tab>('positions');
  const positions = live?.positions ?? [];
  const pending = live?.pending ?? [];
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) onToast('success', ok);
    } catch (err) {
      onToast('error', (err as Error).message);
    }
  };

  const totalPnl = positions.reduce((a, p) => a + p.profit, 0);

  return (
    <section className="panel bottom">
      <header className="tabs">
        <button className={`tab ${tab === 'positions' ? 'active' : ''}`} onClick={() => setTab('positions')}>
          Positions <span className="count">{positions.length}</span>
        </button>
        <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
          Pending <span className="count">{pending.length}</span>
        </button>
        <button className={`tab ${tab === 'orders' ? 'active' : ''}`} onClick={() => setTab('orders')}>
          Order history
        </button>
        <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
          Trade history
        </button>
        <button className={`tab ${tab === 'ledger' ? 'active' : ''}`} onClick={() => setTab('ledger')}>
          Account history
        </button>
        <span className="spacer" />
        {tab === 'positions' && positions.length > 0 && (
          <>
            <span className={`total ${totalPnl >= 0 ? 'pos' : 'neg'}`}>Floating P/L {fmtMoney(totalPnl, { sign: true })}</span>
            <button
              className="danger small-btn"
              onClick={() => run(() => api('POST', '/api/positions/close-all'), 'All positions closed')}
            >
              Close all
            </button>
          </>
        )}
      </header>

      <div className="table-wrap">
        {tab === 'positions' && <PositionsTable positions={positions} instruments={instruments} run={run} />}
        {tab === 'pending' && <PendingTable pending={pending} instruments={instruments} run={run} />}
        {tab === 'orders' && (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Ticket</th>
                <th>Symbol</th>
                <th>Type</th>
                <th>Side</th>
                <th className="num">Volume</th>
                <th className="num">Price</th>
                <th>Status</th>
                <th>Source</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {(full?.orders ?? []).map((o) => (
                <tr key={o.id}>
                  <td>{fmtTime(o.time)}</td>
                  <td className="num">{o.id}</td>
                  <td>{o.symbol}</td>
                  <td>{o.type}</td>
                  <td className={o.side === 'buy' ? 'buy-t' : 'sell-t'}>{o.side}</td>
                  <td className="num">{o.volume.toFixed(2)}</td>
                  <td className="num">{fmtPrice(o.fillPrice ?? o.price, specOf(instruments, o.symbol)?.digits ?? 5)}</td>
                  <td><span className={`status ${o.status}`}>{o.status}</span></td>
                  <td>{o.source}</td>
                  <td className="muted">{o.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'history' && (
          <table>
            <thead>
              <tr>
                <th>Closed</th>
                <th>Ticket</th>
                <th>Symbol</th>
                <th>Side</th>
                <th className="num">Volume</th>
                <th className="num">Open</th>
                <th className="num">Close</th>
                <th className="num">Commission</th>
                <th className="num">Swap</th>
                <th className="num">Profit</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {(full?.history ?? []).map((t) => {
                const d = specOf(instruments, t.symbol)?.digits ?? 5;
                return (
                  <tr key={t.id}>
                    <td>{fmtTime(t.closeTime)}</td>
                    <td className="num">{t.id}</td>
                    <td>{t.symbol}</td>
                    <td className={t.side === 'buy' ? 'buy-t' : 'sell-t'}>{t.side}</td>
                    <td className="num">{t.volume.toFixed(2)}</td>
                    <td className="num">{fmtPrice(t.openPrice, d)}</td>
                    <td className="num">{fmtPrice(t.closePrice, d)}</td>
                    <td className="num">{fmtMoney(t.commission)}</td>
                    <td className="num">{fmtMoney(t.swap)}</td>
                    <td className={`num ${t.profit >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(t.profit, { sign: true })}</td>
                    <td>{t.reason.replace('_', ' ')}{t.source === 'agent' ? ' · AI' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === 'ledger' && (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th className="num">Amount</th>
                <th className="num">Balance</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {(full?.ledger ?? []).map((l) => (
                <tr key={l.id}>
                  <td>{fmtTime(l.time)}</td>
                  <td>{l.type}</td>
                  <td className={`num ${l.amount >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(l.amount, { sign: true })}</td>
                  <td className="num">{fmtMoney(l.balanceAfter)}</td>
                  <td className="muted">{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function PositionsTable({ positions, instruments, run }: { positions: PositionView[]; instruments: InstrumentSpec[]; run: Run }) {
  if (positions.length === 0) return <div className="empty">No open positions. Place a trade or let the AI agent work.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Opened</th>
          <th>Symbol</th>
          <th>Side</th>
          <th className="num">Volume</th>
          <th className="num">Open</th>
          <th className="num">Current</th>
          <th className="num">Stop loss</th>
          <th className="num">Take profit</th>
          <th className="num">Swap</th>
          <th className="num">Profit</th>
          <th>Source</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <PositionRow key={p.id} p={p} digits={specOf(instruments, p.symbol)?.digits ?? 5} run={run} />
        ))}
      </tbody>
    </table>
  );
}

function PositionRow({ p, digits, run }: { p: PositionView; digits: number; run: Run }) {
  const [sl, setSl] = useState(p.sl?.toString() ?? '');
  const [tp, setTp] = useState(p.tp?.toString() ?? '');
  const [part, setPart] = useState('');
  const dirty = sl !== (p.sl?.toString() ?? '') || tp !== (p.tp?.toString() ?? '');

  const save = () =>
    run(
      () =>
        api('POST', `/api/positions/${p.id}/modify`, {
          sl: sl === '' ? null : Number(sl),
          tp: tp === '' ? null : Number(tp),
        }),
      `Modified #${p.id}`,
    );

  return (
    <tr>
      <td className="num">{p.id}</td>
      <td>{fmtTime(p.openTime)}</td>
      <td><b>{p.symbol}</b></td>
      <td className={p.side === 'buy' ? 'buy-t' : 'sell-t'}>{p.side}</td>
      <td className="num">{p.volume.toFixed(2)}</td>
      <td className="num">{fmtPrice(p.openPrice, digits)}</td>
      <td className="num">{fmtPrice(p.currentPrice, digits)}</td>
      <td className="num">
        <input className="num cell-input" value={sl} placeholder="—" onChange={(e) => setSl(e.target.value)} />
      </td>
      <td className="num">
        <input className="num cell-input" value={tp} placeholder="—" onChange={(e) => setTp(e.target.value)} />
      </td>
      <td className="num">{fmtMoney(p.swap)}</td>
      <td className={`num ${p.profit >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(p.profit, { sign: true })}</td>
      <td>{p.source === 'agent' ? <span className="ai-tag">AI</span> : 'Manual'}</td>
      <td className="actions">
        {dirty && <button onClick={save}>Save</button>}
        <input
          className="num cell-input narrow"
          placeholder={String(p.volume)}
          value={part}
          onChange={(e) => setPart(e.target.value)}
          aria-label="partial volume"
        />
        <button
          onClick={() =>
            run(() => api('POST', `/api/positions/${p.id}/close`, part === '' ? {} : { volume: Number(part) }), `Closed #${p.id}`)
          }
        >
          Close
        </button>
      </td>
    </tr>
  );
}

function PendingTable({ pending, instruments, run }: { pending: AccountStateLive['pending']; instruments: InstrumentSpec[]; run: Run }) {
  if (pending.length === 0) return <div className="empty">No pending orders.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Created</th>
          <th>Symbol</th>
          <th>Type</th>
          <th>Side</th>
          <th className="num">Volume</th>
          <th className="num">Price</th>
          <th className="num">SL</th>
          <th className="num">TP</th>
          <th>Source</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {pending.map((o) => (
          <tr key={o.id}>
            <td className="num">{o.id}</td>
            <td>{fmtTime(o.createdAt)}</td>
            <td>{o.symbol}</td>
            <td>{o.type}</td>
            <td className={o.side === 'buy' ? 'buy-t' : 'sell-t'}>{o.side}</td>
            <td className="num">{o.volume.toFixed(2)}</td>
            <td className="num">{fmtPrice(o.price, specOf(instruments, o.symbol)?.digits ?? 5)}</td>
            <td className="num">{o.sl ?? '—'}</td>
            <td className="num">{o.tp ?? '—'}</td>
            <td>{o.source === 'agent' ? <span className="ai-tag">AI</span> : 'Manual'}</td>
            <td className="actions">
              <button className="danger" onClick={() => run(() => api('DELETE', `/api/orders/${o.id}`), `Cancelled #${o.id}`)}>
                Cancel
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
