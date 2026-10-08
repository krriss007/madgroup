/**
 * TradePilot — server-side cryptography helpers.
 *
 * • Passwords: scrypt with a per-user random salt.
 * • Device secrets: AES-256-GCM under a key derived from BRIDGE_SECRET, so the
 *   backend can sign MT5 commands while the plaintext token still never lives
 *   in the database or in any log.
 * • Comparison helpers are constant-time.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

/* ------------------------------------------------------------------ */
/* passwords                                                           */
/* ------------------------------------------------------------------ */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const derived = scryptSync(password, Buffer.from(salt, 'base64'), Buffer.from(hash, 'base64').length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return constantTimeEqual(derived, Buffer.from(hash, 'base64'));
  } catch {
    return false;
  }
}

export function constantTimeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ */
/* symmetric encryption for device secrets                             */
/* ------------------------------------------------------------------ */

let cachedKey: Buffer | null = null;
let cachedKeySource: string | null = null;

function encryptionKey(secret: string): Buffer {
  if (cachedKey && cachedKeySource === secret) return cachedKey;
  // scrypt with a fixed application salt: the randomness lives in BRIDGE_SECRET.
  cachedKey = scryptSync(secret, 'tradepilot-device-secret-v1', KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  cachedKeySource = secret;
  return cachedKey;
}

export function encryptSecret(plaintext: string, keySecret: string): string {
  const key = encryptionKey(keySecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(payload: string, keySecret: string): string | null {
  try {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keySecret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Mask a token for display: `tpd_abc123…f4c2` */
export function maskToken(token: string): string {
  if (token.length <= 12) return '••••';
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}
