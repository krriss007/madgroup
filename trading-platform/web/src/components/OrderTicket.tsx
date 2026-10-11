import { useEffect, useMemo, useState } from 'react';
import type { AccountSummary, InstrumentSpec, OrderType, Quote, Side } from '../../../shared/types';
import type { QuoteView } from '../useTerminal';
import { api, estimateMargin, estimateProfit, fmtMoney, fmtPrice } from '../lib';
import { ACCOUNT_TYPES } from '../../../shared/types';
import type { AccountType } from '../../../shared/types';

interface Props {
  spec: InstrumentSpec;
  quote: QuoteView | undefined;
  quotes: Record<string, Quote>;
  summary: AccountSummary | null;
  accountType: AccountType;
  onToast: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

const PRESETS = [0.01, 0.1, 0.5, 1];

export function OrderTicket({ spec, quote, quotes, summary, accountType, onToast }: Props) {
  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>('market');
  const [volume, setVolume] = useState<string>('0.10');
  const [price, setPrice] = useState<string>('');
  const [sl, setSl] = useState<string>('');
  const [tp, setTp] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset levels when the instrument changes.
  useEffect(() => {
    setSl('');
    setTp('');
    setError(null);
    setPrice('');
  }, [spec.symbol]);

  const bid = quote?.bid ?? null;
  const ask = quote?.ask ?? null;
  const refPrice = type === 'market' ? (side === 'buy' ? ask : bid) : Number(price) || (side === 'buy' ? ask : bid);
  const vol = Number(volume);
  const leverage = summary?.settings.leverage ?? 100;

  const estimates = useMemo(() => {
    if (!refPrice || !Number.isFinite(vol) || vol <= 0) return null;
    const margin = estimateMargin(spec, vol, refPrice, leverage, quotes);
    const commissionPerLot = ACCOUNT_TYPES[accountType].commissionPerLot;
    const commission = commissionPerLot * vol;
    const slN = Number(sl);
    const tpN = Number(tp);
    const lossAtSl = sl !== '' && Number.isFinite(slN) && slN > 0 ? estimateProfit(spec, side, vol, refPrice, slN, quotes) : null;
    const profitAtTp = tp !== '' && Number.isFinite(tpN) && tpN > 0 ? estimateProfit(spec, side, vol, refPrice, tpN, quotes) : null;
    return { margin, commission, lossAtSl, profitAtTp };
  }, [refPrice, vol, spec, leverage, quotes, accountType, sl, tp, side]);

  const insufficient = estimates && summary ? estimates.margin + estimates.commission > summary.freeMargin : false;

  const submit = async () => {
    setError(null);
    const body: Record<string, unknown> = {
      symbol: spec.symbol,
      side,
      type,
      volume: vol,
      sl: sl === '' ? null : Number(sl),
      tp: tp === '' ? null : Number(tp),
    };
    if (type !== 'market') body.price = Number(price);
    setBusy(true);
    try {
      await api('POST', '/api/orders', body);
      onToast('success', `${side === 'buy' ? 'Buy' : 'Sell'} ${type === 'market' ? 'order filled' : `${type} order placed`} · ${vol} ${spec.symbol}`);
      if (type === 'market') {
        setSl('');
        setTp('');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const bump = (delta: number) => {
    const next = Math.max(spec.minVolume, Math.round((vol + delta) * 100) / 100);
    setVolume(next.toFixed(2));
  };

  const pendingLabel = type === 'limit' ? (side === 'buy' ? 'below ask' : 'above bid') : side === 'buy' ? 'above ask' : 'below bid';

  return (
    <section className="panel ticket">
      <header className="panel-head">
        <span className="panel-title">
          {spec.symbol} <small className="muted">{spec.name}</small>
        </span>
        <span className="muted small">spread {quote ? fmtPrice(quote.ask - quote.bid, spec.digits) : '—'}</span>
      </header>

      <div className="quote-buttons">
        <button className={`qbtn sell ${side === 'sell' ? 'active' : ''}`} onClick={() => setSide('sell')}>
          <span>SELL</span>
          <b className="num">{fmtPrice(bid, spec.digits)}</b>
        </button>
        <button className={`qbtn buy ${side === 'buy' ? 'active' : ''}`} onClick={() => setSide('buy')}>
          <span>BUY</span>
          <b className="num">{fmtPrice(ask, spec.digits)}</b>
        </button>
      </div>

      <div className="seg">
        {(['market', 'limit', 'stop'] as OrderType[]).map((t) => (
          <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
            {t === 'market' ? 'Market' : t === 'limit' ? 'Limit' : 'Stop'}
          </button>
        ))}
      </div>

      {type !== 'market' && (
        <label className="field">
          <span>Price <small className="muted">({pendingLabel})</small></span>
          <input className="num" inputMode="decimal" value={price} placeholder={fmtPrice(refPrice, spec.digits)} onChange={(e) => setPrice(e.target.value)} />
        </label>
      )}

      <label className="field">
        <span>Volume <small className="muted">lots</small></span>
        <div className="stepper">
          <button onClick={() => bump(-0.01)} aria-label="decrease volume">−</button>
          <input className="num" inputMode="decimal" value={volume} onChange={(e) => setVolume(e.target.value)} />
          <button onClick={() => bump(0.01)} aria-label="increase volume">+</button>
        </div>
      </label>
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p} onClick={() => setVolume(p.toFixed(2))}>
            {p}
          </button>
        ))}
      </div>

      <div className="two">
        <label className="field">
          <span>Stop loss</span>
          <input className="num" inputMode="decimal" value={sl} placeholder="—" onChange={(e) => setSl(e.target.value)} />
        </label>
        <label className="field">
          <span>Take profit</span>
          <input className="num" inputMode="decimal" value={tp} placeholder="—" onChange={(e) => setTp(e.target.value)} />
        </label>
      </div>

      <dl className="estimates">
        <div>
          <dt>Margin required</dt>
          <dd className={insufficient ? 'neg' : ''}>{estimates ? fmtMoney(estimates.margin) : '—'}</dd>
        </div>
        <div>
          <dt>Commission</dt>
          <dd>{estimates ? fmtMoney(estimates.commission) : '—'}</dd>
        </div>
        <div>
          <dt>Loss at SL</dt>
          <dd className="neg">{estimates?.lossAtSl !== null && estimates?.lossAtSl !== undefined ? fmtMoney(estimates.lossAtSl) : '—'}</dd>
        </div>
        <div>
          <dt>Profit at TP</dt>
          <dd className="pos">{estimates?.profitAtTp !== null && estimates?.profitAtTp !== undefined ? fmtMoney(estimates.profitAtTp, { sign: true }) : '—'}</dd>
        </div>
        <div>
          <dt>Free margin</dt>
          <dd>{summary ? fmtMoney(summary.freeMargin) : '—'}</dd>
        </div>
      </dl>

      {insufficient && <div className="form-error">Not enough free margin for this order at 1:{leverage}.</div>}
      {error && <div className="form-error">{error}</div>}

      <button className={`submit ${side}`} disabled={busy || !quote} onClick={submit}>
        {busy ? 'Sending…' : `${type === 'market' ? 'Place' : 'Place pending'} ${side === 'buy' ? 'Buy' : 'Sell'} ${volume} lots`}
      </button>
      <small className="muted">Demo account. Prices are {quote?.source === 'live' ? 'live' : 'simulated'}.</small>
    </section>
  );
}
