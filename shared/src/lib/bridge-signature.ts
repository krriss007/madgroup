/**
 * TradePilot — bridge command signing.
 *
 * Commands travelling Web → MT5 are signed with an HMAC-SHA256 derived from a
 * per-device secret that only the backend and the user's MT5 terminal know.
 * The canonical form is deterministic and mirrored 1:1 in MQL5
 * (mt5/include/TradePilotCrypto.mqh) so both sides compute the same digest.
 *
 * Secrets are never sent to the browser: the frontend only ever sees command
 * results, never the signed envelope.
 */

import { BRIDGE_PROTOCOL_VERSION, type BridgeCommandEnvelope } from '../types/bridge';

export interface SignableCommand {
  command_id: string;
  timestamp: string;
  user_id: string;
  account_id: string;
  symbol: string;
  action: string;
  parameters: Record<string, unknown>;
  idempotency_key: string;
  nonce: string;
}

/**
 * Numbers are written as plain decimals: 8 decimal places maximum, trailing
 * zeros removed, no exponent notation, integers without a decimal point.
 *
 * This matters because the MQL5 side (mt5/include/TradePilot/TP_Json.mq5) has to
 * reproduce this string byte-for-byte: JavaScript's default `String(n)` switches
 * to exponential notation for very small/large magnitudes, which MQL5's
 * DoubleToString never does. Keeping both sides on the same plain-decimal rule
 * removes that whole class of "signature does not verify" bugs.
 */
export function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) return 'null';
  const rounded = Math.round(value * 1e8) / 1e8;
  if (Math.abs(rounded) >= 1e15) return String(rounded);
  if (Number.isInteger(rounded)) return String(rounded);
  const text = rounded.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return text === '' || text === '-0' ? '0' : text;
}

/** Stable JSON: object keys sorted recursively, numbers normalised. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return numberToPlainString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Canonical payload that gets signed (and verified inside the EA). */
export function canonicalCommandPayload(command: SignableCommand): string {
  return [
    command.command_id,
    command.timestamp,
    command.user_id,
    command.account_id,
    command.symbol,
    command.action,
    stableStringify(command.parameters ?? {}),
    command.idempotency_key,
    command.nonce,
    BRIDGE_PROTOCOL_VERSION,
  ].join('|');
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sign a command. Works in Node 20+, Bun, Deno and browsers (Web Crypto).
 * The backend uses this; the browser never does (signing keys stay server-side).
 */
export async function signCommand(command: SignableCommand, secret: string): Promise<string> {
  const payload = canonicalCommandPayload(command);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return toHex(signature);
}

/** Constant-time-ish verification used by tests and the bridge ingest endpoint. */
export async function verifyCommandSignature(
  command: BridgeCommandEnvelope,
  secret: string,
): Promise<boolean> {
  const expected = await signCommand(command, secret);
  const provided = (command.signature ?? '').toLowerCase();
  if (expected.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

export interface DeviceTokenMaterial {
  deviceId: string;
  token: string;
  secret: string;
  tokenPrefix: string;
}

/** Split a device token into id + secret parts: `tpd_<deviceId>_<secret>`. */
export function parseDeviceToken(token: string): { deviceId: string; secret: string } | null {
  const match = /^tpd_([A-Za-z0-9]{6,64})_([A-Za-z0-9]{16,128})$/.exec(token.trim());
  if (!match) return null;
  return { deviceId: match[1], secret: match[2] };
}

export function hashTokenMaterial(material: string): string {
  // FNV-1a style digest is enough for prefix comparisons in the UI; the backend
  // stores the full SHA-256 of the secret (see services/token.service.ts).
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
