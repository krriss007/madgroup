import { useEffect, useRef, useState } from 'react';
import type { AgentConfig, AgentLogEntry, AgentStatus, ChatMessage, InstrumentSpec, StrategyId, Timeframe } from '../../../shared/types';
import { TIMEFRAMES } from '../../../shared/types';
import { api, fmtShortTime } from '../lib';

interface Props {
  status: AgentStatus | null;
  logs: AgentLogEntry[];
  instruments: InstrumentSpec[];
  onToast: (level: 'info' | 'success' | 'warn' | 'error', message: string) => void;
}

const STRATEGY_LABEL: Record<StrategyId, string> = {
  consensus: 'Consensus (2 of 3 vote)',
  ema_cross: 'EMA 9/21 crossover',
  rsi_reversion: 'RSI 14 reversal',
  breakout: 'Breakout (20-bar)',
};

export function AgentPanel({ status, logs, instruments, onToast }: Props) {
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Follow server-side changes unless the user has unsaved edits.
  const lastServerRef = useRef<string>('');
  useEffect(() => {
    if (!status) return;
    const serverJson = JSON.stringify(status.config);
    setDraft((prev) => (!prev || JSON.stringify(prev) === lastServerRef.current ? status.config : prev));
    lastServerRef.current = serverJson;
  }, [status]);

  useEffect(() => {
    api<ChatMessage[]>('GET', '/api/agent/chat').then(setChat).catch(() => {});
  }, []);

  if (!status || !draft) return <section className="panel agent"><div className="empty">Connecting to agent…</div></section>;

  const update = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => setDraft({ ...draft, [key]: value });

  const save = async (patch: Partial<AgentConfig>) => {
    setSaving(true);
    try {
      const next = await api<AgentStatus>('PUT', '/api/agent', patch);
      setDraft(next.config);
      onToast('success', patch.enabled === undefined ? 'Agent settings saved' : next.config.enabled ? 'AI agent started' : 'AI agent stopped');
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleSymbol = (symbol: string) => {
    const has = draft.symbols.includes(symbol);
    update('symbols', has ? draft.symbols.filter((s) => s !== symbol) : [...draft.symbols, symbol]);
  };

  const sendChat = async () => {
    const text = message.trim();
    if (!text) return;
    setMessage('');
    setChatBusy(true);
    setChat((c) => [...c, { role: 'user', content: text, time: Date.now() }]);
    try {
      setChat(await api<ChatMessage[]>('POST', '/api/agent/chat', { message: text }));
    } catch (err) {
      onToast('error', (err as Error).message);
    } finally {
      setChatBusy(false);
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(status.config);
  const statePill = status.halted ? 'halted' : status.config.enabled ? 'on' : 'off';
  const stateLabel = status.halted ? 'Halted' : status.config.enabled ? 'Running' : 'Stopped';
  const decisions = Object.entries(status.lastDecisions);

  return (
    <section className="panel agent">
      <header className="panel-head">
        <span className="panel-title">AI Agent</span>
        <span className={`pill ${statePill}`}>{stateLabel}</span>
      </header>

      <div className="agent-toggle">
        <div>
          <b>{status.config.enabled ? 'Agent is trading the demo account' : 'Agent is off'}</b>
          <small className="muted">
            {status.config.mode === 'llm' && !status.llm.configured
              ? 'LLM mode needs LLM_API_KEY; rules strategy will be used.'
              : status.config.mode === 'llm'
                ? `Using ${status.llm.model}`
                : 'Rules-based strategies. No API key needed.'}
          </small>
        </div>
        <button
          className={status.config.enabled ? 'danger' : 'primary'}
          disabled={saving}
          onClick={() => save({ enabled: !status.config.enabled })}
        >
          {status.config.enabled ? 'Stop' : 'Start'}
        </button>
      </div>

      <details className="settings" open>
        <summary>Strategy &amp; risk</summary>
        <div className="grid2">
          <label className="field">
            <span>Mode</span>
            <select value={draft.mode} onChange={(e) => update('mode', e.target.value as AgentConfig['mode'])}>
              <option value="rules">Rules</option>
              <option value="llm" disabled={!status.llm.configured}>
                AI model {status.llm.configured ? '' : '(no key)'}
              </option>
            </select>
          </label>
          <label className="field">
            <span>Timeframe</span>
            <select value={draft.timeframe} onChange={(e) => update('timeframe', e.target.value as Timeframe)}>
              {TIMEFRAMES.map((tf) => (
                <option key={tf}>{tf}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Strategy</span>
          <select
            value={draft.strategy}
            disabled={draft.mode === 'llm'}
            onChange={(e) => update('strategy', e.target.value as StrategyId)}
          >
            {(Object.keys(STRATEGY_LABEL) as StrategyId[]).map((s) => (
              <option key={s} value={s}>
                {STRATEGY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <div className="grid2">
          <NumField label="Risk / trade %" value={draft.riskPercent} step={0.1} onChange={(v) => update('riskPercent', v)} />
          <NumField label="Max open" value={draft.maxOpenPositions} step={1} onChange={(v) => update('maxOpenPositions', v)} />
          <NumField label="Stop loss × ATR" value={draft.slAtr} step={0.1} onChange={(v) => update('slAtr', v)} />
          <NumField label="Take profit × ATR" value={draft.tpAtr} step={0.1} onChange={(v) => update('tpAtr', v)} />
          <NumField label="Daily loss limit %" value={draft.maxDailyLossPercent} step={0.5} onChange={(v) => update('maxDailyLossPercent', v)} />
          {draft.mode === 'llm' && (
            <NumField label="AI min interval (s)" value={draft.llmIntervalSec} step={30} onChange={(v) => update('llmIntervalSec', v)} />
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={draft.allowFlip} onChange={(e) => update('allowFlip', e.target.checked)} />
          Flip position on opposite signal
        </label>
        <div className="symbols">
          {instruments.map((i) => (
            <label key={i.symbol} className={`chip ${draft.symbols.includes(i.symbol) ? 'on' : ''}`}>
              <input type="checkbox" checked={draft.symbols.includes(i.symbol)} onChange={() => toggleSymbol(i.symbol)} />
              {i.symbol}
            </label>
          ))}
        </div>
        <div className="row-end">
          <button disabled={!dirty || saving} onClick={() => save(draft)}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </details>

      {decisions.length > 0 && (
        <div className="decisions">
          {decisions.map(([sym, d]) => (
            <div key={sym} className="decision">
              <b>{sym}</b>
              <span className={`pill small ${d.action === 'buy' ? 'on' : d.action === 'sell' ? 'halted' : ''}`}>{d.action}</span>
              <small className="muted">{d.reason}</small>
            </div>
          ))}
        </div>
      )}

      <div className="log" ref={logRef}>
        {logs.length === 0 && <div className="empty">Agent activity appears here.</div>}
        {logs.map((l) => (
          <div key={l.id} className={`log-line ${l.level}`}>
            <span className="muted">{fmtShortTime(l.time)}</span>
            {l.symbol && <b>{l.symbol}</b>}
            <span>{l.message}</span>
          </div>
        ))}
      </div>

      <div className="chat">
        <div className="chat-msgs">
          {chat.length === 0 && <div className="muted small">Ask about your balance, positions or the agent's status.</div>}
          {chat.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.content}
            </div>
          ))}
          {chatBusy && <div className="msg assistant muted">…</div>}
        </div>
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            void sendChat();
          }}
        >
          <input value={message} placeholder="Ask the agent…" onChange={(e) => setMessage(e.target.value)} />
          <button disabled={chatBusy || !message.trim()}>Send</button>
        </form>
      </div>
    </section>
  );
}

function NumField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
