/**
 * TradePilot — authentication & sessions.
 *
 * • Passwords: scrypt (see lib/crypto), never stored or logged in clear.
 * • Sessions: signed JWT (HS256) inside an httpOnly, SameSite=Lax cookie; the
 *   token carries a `tokenVersion` so all sessions can be revoked at once.
 * • CSRF: double-submit cookie. Every mutating request must echo the readable
 *   `tp_csrf` cookie in the `x-csrf-token` header.
 * • Brute force: failed logins are counted and the account locks temporarily.
 */

import { SignJWT, jwtVerify } from 'jose';
import { ErrorCode, TradePilotError, type UserProfile } from '@tradepilot/shared';
import type { Store } from '../db/types';
import type { UserRow } from '../db/types';
import type { Env } from '../config/env';
import type { Logger } from '../lib/logger';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { newId, randomToken } from '../lib/ids';
import type { AccountService } from './account.service';

export const SESSION_COOKIE = 'tp_session';
export const CSRF_COOKIE = 'tp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

export interface SessionTokens {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface SessionUser {
  id: string;
  email: string;
  tokenVersion: number;
}

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly accounts: AccountService,
  ) {}

  private get secret(): Uint8Array {
    return new TextEncoder().encode(this.env.SESSION_SECRET);
  }

  /* ------------------------------------------------------------------ */
  /* registration / login                                               */
  /* ------------------------------------------------------------------ */

  async register(input: { email: string; password: string; displayName?: string }): Promise<{ user: UserRow; session: SessionTokens }> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new TradePilotError(ErrorCode.VALIDATION_FAILED, 'Enter a valid email address.', 400, {
        details: { email: 'Invalid email address.' },
      });
    }
    const passwordError = validatePasswordStrength(input.password);
    if (passwordError) {
      throw new TradePilotError(ErrorCode.VALIDATION_FAILED, passwordError, 400, { details: { password: passwordError } });
    }
    const existing = await this.store.users.findOne({ email: { eq: email } });
    if (existing) {
      throw new TradePilotError(ErrorCode.CONFLICT, 'An account with this email already exists.', 409, {
        details: { email: 'Email already registered.' },
      });
    }

    const now = new Date().toISOString();
    const user: UserRow = {
      id: newId('usr'),
      email,
      displayName: (input.displayName ?? email.split('@')[0]).slice(0, 60),
      passwordHash: hashPassword(input.password),
      createdAt: now,
      updatedAt: now,
      liveTradingEnabled: false,
      liveTradingEnabledAt: null,
      liveRiskAcknowledgedAt: null,
      killSwitchEngaged: false,
      lastLoginAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
      tokenVersion: 1,
    };
    await this.store.users.insert(user);
    // Every account starts in DEMO with a simulated $10,000 paper balance.
    await this.accounts.ensureDemoAccount(user.id);
    this.logger.info({ userId: user.id }, 'user registered (demo account provisioned)');

    return { user, session: await this.issueSession(user) };
  }

  async login(email: string, password: string, ip: string | null): Promise<{ user: UserRow; session: SessionTokens }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.store.users.findOne({ email: { eq: normalized } });
    if (!user) {
      this.logger.warn({ ip }, 'login failed: unknown email');
      throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Invalid email or password.', 401);
    }
    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      throw new TradePilotError(
        ErrorCode.FORBIDDEN,
        'This account is temporarily locked after too many failed sign-in attempts. Try again shortly.',
        423,
      );
    }
    if (!verifyPassword(password, user.passwordHash)) {
      const failed = user.failedLoginCount + 1;
      await this.store.users.update(user.id, {
        failedLoginCount: failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
      });
      this.logger.warn({ userId: user.id, ip, failed }, 'login failed: bad password');
      throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Invalid email or password.', 401);
    }

    await this.store.users.update(user.id, {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date().toISOString(),
    });
    await this.accounts.ensureDemoAccount(user.id);
    return { user, session: await this.issueSession(user) };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<SessionTokens> {
    const user = await this.store.users.findById(userId);
    if (!user) throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Session expired.', 401);
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      throw new TradePilotError(ErrorCode.UNAUTHENTICATED, 'Current password is incorrect.', 401);
    }
    const strength = validatePasswordStrength(newPassword);
    if (strength) throw new TradePilotError(ErrorCode.VALIDATION_FAILED, strength, 400, { details: { newPassword: strength } });

    const updated = await this.store.users.update(userId, {
      passwordHash: hashPassword(newPassword),
      tokenVersion: user.tokenVersion + 1, // revoke every other session
      updatedAt: new Date().toISOString(),
    });
    if (!updated) throw new TradePilotError(ErrorCode.INTERNAL, 'Failed to update the password.', 500);
    return this.issueSession(updated);
  }

  /* ------------------------------------------------------------------ */
  /* sessions                                                           */
  /* ------------------------------------------------------------------ */

  async issueSession(user: UserRow): Promise<SessionTokens> {
    const ttlMinutes = this.env.SESSION_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const token = await new SignJWT({ email: user.email, tv: user.tokenVersion })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuedAt()
      .setIssuer('tradepilot')
      .setAudience('tradepilot-web')
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.secret);

    return { token, csrfToken: randomToken(24), expiresAt };
  }

  async verifySession(token: string): Promise<SessionUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: 'tradepilot',
        audience: 'tradepilot-web',
      });
      const userId = String(payload.sub ?? '');
      if (!userId) return null;
      const user = await this.store.users.findById(userId);
      if (!user) return null;
      if (Number(payload.tv ?? 0) !== user.tokenVersion) return null; // revoked
      return { id: user.id, email: user.email, tokenVersion: user.tokenVersion };
    } catch {
      return null;
    }
  }

  /** Revoke every session by bumping the token version. */
  async revokeSessions(userId: string): Promise<void> {
    const user = await this.store.users.findById(userId);
    if (!user) return;
    await this.store.users.update(userId, { tokenVersion: user.tokenVersion + 1 });
  }

  toProfile(user: UserRow): UserProfile {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
      liveTradingEnabled: user.liveTradingEnabled,
      liveTradingEnabledAt: user.liveTradingEnabledAt,
    };
  }

  cookieOptions(): {
    httpOnly: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    secure: boolean;
    path: string;
    maxAge: number;
    domain?: string;
  } {
    const sameSite = this.env.COOKIE_SAME_SITE;
    // SameSite=None is only honoured by browsers on Secure cookies, so never
    // emit an insecure None cookie (it would simply be dropped).
    const secure = sameSite === 'none' ? true : (this.env.COOKIE_SECURE ?? this.env.NODE_ENV === 'production');
    return {
      httpOnly: true,
      sameSite,
      secure,
      path: '/',
      maxAge: this.env.SESSION_TTL_MINUTES * 60,
      ...(this.env.COOKIE_DOMAIN ? { domain: this.env.COOKIE_DOMAIN } : {}),
    };
  }
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter.';
  if (!/[A-Z0-9]/.test(password)) return 'Password must contain an uppercase letter or a digit.';
  if (/^(password|tradepilot|12345678)/i.test(password)) return 'Password is too common.';
  return null;
}
