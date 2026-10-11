import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  AccountStateFull,
  AccountStateLive,
  AccountSettings,
  AccountType,
  AgentLogEntry,
  AgentStatus,
  Bar,
  InstrumentSpec,
  MarketStatus,
  Quote,
  ServerMessage,
  Timeframe,
} from '../../shared/types';
import type { ACCOUNT_TYPES as AccountTypeMap } from '../../shared/types';

export type Tick = 'up' | 'down' | 'flat';

export interface QuoteView extends Quote {
  tick: Tick;
}

export interface Toast {
  id: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface TerminalState {
  connected: boolean;
  instruments: InstrumentSpec[];
  accountTypes: typeof AccountTypeMap | null;
  leverageOptions: readonly number[];
  market: MarketStatus | null;
  quotes: Record<string, QuoteView>;
  live: AccountStateLive | null;
  full: AccountStateFull | null;
  agent: AgentStatus | null;
  agentLogs: AgentLogEntry[];
  bar: { symbol: string; tf: Timeframe; bar: Bar } | null;
  toasts: Toast[];
}

type Action =
  | { type: 'connected'; value: boolean }
  | { type: 'message'; message: ServerMessage }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismiss'; id: number };

const initial: TerminalState = {
  connected: false,
  instruments: [],
  accountTypes: null,
  leverageOptions: [],
  market: null,
  quotes: {},
  live: null,
  full: null,
  agent: null,
  agentLogs: [],
  bar: null,
  toasts: [],
};

function applyQuotes(prev: Record<string, QuoteView>, quotes: Quote[]): Record<string, QuoteView> {
  const next: Record<string, QuoteView> = { ...prev };
  for (const q of quotes) {
    const old = prev[q.symbol];
    const tick: Tick = !old ? 'flat' : q.bid > old.bid ? 'up' : q.bid < old.bid ? 'down' : old.tick;
    next[q.symbol] = { ...q, tick };
  }
  return next;
}

let toastSeq = 1;

function reducer(state: TerminalState, action: Action): TerminalState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: action.value };
    case 'toast':
      return { ...state, toasts: [...state.toasts.slice(-4), action.toast] };
    case 'dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'message': {
      const m = action.message;
      switch (m.type) {
        case 'hello':
          return {
            ...state,
            instruments: m.instruments,
            accountTypes: m.accountTypes,
            leverageOptions: m.leverageOptions,
            market: m.market,
          };
        case 'quotes':
          return { ...state, quotes: applyQuotes(state.quotes, m.quotes) };
        case 'account':
          return { ...state, live: m.state };
        case 'account_full':
          return { ...state, full: m.state, live: m.state };
        case 'bar':
          return { ...state, bar: { symbol: m.symbol, tf: m.tf, bar: m.bar } };
        case 'agent':
          return { ...state, agent: m.status };
        case 'agent_log':
          return { ...state, agentLogs: [m.entry, ...state.agentLogs].slice(0, 200) };
        case 'agent_logs':
          return { ...state, agentLogs: m.entries };
        case 'market':
          return { ...state, market: m.market };
        case 'toast':
          return {
            ...state,
            toasts: [...state.toasts.slice(-4), { id: toastSeq++, level: m.level, message: m.message }],
          };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

export interface TerminalApi {
  state: TerminalState;
  subscribe: (symbol: string, tf: Timeframe) => void;
  dismiss: (id: number) => void;
  toast: (level: Toast['level'], message: string) => void;
}

/** Connects to /ws, keeps the terminal state in sync, and reconnects with backoff. */
export function useTerminal(): TerminalApi {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);
  const subRef = useRef<{ symbol: string; tf: Timeframe } | null>(null);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        dispatch({ type: 'connected', value: true });
        if (subRef.current) ws.send(JSON.stringify({ type: 'subscribe', ...subRef.current }));
      };
      ws.onmessage = (ev) => {
        try {
          dispatch({ type: 'message', message: JSON.parse(ev.data as string) as ServerMessage });
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        dispatch({ type: 'connected', value: false });
        if (closed) return;
        retry += 1;
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(retry, 5)));
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  const subscribe = useCallback((symbol: string, tf: Timeframe) => {
    subRef.current = { symbol, tf };
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', symbol, tf }));
  }, []);

  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), []);
  const toast = useCallback(
    (level: Toast['level'], message: string) => dispatch({ type: 'toast', toast: { id: toastSeq++, level, message } }),
    [],
  );

  return { state, subscribe, dismiss, toast };
}

export type { AccountSettings, AccountType };
