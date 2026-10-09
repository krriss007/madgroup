'use client';

/**
 * TerminalProvider — the single source of UI state for the trading terminal.
 *
 * Holds the session, the active account, positions, pending orders, live
 * quotes, MT5 connection state and notifications, and keeps them up to date
 * through the WebSocket (`/ws`). Trading actions go through the REST API and
 * then update local state from the response plus the realtime stream.
 *
 * Nothing here decides whether an order is allowed: the backend validates every
 * request, and DEMO/LIVE are strictly separated by the mode switch.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  BrokerAccount,
  ClientMessage,
  Mt5Connection,
  Notification,
  PendingOrder,
  Position,
  Quote,
  RiskStatus,
  ServerMessage,
  TradingMode,
  UserProfile,
} from '@tradepilot/shared';
import { api, ApiError, autoLoginSuppressed, clearSession, enterDemoSession, suppressAutoLogin } from './api';

import { randomId } from './utils';

export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  createdAt: number;
}

export interface SessionSnapshot {
  user: UserProfile;
  activeAccount: BrokerAccount;
  liveAccount: BrokerAccount | null;
  liveTradingEnabled: boolean;
  killSwitchEngaged: boolean;
}

export interface ConnectionState {
  status: 'CONNECTED' | 'DEGRADED' | 'OFFLINE';
  mt5: Mt5Connection | null;
  lastHeartbeatAgeSeconds: number | null;
  message: string | null;
}

export interface OrderPreview {
  symbol: string;
  canonical: string;
  mode: TradingMode;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  price: number;
  volume: number;
  stopLoss: number | null;
  takeProfit: number | null;
  spread: number;
  spreadPoints: number;
  maxRiskAmount: number;
  estimatedRisk: number;
  estimatedReward: number;
  riskReward: number | null;
  riskPercentOfBalance: number;
  lots: {
    status: 'ok' | 'clamped' | 'invalid';
    reasons: string[];
    volume: number;
    rawVolume: number;
    actualRiskAmount: number;
    potentialLoss: number;
    potentialProfit: number;
    units: number;
    lossPerLot: number;
    stopDistance: number;
    stopDistancePoints: number;
    estimatedMargin: number;
    warnings: string[];
  };
  warnings: string[];
  errors: { code: string; message: string }[];
  requiresConfirmation: boolean;
  confirmationText: string | null;
  liveWarning: string | null;
  checks: { rule: string; ok: boolean; detail: string }[];
}

export interface OrderDraft {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  volume: number;
  price?: number | null;
  stopLimitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  expiration?: string | null;
  comment?: string | null;
}

interface TerminalContextValue {
  ready: boolean;
  authenticated: boolean;
  session: SessionSnapshot | null;
  mode: TradingMode;
  account: BrokerAccount | null;
  risk: RiskStatus | null;
  positions: Position[];
  orders: PendingOrder[];
  quotes: Record<string, Quote>;
  quoteSources: Record<string, 'MT5' | 'DEMO_SIMULATED'>;
  watchlist: string[];
  watchlistId: string | null;
  connection: ConnectionState;
  notifications: Notification[];
  unreadNotifications: number;
  toasts: Toast[];
  liveTradingEnabled: boolean;
  realtimeConnected: boolean;
  setMode: (mode: TradingMode) => Promise<void>;
  refresh: () => Promise<void>;
  loadWatchlist: (symbols: string[]) => void;
  addToWatchlist: (symbol: string) => Promise<void>;
  removeFromWatchlist: (canonical: string) => Promise<void>;
  previewOrder: (draft: OrderDraft, options?: { riskPercent?: number | null }) => Promise<OrderPreview>;
  placeOrder: (draft: OrderDraft, options?: { confirmed?: boolean; riskPercent?: number | null }) => Promise<{ success: boolean; ticket?: string | null; message: string }>;
  modifyPosition: (ticket: string, patch: { stopLoss?: number | null; takeProfit?: number | null }) => Promise<void>;
  closePosition: (ticket: string, options?: { confirm?: string; volume?: number | null }) => Promise<void>;
  closeAllPositions: (confirm: string, symbol?: string | null) => Promise<void>;
  cancelOrder: (ticket: string) => Promise<void>;
  cancelAllOrders: (confirm?: string) => Promise<void>;
  enableLiveTrading: (acknowledged: boolean) => Promise<void>;
  disableLiveTrading: (reason?: string) => Promise<void>;
  markNotificationsRead: () => Promise<void>;
  pushToast: (toast: Omit<Toast, 'id' | 'createdAt'>) => void;
  dismissToast: (id: string) => void;
  logout: () => Promise<void>;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

const WS_CHANNELS = ['quotes', 'account', 'positions', 'orders', 'connection', 'risk'];

export function TerminalProvider({ children }: { children: ReactNode }): JSX.Element {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [mode, setModeState] = useState<TradingMode>('DEMO');
  const [account, setAccount] = useState<BrokerAccount | null>(null);
  const [risk, setRisk] = useState<RiskStatus | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [liveTradingEnabled, setLiveTradingEnabled] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({ status: 'OFFLINE', mt5: null, lastHeartbeatAgeSeconds: null, message: null });
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadNotifications, setUnread] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchlistId, setWatchlistId] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const watchlistRef = useRef<string[]>([]);
  const modeRef = useRef<TradingMode>('DEMO');

  const pushToast = useCallback((toast: Omit<Toast, 'id' | 'createdAt'>) => {
    const entry: Toast = { ...toast, id: randomId('toast'), createdAt: Date.now() };
    setToasts((current) => [...current.slice(-4), entry]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== entry.id)), toast.level === 'error' ? 9_000 : 5_500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const reportError = useCallback(
    (error: unknown, fallbackTitle: string) => {
      if (error instanceof ApiError) {
        pushToast({ level: 'error', title: fallbackTitle, message: error.message });
        return error.message;
      }
      const message = error instanceof Error ? error.message : 'Unexpected error.';
      pushToast({ level: 'error', title: fallbackTitle, message });
      return message;
    },
    [pushToast],
  );

  /* ------------------------------------------------------------------ */
  /* session bootstrap                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * One silent demo re-entry per 10 s, shared by every 401 path, so a lost
   * session recovers on its own without ever turning into a retry loop.
   */
  const lastReentryRef = useRef(0);
  const silentReentry = useCallback(async (): Promise<boolean> => {
    if (autoLoginSuppressed()) return false;
    const now = Date.now();
    if (now - lastReentryRef.current < 10_000) return false;
    lastReentryRef.current = now;
    try {
      const entry = await enterDemoSession();
      if (!entry) return false;
      setSession({
        user: entry.data.user as unknown as UserProfile,
        activeAccount: entry.data.account as unknown as BrokerAccount,
        liveAccount: null,
        liveTradingEnabled: false,
        killSwitchEngaged: false,
      });
      setLiveTradingEnabled(false);
      setAuthenticated(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const loadSession = useCallback(async (): Promise<boolean> => {
    try {
      const data = await api.get<SessionSnapshot & { user: UserProfile }>('/auth/session');
      setSession({
        user: data.user,
        activeAccount: data.activeAccount,
        liveAccount: data.liveAccount ?? null,
        liveTradingEnabled: data.liveTradingEnabled,
        killSwitchEngaged: data.killSwitchEngaged,
      });
      setLiveTradingEnabled(data.liveTradingEnabled);
      setAuthenticated(true);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // The stored session (cookie or bearer token) is gone or expired:
        // drop the bearer copy so the next sign-in negotiates from scratch.
        clearSession();

        // DEMO_AUTO_LOGIN instances fall straight into the shared demo account
        // instead of showing a sign-in wall. Suppressed after an explicit
        // sign-out so "sign out" stays meaningful.
        if (await silentReentry()) {
          pushToast({
            level: 'info',
            title: 'DEMO auto-entry',
            message: 'Signed in to the shared demo account of this instance — no password needed (DEMO_AUTO_LOGIN).',
          });
          return true;
        }

        setAuthenticated(false);
        setSession(null);
        return false;
      }
      reportError(error, 'Could not load your session');
      return false;
    } finally {
      setReady(true);
    }
  }, [reportError]);

  const loadSnapshot = useCallback(
    async (targetMode: TradingMode) => {
      const [accountData, positionsData, ordersData, watchlistData, notificationsData, connectionData, riskData] = await Promise.all([
        api.get<{ account: BrokerAccount; risk: RiskStatus; liveTradingEnabled: boolean }>('/account', { mode: targetMode }),
        api.get<{ positions: Position[] }>('/trading/positions', { mode: targetMode }),
        api.get<{ orders: PendingOrder[] }>('/trading/orders', { mode: targetMode }),
        api.get<{ watchlist: { id: string }; items: { canonical: string }[]; quotes: Quote[] }>('/watchlists', { mode: targetMode }),
        api.get<{ notifications: Notification[]; unread: number }>('/notifications'),
        api.get<{ status: string; mt5: Mt5Connection | null; lastHeartbeatAgeSeconds: number | null; message: string }>('/settings/mt5/status'),
        api.get<{ risk: RiskStatus }>('/account/risk', { mode: targetMode }),
      ]);

      setAccount(accountData.account);
      setRisk(riskData.risk ?? accountData.risk);
      setLiveTradingEnabled(accountData.liveTradingEnabled);
      setPositions(positionsData.positions);
      setOrders(ordersData.orders);
      setNotifications(notificationsData.notifications);
      setUnread(notificationsData.unread);
      setConnection({
        status: connectionData.status === 'CONNECTED' ? 'CONNECTED' : 'OFFLINE',
        mt5: connectionData.mt5,
        lastHeartbeatAgeSeconds: connectionData.lastHeartbeatAgeSeconds,
        message: connectionData.message,
      });

      const symbols = watchlistData.items.map((item) => item.canonical);
      setWatchlistId(watchlistData.watchlist?.id ?? null);
      setWatchlist(symbols);
      watchlistRef.current = symbols;
      if (watchlistData.quotes?.length) {
        setQuotes((current) => {
          const next = { ...current };
          for (const quote of watchlistData.quotes) next[quote.canonical] = quote;
          return next;
        });
      }
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      await loadSnapshot(modeRef.current);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // The session vanished between calls (expired, revoked, or a frame that
        // could not keep it): try the silent demo re-entry once, else the shell
        // redirects to the sign-in page.
        if (await silentReentry()) {
          await refresh();
          return;
        }
        setAuthenticated(false);
        return;
      }
      reportError(error, 'Refresh failed');
    }
  }, [loadSnapshot, reportError]);

  useEffect(() => {
    void (async () => {
      const ok = await loadSession();
      if (ok) await refresh();
    })();
  }, [loadSession, refresh]);

  const addToWatchlist = useCallback(
    async (symbol: string) => {
      if (!watchlistId) {
        pushToast({ title: 'Watchlist unavailable', message: 'Reload the page and try again.', level: 'error' });
        return;
      }
      const spec = await api
        .post<{ item: { canonical: string } }>(`/watchlists/${watchlistId}/items`, { symbol, mode: modeRef.current })
        .catch((error: unknown) => {
          reportError(error, `Could not add ${symbol} to the watchlist`);
          return null;
        });
      if (spec) await refresh();
    },
    [pushToast, refresh, reportError, watchlistId],
  );

  const removeFromWatchlist = useCallback(
    async (canonical: string) => {
      if (!watchlistId) return;
      try {
        await api.delete(`/watchlists/${watchlistId}/items/${encodeURIComponent(canonical)}`);
        await refresh();
      } catch (error) {
        reportError(error, `Could not remove ${canonical} from the watchlist`);
      }
    },
    [refresh, reportError, watchlistId],
  );

  /* ------------------------------------------------------------------ */
  /* websocket                                                           */
  /* ------------------------------------------------------------------ */

  const connectSocket = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socketRef.current = socket;

    const subscribe = (): void => {
      const message: ClientMessage = {
        type: 'subscribe',
        symbols: watchlistRef.current,
        channels: WS_CHANNELS,
      };
      socket.send(JSON.stringify(message));
    };

    socket.onopen = () => {
      setRealtimeConnected(true);
      subscribe();
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case 'quotes': {
          // Second line of defence for the DEMO/LIVE separation. The server only
          // streams quotes that match the socket's mode (and flips that mode on
          // `switch_mode`), but a socket that reconnects while the terminal is in
          // LIVE mode is greeted with a DEMO snapshot before it can re-announce
          // itself. Dropping mismatched sources here means a simulated price can
          // never be painted on a live screen, not even for one frame.
          const wanted = modeRef.current;
          const accepted = message.quotes.filter((quote) =>
            wanted === 'LIVE' ? quote.source === 'MT5' : quote.source === 'DEMO_SIMULATED',
          );
          if (!accepted.length) break;
          setQuotes((current) => {
            const next = { ...current };
            for (const quote of accepted) next[quote.canonical] = quote;
            return next;
          });
          break;
        }
        case 'account':
          setAccount(message.account);
          setRisk(message.risk);
          break;
        case 'positions':
          setPositions(message.positions);
          break;
        case 'orders':
          setOrders(message.orders);
          break;
        case 'risk':
          setRisk(message.risk);
          break;
        case 'connection':
          setConnection({
            status: message.status,
            mt5: message.mt5,
            lastHeartbeatAgeSeconds: message.lastHeartbeatAgeSeconds,
            message: message.message,
          });
          break;
        case 'notification':
          setNotifications((current) => [message.notification, ...current].slice(0, 60));
          setUnread((count) => count + 1);
          pushToast({
            level: message.notification.level === 'critical' ? 'error' : message.notification.level === 'warning' ? 'warning' : 'info',
            title: message.notification.title,
            message: message.notification.message,
          });
          break;
        case 'trade':
          pushToast({
            level: message.trade.netProfit >= 0 ? 'success' : 'warning',
            title: `${message.trade.side} ${message.trade.canonical} closed`,
            message: `Net P/L ${message.trade.netProfit.toFixed(2)} ${message.trade.mode === 'DEMO' ? '(simulated)' : ''}`.trim(),
          });
          void refresh();
          break;
        case 'alert':
          pushToast({ level: 'info', title: `${message.symbol} alert`, message: message.message });
          break;
        case 'error':
          pushToast({ level: 'warning', title: 'Realtime warning', message: message.message });
          break;
        default:
          break;
      }
    };

    socket.onclose = () => {
      setRealtimeConnected(false);
      socketRef.current = null;
      if (reconnectRef.current) return;
      reconnectRef.current = window.setTimeout(() => {
        reconnectRef.current = null;
        if (document.visibilityState !== 'hidden') connectSocket();
      }, 3_000);
    };

    socket.onerror = () => {
      setRealtimeConnected(false);
    };
  }, [pushToast, refresh]);

  useEffect(() => {
    if (!authenticated) return undefined;
    connectSocket();
    const ping = setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);
    return () => {
      clearInterval(ping);
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [authenticated, connectSocket]);

  const loadWatchlist = useCallback(
    (symbols: string[]) => {
      setWatchlist(symbols);
      watchlistRef.current = symbols;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'subscribe', symbols, channels: WS_CHANNELS }));
      }
    },
    [],
  );

  /* ------------------------------------------------------------------ */
  /* mode switching                                                      */
  /* ------------------------------------------------------------------ */

  const setMode = useCallback(
    async (next: TradingMode) => {
      setModeState(next);
      modeRef.current = next;
      setPositions([]);
      setOrders([]);
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'switch_mode', mode: next }));
      try {
        await loadSnapshot(next);
      } catch (error) {
        reportError(error, `Could not switch to ${next} mode`);
      }
    },
    [loadSnapshot, reportError],
  );

  /* ------------------------------------------------------------------ */
  /* trading actions                                                     */
  /* ------------------------------------------------------------------ */

  const previewOrder = useCallback(
    async (draft: OrderDraft, options?: { riskPercent?: number | null }): Promise<OrderPreview> => {
      const preview = await api.post<OrderPreview>('/trading/preview', {
        mode: modeRef.current,
        ...draft,
        useRiskBasedSize: Boolean(options?.riskPercent),
        riskPercent: options?.riskPercent ?? null,
        clientRequestId: randomId('preview'),
      });
      return preview;
    },
    [],
  );

  const placeOrder = useCallback(
    async (draft: OrderDraft, options?: { confirmed?: boolean; riskPercent?: number | null }) => {
      try {
        const response = await api.post<{
          success: boolean;
          ticket: string | null;
          executionPrice: number | null;
          volume: number | null;
          position?: Position | null;
        }>('/trading/orders', {
          mode: modeRef.current,
          ...draft,
          confirmed: options?.confirmed ?? modeRef.current === 'DEMO',
          useRiskBasedSize: Boolean(options?.riskPercent),
          riskPercent: options?.riskPercent ?? null,
          clientRequestId: randomId('order'),
        });

        pushToast({
          level: 'success',
          title: `${modeRef.current === 'DEMO' ? 'DEMO ' : 'LIVE '}${draft.side} ${draft.symbol} ${response.volume ?? draft.volume} lots`,
          message: `${
            draft.type === 'MARKET' ? 'Filled' : 'Placed'
          } at ${response.executionPrice ?? 'market'} • ticket ${response.ticket ?? '—'}`,
        });
        await refresh();
        return { success: response.success, ticket: response.ticket, message: 'Order accepted' };
      } catch (error) {
        const message = reportError(error, 'Order rejected');
        return { success: false, ticket: null, message };
      }
    },
    [pushToast, refresh, reportError],
  );

  const modifyPosition = useCallback(
    async (ticket: string, patch: { stopLoss?: number | null; takeProfit?: number | null }) => {
      try {
        await api.patch(`/trading/positions/${ticket}`, {
          mode: modeRef.current,
          ...patch,
          clientRequestId: randomId('modify'),
        });
        pushToast({ level: 'success', title: `Position ${ticket} updated`, message: 'Stop/Target change accepted.' });
        await refresh();
      } catch (error) {
        reportError(error, 'Modification rejected');
      }
    },
    [pushToast, refresh, reportError],
  );

  const closePosition = useCallback(
    async (ticket: string, options?: { confirm?: string; volume?: number | null }) => {
      try {
        const response = await api.post<{ success: boolean; realizedPl: number | null; executionPrice: number | null }>(
          `/trading/positions/${ticket}/close`,
          {
            mode: modeRef.current,
            confirm: options?.confirm ?? (modeRef.current === 'LIVE' ? 'CLOSE' : 'CLOSE'),
            volume: options?.volume ?? null,
            clientRequestId: randomId('close'),
          },
        );
        pushToast({
          level: (response.realizedPl ?? 0) >= 0 ? 'success' : 'warning',
          title: `Position ${ticket} closed`,
          message: `P/L ${(response.realizedPl ?? 0).toFixed(2)} at ${response.executionPrice ?? '—'}`,
        });
        await refresh();
      } catch (error) {
        reportError(error, 'Close rejected');
      }
    },
    [pushToast, refresh, reportError],
  );

  const closeAllPositions = useCallback(
    async (confirm: string, symbol?: string | null) => {
      try {
        const response = await api.post<{ affected: number; realizedPl: number | null }>('/trading/positions/close-all', {
          mode: modeRef.current,
          confirm,
          symbol: symbol ?? null,
          clientRequestId: randomId('closeall'),
        });
        pushToast({
          level: 'warning',
          title: `Closed ${response.affected} position(s)`,
          message: `Realised P/L ${(response.realizedPl ?? 0).toFixed(2)} ${modeRef.current === 'DEMO' ? '(simulated)' : ''}`.trim(),
        });
        await refresh();
      } catch (error) {
        reportError(error, 'Close-all rejected');
      }
    },
    [pushToast, refresh, reportError],
  );

  const cancelOrder = useCallback(
    async (ticket: string) => {
      try {
        await api.delete(`/trading/orders/${ticket}`, { mode: modeRef.current, clientRequestId: randomId('cancel') });
        pushToast({ level: 'info', title: `Order ${ticket} cancelled` });
        await refresh();
      } catch (error) {
        reportError(error, 'Cancel rejected');
      }
    },
    [pushToast, refresh, reportError],
  );

  const cancelAllOrders = useCallback(
    async (confirm?: string) => {
      try {
        const response = await api.post<{ cancelled: number }>('/trading/orders/cancel-all', {
          mode: modeRef.current,
          confirm: confirm ?? '',
          clientRequestId: randomId('cancelall'),
        });
        pushToast({ level: 'info', title: `${response.cancelled} pending order(s) cancelled` });
        await refresh();
      } catch (error) {
        reportError(error, 'Cancel-all rejected');
      }
    },
    [pushToast, refresh, reportError],
  );

  const enableLiveTrading = useCallback(
    async (acknowledged: boolean) => {
      try {
        await api.post('/trading/live/enable', { acknowledged });
        setLiveTradingEnabled(true);
        pushToast({ level: 'warning', title: '🔴 LIVE TRADING ENABLED', message: 'Orders will be executed with real money by your broker.' });
        await refresh();
      } catch (error) {
        reportError(error, 'Could not enable live trading');
      }
    },
    [pushToast, refresh, reportError],
  );

  const disableLiveTrading = useCallback(
    async (reason?: string) => {
      try {
        await api.post('/trading/live/disable', { reason });
        setLiveTradingEnabled(false);
        pushToast({ level: 'success', title: 'LIVE trading disabled', message: 'New live orders will be rejected.' });
        await refresh();
      } catch (error) {
        reportError(error, 'Could not disable live trading');
      }
    },
    [pushToast, refresh, reportError],
  );

  const markNotificationsRead = useCallback(async () => {
    try {
      await api.post('/notifications/read-all');
      setUnread(0);
      setNotifications((current) => current.map((n) => ({ ...n, read: true })));
    } catch {
      /* non-critical */
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      suppressAutoLogin(true); // do not auto-sign-in again after an explicit sign-out
      clearSession();
      setAuthenticated(false);
      setSession(null);
      window.location.href = '/login';
    }
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const value = useMemo<TerminalContextValue>(
    () => ({
      ready,
      authenticated,
      session,
      mode,
      account,
      risk,
      positions,
      orders,
      quotes,
      quoteSources: Object.fromEntries(Object.entries(quotes).map(([key, quote]) => [key, quote.source])),
      watchlist,
      watchlistId,
      connection,
      notifications,
      unreadNotifications,
      toasts,
      liveTradingEnabled,
      realtimeConnected,
      setMode,
      refresh,
      loadWatchlist,
      addToWatchlist,
      removeFromWatchlist,
      previewOrder,
      placeOrder,
      modifyPosition,
      closePosition,
      closeAllPositions,
      cancelOrder,
      cancelAllOrders,
      enableLiveTrading,
      disableLiveTrading,
      markNotificationsRead,
      pushToast,
      dismissToast,
      logout,
    }),
    [
      ready,
      authenticated,
      session,
      mode,
      account,
      risk,
      positions,
      orders,
      quotes,
      watchlist,
      watchlistId,
      connection,
      notifications,
      unreadNotifications,
      toasts,
      liveTradingEnabled,
      realtimeConnected,
      setMode,
      refresh,
      loadWatchlist,
      addToWatchlist,
      removeFromWatchlist,
      previewOrder,
      placeOrder,
      modifyPosition,
      closePosition,
      closeAllPositions,
      cancelOrder,
      cancelAllOrders,
      enableLiveTrading,
      disableLiveTrading,
      markNotificationsRead,
      pushToast,
      dismissToast,
      logout,
    ],
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): TerminalContextValue {
  const context = useContext(TerminalContext);
  if (!context) throw new Error('useTerminal must be used inside <TerminalProvider>');
  return context;
}
