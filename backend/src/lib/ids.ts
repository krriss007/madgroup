import { randomBytes, randomUUID, createHash } from 'node:crypto';

export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id.replace(/-/g, '')}` : id;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function numericTicket(seed?: string): string {
  // 9-digit broker-style ticket for the demo engine. Never used for live.
  const base = seed ? BigInt(`0x${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`) : BigInt(`0x${randomHex(6)}`);
  return (5_000_000_000n + (base % 4_000_000_000n)).toString();
}
