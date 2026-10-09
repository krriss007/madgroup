/**
 * TradePilot — structured error codes.
 *
 * The backend returns machine-readable codes and the UI maps them to the
 * human messages required by the spec ("MT5 is offline. Live trading is
 * disabled.", "Volume must be between 0.01 and 100.00 with a 0.01 step.", …).
 */

export const ErrorCode = {
  // auth / security
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  CSRF_INVALID: 'CSRF_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',

  // broker / connection
  MT5_OFFLINE: 'MT5_OFFLINE',
  MT5_NOT_AUTHORIZED: 'MT5_NOT_AUTHORIZED',
  MT5_TRADE_DISABLED: 'MT5_TRADE_DISABLED',
  MT5_TIMEOUT: 'MT5_TIMEOUT',
  EA_REJECTED: 'EA_REJECTED',
  BROKER_ERROR: 'BROKER_ERROR',

  // mode / permissions
  LIVE_TRADING_DISABLED: 'LIVE_TRADING_DISABLED',
  MODE_MISMATCH: 'MODE_MISMATCH',
  DEMO_ONLY: 'DEMO_ONLY',
  KILL_SWITCH_ACTIVE: 'KILL_SWITCH_ACTIVE',
  TRADING_HOURS_BLOCKED: 'TRADING_HOURS_BLOCKED',

  // market
  SYMBOL_NOT_FOUND: 'SYMBOL_NOT_FOUND',
  MARKET_CLOSED: 'MARKET_CLOSED',
  NO_QUOTE: 'NO_QUOTE',

  // validation
  INVALID_VOLUME: 'INVALID_VOLUME',
  INVALID_PRICE: 'INVALID_PRICE',
  INVALID_STOP_LOSS: 'INVALID_STOP_LOSS',
  INVALID_TAKE_PROFIT: 'INVALID_TAKE_PROFIT',
  STOPS_LEVEL_VIOLATION: 'STOPS_LEVEL_VIOLATION',
  INVALID_EXPIRATION: 'INVALID_EXPIRATION',

  // risk
  RISK_LIMIT_EXCEEDED: 'RISK_LIMIT_EXCEEDED',
  DAILY_LOSS_LIMIT_REACHED: 'DAILY_LOSS_LIMIT_REACHED',
  MAX_POSITIONS_REACHED: 'MAX_POSITIONS_REACHED',
  MAX_EXPOSURE_EXCEEDED: 'MAX_EXPOSURE_EXCEEDED',
  MAX_LOT_EXCEEDED: 'MAX_LOT_EXCEEDED',
  MAX_DAILY_TRADES_REACHED: 'MAX_DAILY_TRADES_REACHED',
  CONSECUTIVE_LOSS_LOCK: 'CONSECUTIVE_LOSS_LOCK',

  // margin
  INSUFFICIENT_MARGIN: 'INSUFFICIENT_MARGIN',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',

  // execution
  DUPLICATE_COMMAND: 'DUPLICATE_COMMAND',
  DUPLICATE_ORDER: 'DUPLICATE_ORDER',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  CONFIRMATION_MISMATCH: 'CONFIRMATION_MISMATCH',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorShape {
  error: {
    code: ErrorCodeValue | string;
    message: string;
    /** Field-level details for form validation */
    details?: Record<string, string> | null;
    /** Extra machine-readable context, e.g. the failing validation rule */
    meta?: Record<string, unknown> | null;
  };
}

export class TradePilotError extends Error {
  readonly code: ErrorCodeValue | string;
  readonly statusCode: number;
  readonly details?: Record<string, string> | null;
  readonly meta?: Record<string, unknown> | null;

  constructor(
    code: ErrorCodeValue | string,
    message: string,
    statusCode = 400,
    options?: { details?: Record<string, string> | null; meta?: Record<string, unknown> | null },
  ) {
    super(message);
    this.name = 'TradePilotError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options?.details ?? null;
    this.meta = options?.meta ?? null;
  }

  toJSON(): ApiErrorShape {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details ?? null,
        meta: this.meta ?? null,
      },
    };
  }
}

export function isTradePilotError(error: unknown): error is TradePilotError {
  return error instanceof TradePilotError;
}

/**
 * Canonical user-facing messages. Keeping them in one place means the UI and
 * the API always agree on the wording (the spec requires exact strings).
 */
export const ErrorMessages = {
  MT5_OFFLINE: 'MT5 is offline. Live trading is disabled.',
  MT5_OFFLINE_PRICE: 'MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE',
  LIVE_TRADING_DISABLED: 'Live trading is disabled. Enable it in Settings → Live Trading after connecting your MT5 account.',
  MARKET_CLOSED: 'Market is currently closed.',
  INSUFFICIENT_MARGIN: 'Insufficient free margin.',
  MT5_TRADE_DISABLED: 'Automated trading is disabled in MT5.',
  DAILY_LOSS_LOCKED: 'DAILY LOSS LIMIT REACHED — TRADING LOCKED',
  LIVE_ORDER_WARNING: 'THIS ORDER WILL USE REAL MONEY.',
} as const;
