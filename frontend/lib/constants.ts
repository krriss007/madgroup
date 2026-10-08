/** Shared UI constants (mirrors the backend contract). */

export const CLOSE_ALL_CONFIRMATION = 'CONFIRM CLOSE ALL';
export const CANCEL_ALL_CONFIRMATION = 'CANCEL ALL PENDING ORDERS';

export const ORDER_TYPES = [
  { id: 'MARKET', label: 'Market' },
  { id: 'LIMIT', label: 'Limit' },
  { id: 'STOP', label: 'Stop' },
  { id: 'STOP_LIMIT', label: 'Stop Limit' },
] as const;

export const RISK_PRESETS = [0.5, 1, 2] as const;
export const DAILY_LOSS_PRESETS = [1, 2, 5] as const;
export const MAX_POSITIONS_PRESETS = [1, 3, 5, 10] as const;

export const LIVE_ORDER_WARNING = 'THIS ORDER WILL USE REAL MONEY.';

export const LIVE_ENABLE_ACKNOWLEDGEMENTS = [
  'I understand that live orders are executed by my broker with real money.',
  'I have configured maximum risk per trade, daily loss and position limits.',
  'I understand that TradePilot never holds my broker credentials and cannot recover funds.',
];
