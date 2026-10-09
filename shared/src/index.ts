/**
 * @tradepilot/shared — domain types, math, validation and the bridge protocol
 * shared by the TradePilot frontend, backend and MQL5 bridge.
 */

export * from './types/domain';
export * from './types/protocol';
export * from './types/bridge';
export * from './types/broker';

export * from './lib/errors';
export * from './lib/math';
export * from './lib/risk';
export * from './lib/validation';
export * from './lib/symbols';
export * from './lib/indicators';
export * from './lib/time';
export * from './lib/format';
export * from './lib/analytics';
export * from './lib/bridge-signature';

export const TRADEPILOT_VERSION = '1.0.0';
export const TRADEPILOT_NAME = 'TradePilot';
