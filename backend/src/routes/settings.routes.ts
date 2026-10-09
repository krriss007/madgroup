/**
 * TradePilot — settings routes: risk limits, profile, MT5 connection and the
 * optional strategy engine.
 *
 * Note: broker credentials are never accepted here. The MT5 connection is
 * established from inside the user's terminal with a TradePilot device token.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCode, TradePilotError } from '@tradepilot/shared';
import { RISK_PRESETS } from '../services/risk.service';
import type { AppContext } from '../http/context';
import { assertCsrf, requireUser } from '../http/plugins';

const riskSchema = z.object({
  maxRiskPerTradePercent: z.number().min(0.1).max(10).optional(),
  maxDailyLossPercent: z.number().min(0.5).max(50).optional(),
  maxOpenPositions: z.number().int().min(1).max(50).optional(),
  maxTotalExposureLots: z.number().min(0.01).max(10_000).optional(),
  maxLotSize: z.number().min(0.01).max(10_000).optional(),
  maxDailyTrades: z.number().int().min(1).max(1_000).nullable().optional(),
  maxConsecutiveLosses: z.number().int().min(0).max(50).optional(),
  requireLiveConfirmation: z.boolean().optional(),
  maxSlippagePoints: z.number().int().min(0).max(500).optional(),
  tradingHoursEnabled: z.boolean().optional(),
  tradingHours: z.array(z.object({ start: z.string(), end: z.string() })).max(8).optional(),
  strategyEngineEnabled: z.boolean().optional(),
});

export function registerSettingsRoutes(app: FastifyInstance, context: AppContext): void {
  /* -------------------------------- profile ------------------------------ */

  app.get('/settings/profile', async (request) => {
    const user = await requireUser(context, request);
    return {
      user: context.auth.toProfile(user),
      accounts: (await context.accounts.listAccounts(user.id)).map((account) => context.accounts.toDomain(account)),
      liveTradingEnabled: user.liveTradingEnabled,
      liveRiskAcknowledgedAt: user.liveRiskAcknowledgedAt,
      killSwitchEngaged: user.killSwitchEngaged,
      lastLoginAt: user.lastLoginAt,
    };
  });

  app.patch('/settings/profile', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = z.object({ displayName: z.string().min(1).max(60) }).parse(request.body ?? {});
    const updated = await context.store.users.update(user.id, {
      displayName: body.displayName,
      updatedAt: new Date().toISOString(),
    });
    return { user: context.auth.toProfile(updated ?? user) };
  });

  /* --------------------------------- risk -------------------------------- */

  app.get('/settings/risk', async (request) => {
    const user = await requireUser(context, request);
    const settings = await context.risk.getSettings(user.id);
    return { settings: context.risk.toDomain(settings), presets: RISK_PRESETS };
  });

  app.put('/settings/risk', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = riskSchema.parse(request.body ?? {});
    const updated = await context.risk.updateSettings(user.id, body);
    await context.audit.record({
      userId: user.id,
      mode: 'DEMO',
      action: 'RISK_SETTINGS_UPDATED',
      result: 'SUCCESS',
      ip: request.ip ?? null,
      userAgent: (request.headers['user-agent'] as string) ?? null,
      detail: body as Record<string, unknown>,
    });
    return { settings: context.risk.toDomain(updated) };
  });

  /* ---------------------------- MT5 connection --------------------------- */

  app.get('/settings/mt5', async (request) => {
    const user = await requireUser(context, request);
    const devices = await context.devices.listDevices(user.id);
    const active = devices.find((device) => context.devices.isOnline(device)) ?? devices[0] ?? null;
    const liveAccount = await context.accounts.getAccount(user.id, 'LIVE');
    const stats = await context.queue.status(user.id);

    return {
      connections: devices.map((device) => ({
        id: device.id,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        tokenPrefix: device.tokenPrefix,
        accountLogin: device.accountLogin,
        server: device.server,
        status: context.devices.isOnline(device) ? 'CONNECTED' : device.status,
        lastHeartbeat: device.lastHeartbeat,
        lastHeartbeatAgeSeconds: context.devices.heartbeatAgeSeconds(device),
        latencyMs: device.latencyMs,
        terminalConnected: device.terminalConnected,
        tradeAllowed: device.tradeAllowed,
        eaTradeAllowed: device.eaTradeAllowed,
        algoTradingEnabled: device.algoTradingEnabled,
        terminalBuild: device.terminalBuild,
        eaVersion: device.eaVersion,
        createdAt: device.createdAt,
        revokedAt: device.revokedAt,
      })),
      active: context.devices.toDomain(active),
      online: active ? context.devices.isOnline(active) : false,
      liveAccount: liveAccount ? context.accounts.toDomain(liveAccount) : null,
      commandStats: stats,
      heartbeatTimeoutMs: context.env.HEARTBEAT_TIMEOUT_MS,
      instructions: [
        'Install MetaTrader 5 and sign in to your broker account.',
        'Copy mt5/TradePilotBridge.mq5 into MQL5/Experts (see docs/MT5_EA_INSTALL.md).',
        'Compile it in MetaEditor with F7.',
        'Attach the EA to any chart (e.g. XAUUSD M1).',
        'Enable “Algo Trading” in the MT5 toolbar.',
        'Generate a device token below and paste it into the EA input “InpDeviceToken”.',
        'Set InpBackendUrl to your TradePilot backend (https://your-backend).',
        'Wait a few seconds for the status to become CONNECTED.',
      ],
      warnings: [
        'Never enter your MT5 trading password anywhere in TradePilot — it is not requested and not stored.',
        'The EA only needs the device token; keep it secret, it is shown once.',
      ],
      credentialsPolicy:
        'TradePilot never asks for, transmits or stores broker passwords. The EA talks to the terminal you are already logged into.',
    };
  });

  app.post('/settings/mt5/devices', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = z.object({ deviceName: z.string().max(60).optional() }).parse(request.body ?? {});
    const existing = await context.devices.listDevices(user.id);
    if (existing.filter((device) => !device.revokedAt).length >= 5) {
      throw new TradePilotError(
        ErrorCode.CONFLICT,
        'You already have 5 active device tokens. Revoke one before generating another.',
        409,
      );
    }
    const generated = await context.devices.createDevice(user.id, body.deviceName ?? null);
    await context.audit.record({
      userId: user.id,
      mode: 'LIVE',
      action: 'MT5_DEVICE_TOKEN_CREATED',
      result: 'SUCCESS',
      ip: request.ip ?? null,
      userAgent: (request.headers['user-agent'] as string) ?? null,
      deviceId: generated.deviceId,
      detail: { tokenPrefix: generated.tokenPrefix },
    });
    return {
      deviceId: generated.deviceId,
      connectionId: generated.connectionId,
      // Shown exactly once — only the hash and an encrypted copy are stored.
      token: generated.token,
      tokenPrefix: generated.tokenPrefix,
      warning: 'Copy this token now: it is shown only once. Paste it into the EA input InpDeviceToken.',
    };
  });

  app.delete('/settings/mt5/devices/:id', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const revoked = await context.devices.revoke(user.id, params.id);
    if (!revoked) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Device not found.', 404);
    await context.audit.record({
      userId: user.id,
      mode: 'LIVE',
      action: 'MT5_DEVICE_TOKEN_REVOKED',
      result: 'SUCCESS',
      ip: request.ip ?? null,
      userAgent: (request.headers['user-agent'] as string) ?? null,
      detail: { connectionId: params.id },
    });
    return { ok: true, message: 'Device revoked. The EA will no longer be able to connect or trade.' };
  });

  app.get('/settings/mt5/status', async (request) => {
    const user = await requireUser(context, request);
    const device = await context.devices.connectionForUser(user.id);
    const online = context.devices.isOnline(device);
    return {
      status: online ? 'CONNECTED' : 'DISCONNECTED',
      mt5: context.devices.toDomain(device),
      lastHeartbeatAgeSeconds: context.devices.heartbeatAgeSeconds(device),
      latencyMs: device?.latencyMs ?? null,
      tradeAllowed: device?.tradeAllowed ?? false,
      algoTradingEnabled: device?.algoTradingEnabled ?? false,
      message: online ? 'MT5 CONNECTED' : 'MT5 DISCONNECTED — LIVE PRICE UNAVAILABLE',
      liveTradingEnabled: user.liveTradingEnabled,
      commands: await context.queue.status(user.id),
    };
  });

  /* ------------------------------- strategies ---------------------------- */

  app.get('/strategies', async (request) => {
    const user = await requireUser(context, request);
    const settings = await context.risk.getSettings(user.id);
    return {
      engineEnabled: settings.strategyEngineEnabled,
      strategies: await context.strategies.list(user.id),
      disclaimer:
        'Automated strategies are experimental tooling provided for research. They are disabled by default, carry no performance guarantee and execute through the same risk checks as manual orders.',
    };
  });

  app.post('/strategies', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const body = z
      .object({
        name: z.string().min(1).max(60),
        engine: z.enum(['ema_cross', 'rsi_reversion', 'bollinger_breakout']),
        symbol: z.string().min(1).max(40),
        timeframe: z.enum(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']).default('M15'),
        parameters: z.record(z.number()).optional(),
        riskPerTradePercent: z.number().min(0.1).max(5).default(0.5),
        maxPositions: z.number().int().min(1).max(5).default(1),
      })
      .parse(request.body ?? {});
    const strategy = await context.strategies.create(user.id, body);
    return { strategy };
  });

  app.patch('/strategies/:id', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(60).optional(),
        enabled: z.boolean().optional(),
        riskPerTradePercent: z.number().min(0.1).max(5).optional(),
        maxPositions: z.number().int().min(1).max(5).optional(),
        parameters: z.record(z.number()).optional(),
        timeframe: z.enum(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']).optional(),
      })
      .parse(request.body ?? {});
    const strategy = await context.strategies.update(user.id, params.id, body);
    return { strategy };
  });

  app.delete('/strategies/:id', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const removed = await context.strategies.remove(user.id, params.id);
    if (!removed) throw new TradePilotError(ErrorCode.NOT_FOUND, 'Strategy not found.', 404);
    return { ok: true };
  });

  app.post('/strategies/:id/run', async (request) => {
    const user = await requireUser(context, request);
    assertCsrf(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ mode: z.enum(['DEMO', 'LIVE']).default('DEMO') }).parse(request.body ?? {});
    const result = await context.strategies.runOnce(user.id, params.id, body.mode);
    return result;
  });
}
