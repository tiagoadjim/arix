import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import * as repo from '../db/repo';
import { pool } from '../db/pool';
import { readReceiptImage } from '../storage';
import { normalizePhone, woo, type WcOrder } from '../integrations/woocommerce';
import {
  woo as wooConfig,
  dispatchTemplate,
  invalidate as invalidateSettings,
  getResolvedWithMeta,
  envLockedKeys,
  setupCompleted,
  businessProfile,
  llm as llmConfig,
} from '../config/runtime';
import { encryptSecret } from '../config/secret';
import { PROVIDERS, type ProviderSpec } from '../agent/llm/providers';
import {
  buildSettingsDto,
  normalizeSettingsUpdates,
  validateSettingsUpdates,
  coerceForStorage,
  isNoOpSecretUpdate,
  invalidSettingsValues,
} from './settings-dto';
import {
  orderForStaff,
  STATUS_ES,
  buildDeliveryMessage,
  DEFAULT_DELIVERY_TEMPLATE,
} from '../skills/orders';
import {
  amountsMatch,
  decimalHintForCurrency,
  parseAmount,
  reconcileReceiptAfterAmbiguousOrderUpdate,
} from '../skills/payments';
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from './auth';
import type { WhatsAppGateway } from '../whatsapp/socket';
import { stableWhatsAppMessageId } from '../whatsapp/socket';
import {
  isPrivateOrReservedIp,
  parseRemoteUrl,
  readTextLimited,
  safeFetch,
  UnsafeRemoteUrlError,
} from '../net/safe-fetch';
import {
  BoundedRateLimiter,
  boundedString,
  clientIp,
  constantTimeSecretEqual,
  hashIp,
  isUuid,
  positiveInteger,
  requestSecurityMiddleware,
  sameOriginGuard,
} from './security';
import type { StaffRole } from '../types';
import { recordHttp, renderMetrics } from '../metrics';
import { publishEvent, subscribeEvents } from '../events';

type ChatCompletionCreateParamsNonStreaming = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

function encodeConversationCursor(cursor: repo.ConversationListCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') : null;
}

function decodeConversationCursor(raw: unknown): repo.ConversationListCursor | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || !isUuid(parsed.id)) return null;
    return { at: new Date(parsed.at).toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

/** {connected, hasQr} — the one shape /health, /api/setup/status and
 * /api/whatsapp/status all report the gateway's pairing state in. */
function whatsappStatus(gateway: WhatsAppGateway): { connected: boolean; hasQr: boolean } {
  return { connected: gateway.connected, hasQr: Boolean(gateway.latestQR) };
}

function orderBelongsToConversation(order: WcOrder, conv: { phone: string | null; customer_email: string | null }): boolean {
  const phone = normalizePhone(conv.phone);
  const orderPhone = normalizePhone(order.billing?.phone);
  if (phone && orderPhone && phone === orderPhone) return true;
  const email = conv.customer_email?.trim().toLowerCase();
  const orderEmail = order.billing?.email?.trim().toLowerCase();
  return Boolean(email && orderEmail && email === orderEmail);
}

/** Maps an LLM provider-test failure to a message safe to show an end user —
 * NEVER echoes err.message verbatim (which could, depending on the SDK/proxy,
 * include request details), and never the posted API key. */
function safeLlmTestError(err: unknown): string {
  const status =
    err && typeof err === 'object' && 'status' in err ? (err as { status?: unknown }).status : undefined;
  if (status === 401 || status === 403) return 'Invalid API key or insufficient permissions.';
  if (status === 404) return 'Model not found for this provider.';
  if (status === 429) return 'Rate limited by the provider — try again shortly.';
  if (typeof status === 'number' && status >= 500) return 'The provider API is currently unavailable.';
  if (err instanceof Error && /timeout/i.test(err.message)) return 'Request timed out.';
  return 'Could not connect to the LLM provider with these credentials.';
}

/** Maps a WooCommerce credential-test HTTP status to a safe user-facing message. */
function safeWooTestError(status: number): string {
  if (status === 401 || status === 403) return 'Invalid consumer key/secret, or REST API access is disabled.';
  if (status === 404) return 'WooCommerce REST API not found at this URL — check the store URL.';
  if (status >= 500) return 'The store is currently unavailable.';
  return `The store rejected the request (HTTP ${status}).`;
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginByAccount = new BoundedRateLimiter(LOGIN_MAX_FAILS, LOGIN_WINDOW_MS);
const loginByIp = new BoundedRateLimiter(50, LOGIN_WINDOW_MS);
// Unknown emails never run bcrypt (CPU DoS); this bounded global ceiling limits
// timer/DB churn without ever blocking a real, existing staff account.
const unknownLoginGlobal = new BoundedRateLimiter(500, LOGIN_WINDOW_MS, 1);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 1024;
const MAX_MESSAGE_LEN = 10_000;
const createEmailHash = (email: string) =>
  createHash('sha256').update(`${config.AUTH_JWT_SECRET}:${email}`).digest('hex').slice(0, 24);

function unknownLoginDelay(email: string): Promise<void> {
  const byte = Number.parseInt(createEmailHash(email).slice(0, 2), 16);
  return new Promise((resolve) => setTimeout(resolve, 60 + (byte % 31)));
}

function shouldApplyPerIpLimit(req: Request): boolean {
  // With the default unexposed Docker topology, every request legitimately
  // comes from the dashboard container. Treating that address as an end-user
  // IP creates a single anonymous lockout switch for the whole team. A direct
  // public client (or a deployment that explicitly trusts one sanitizing
  // proxy hop) still gets the per-IP limit.
  const remote = req.socket.remoteAddress ?? '';
  return config.TRUST_PROXY || !isPrivateOrReservedIp(remote);
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

type AuthedRequest = Request & { user?: SessionUser; requestId?: string };

/** Wrap async handlers so rejections reach the express error handler. */
const ah =
  (fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  (req, res, next) =>
    void fn(req as AuthedRequest, res, next).catch(next);

export function createApiServer(deps: {
  gateway: WhatsAppGateway;
  recoverUnanswered?: () => void;
  cancelConversationTurn?: (conversationId: string) => void;
}) {
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.use(requestSecurityMiddleware);
  app.use((req, res, next) => {
    const started = performance.now();
    res.once('finish', () => {
      const durationMs = Math.round((performance.now() - started) * 10) / 10;
      const route = String(req.route?.path ?? 'unmatched');
      recordHttp(req.method, route, res.statusCode, durationMs);
      logger.info(
        {
          requestId: (req as AuthedRequest).requestId,
          method: req.method,
          path: route,
          status: res.statusCode,
          durationMs,
        },
        'http request',
      );
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(sameOriginGuard);
  app.param('id', (_req, res, next, value) => {
    if (!isUuid(value)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    next();
  });
  app.param('receiptId', (_req, res, next, value) => {
    if (!isUuid(value)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    next();
  });
  app.param('orderId', (_req, res, next, value) => {
    if (!positiveInteger(value)) {
      res.status(400).json({ error: 'invalid_order_id' });
      return;
    }
    next();
  });

  const audit = async (
    req: AuthedRequest,
    action: string,
    targetType?: string,
    targetId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await repo.insertAuditEvent({
        actorId: req.user?.id ?? null,
        action,
        targetType,
        targetId,
        requestId: req.requestId ?? null,
        ipHash: hashIp(req),
        metadata,
      });
    } catch (err) {
      logger.error({ err, action, requestId: req.requestId }, 'failed to persist audit event');
    }
  };

  // ---- health (no auth) ----
  // ALWAYS 200: liveness (the process/API is up) is a different question from
  // pairing (WhatsApp connected). Docker's healthcheck (depends_on:
  // service_healthy) must pass BEFORE the first WhatsApp pairing, or the
  // wizard flow deadlocks on first boot — see docker-compose.yml.
  app.get(['/health', '/health/live'], (_req, res) => {
    res.status(200).json({ status: 'ok', whatsapp: whatsappStatus(deps.gateway) });
  });

  app.get(
    '/health/ready',
    ah(async (_req, res) => {
      try {
        await pool.query('select 1');
        res.status(200).json({ status: 'ready', database: 'ok', whatsapp: whatsappStatus(deps.gateway) });
      } catch {
        res.status(503).json({ status: 'not_ready', database: 'unavailable' });
      }
    }),
  );

  // ---- setup wizard: status + one-shot admin bootstrap (no auth) ----
  app.get(
    '/api/setup/status',
    ah(async (_req, res) => {
      const [staffCount, completed] = await Promise.all([repo.countStaff(), setupCompleted()]);
      res.json({
        needsSetup: staffCount === 0,
        setupCompleted: completed,
        whatsapp: whatsappStatus(deps.gateway),
      });
    }),
  );

  app.post(
    '/api/setup/admin',
    ah(async (req, res) => {
      const throttleKey = 'setup-admin';
      const accountLimit = loginByAccount.consume(throttleKey);
      const ipLimit = loginByIp.consume(`setup:${clientIp(req)}`);
      if (!accountLimit.allowed || !ipLimit.allowed) {
        res.setHeader('Retry-After', String(Math.max(accountLimit.retryAfterSeconds, ipLimit.retryAfterSeconds)));
        res.status(429).json({ error: 'too_many_attempts' });
        return;
      }
      // Keep the bootstrap credential out of the JSON body (and therefore out
      // of body-validation errors). Missing and incorrect values deliberately
      // share one response; the fixed-size digest comparison avoids prefix or
      // length-dependent string comparison timing.
      if (!constantTimeSecretEqual(config.SETUP_TOKEN, req.header('x-setup-token'))) {
        res.status(401).json({ error: 'invalid_setup_token' });
        return;
      }
      // Setup is one-shot. createFirstAdmin() remains the atomic final guard
      // against two valid requests racing after this inexpensive early check.
      if ((await repo.countStaff()) > 0) {
        res.status(409).json({ error: 'setup_already_completed' });
        return;
      }
      const nameValue = boundedString(req.body?.name ?? '', 200);
      const emailValue = boundedString(req.body?.email ?? '', 320);
      const name = nameValue || null;
      const email = (emailValue ?? '').toLowerCase();
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'invalid_email' });
        return;
      }
      if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
        res.status(400).json({ error: 'password_too_short' });
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      const staff = await repo.createFirstAdmin(email, hash, name);
      if (!staff) {
        res.status(409).json({ error: 'setup_already_completed' });
        return;
      }
      loginByAccount.reset(throttleKey);
      loginByIp.reset(`setup:${clientIp(req)}`);
      const token = await signSession(staff);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.COOKIE_SECURE,
        path: '/',
        maxAge: 7 * 24 * 3600 * 1000,
      });
      await audit(req, 'staff.bootstrap_admin', 'staff', staff.id);
      res.json({ id: staff.id, email: staff.email, name: staff.name, role: staff.role });
    }),
  );

  // ---- auth ----
  app.post(
    '/api/auth/login',
    ah(async (req, res) => {
      const email = (boundedString(req.body?.email ?? '', 320) ?? '').toLowerCase();
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!email || !password) {
        res.status(400).json({ error: 'email_password_required' });
        return;
      }
      if (password.length > MAX_PASSWORD_LEN) {
        res.status(400).json({ error: 'invalid_credentials' });
        return;
      }
      const accountKey = `login:${email}`;
      const accountLimit = loginByAccount.consume(accountKey);
      const ipKey = `login:${clientIp(req)}`;
      const ipLimit = shouldApplyPerIpLimit(req)
        ? loginByIp.consume(ipKey)
        : { allowed: true, retryAfterSeconds: 0 };
      if (!accountLimit.allowed || !ipLimit.allowed) {
        res.setHeader('Retry-After', String(Math.max(accountLimit.retryAfterSeconds, ipLimit.retryAfterSeconds)));
        res.status(429).json({ error: 'too_many_attempts' });
        return;
      }
      const staff = await repo.getStaffByEmail(email);
      if (!staff) {
        const unknownLimit = unknownLoginGlobal.consume('unknown');
        if (!unknownLimit.allowed) {
          res.setHeader('Retry-After', String(unknownLimit.retryAfterSeconds));
          res.status(429).json({ error: 'too_many_attempts' });
          return;
        }
        await unknownLoginDelay(email);
        await audit(req, 'auth.login_failed', 'staff', undefined, { emailHash: createEmailHash(email) });
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      const ok = await bcrypt.compare(password, staff.password_hash);
      if (!ok) {
        await audit(req, 'auth.login_failed', 'staff', undefined, { emailHash: createEmailHash(email) });
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      loginByAccount.reset(accountKey);
      loginByIp.reset(ipKey);
      const token = await signSession(staff);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.COOKIE_SECURE, // set COOKIE_SECURE=true behind HTTPS
        path: '/',
        maxAge: 7 * 24 * 3600 * 1000,
      });
      req.user = {
        id: staff.id,
        email: staff.email,
        name: staff.name ?? undefined,
        role: staff.role,
        sessionVersion: staff.session_version,
      };
      await audit(req, 'auth.login', 'staff', staff.id);
      res.json({ id: staff.id, email: staff.email, name: staff.name, role: staff.role });
    }),
  );

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---- auth gate for the rest of /api ----
  const requireAuth = ah(async (req, res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const claims = token ? await verifySession(token) : null;
    // Re-validate against the DB so a deleted/disabled staff member is revoked
    // immediately. session_version also revokes sessions after password/role
    // changes without maintaining a separate token blacklist.
    const staff = claims ? await repo.getStaffById(claims.id) : null;
    if (!claims || !staff || staff.session_version !== claims.sessionVersion) {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.user = {
      id: staff.id,
      email: staff.email,
      name: staff.name ?? undefined,
      role: staff.role,
      sessionVersion: staff.session_version,
    };
    next();
  });

  const requireRole = (...roles: StaffRole[]): RequestHandler => (req, res, next) => {
    const user = (req as AuthedRequest).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
  const requireAdmin = requireRole('admin');

  app.get('/api/me', requireAuth, (req, res) => {
    res.json((req as AuthedRequest).user);
  });

  const sseConnections = new Map<string, number>();
  app.get('/api/events', requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).user!.id;
    const active = sseConnections.get(userId) ?? 0;
    if (active >= 5) {
      res.setHeader('Retry-After', '30');
      res.status(429).json({ error: 'too_many_connections' });
      return;
    }
    sseConnections.set(userId, active + 1);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`event: ready\ndata: {"at":"${new Date().toISOString()}"}\n\n`);
    const unsubscribe = subscribeEvents((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    const maxLifetime = setTimeout(() => res.end(), 5 * 60_000);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepAlive);
      clearTimeout(maxLifetime);
      unsubscribe();
      const remaining = (sseConnections.get(userId) ?? 1) - 1;
      if (remaining > 0) sseConnections.set(userId, remaining);
      else sseConnections.delete(userId);
    };
    req.once('close', cleanup);
    res.once('close', cleanup);
  });

  // WhatsApp pairing QR — AUTH REQUIRED (the QR is credential-equivalent).
  // For first-time setup, scan it from the server logs instead.
  app.get('/api/qr', requireAuth, requireAdmin, (_req, res) => {
    res
      .type('text/plain; charset=utf-8')
      .send(deps.gateway.latestQR ?? (deps.gateway.connected ? 'connected' : 'no QR yet — check logs'));
  });

  // ---- setup wizard: test posted (unsaved) credentials ----
  app.post(
    '/api/setup/test/llm',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const useStored = req.body?.useStored === true;
      const stored = useStored ? await llmConfig() : null;
      // `useStored` is an all-or-nothing mode. Never combine a persisted
      // secret with client-controlled routing fields: doing so would turn this
      // endpoint into a credential-exfiltration oracle for an attacker that
      // can issue an authenticated request (for example through session XSS).
      const providerId = String(useStored ? stored?.provider ?? '' : req.body?.provider ?? '');
      const provider = (PROVIDERS as Record<string, ProviderSpec>)[providerId];
      if (!provider) {
        res.status(400).json({ ok: false, error: 'Unknown provider' });
        return;
      }
      const apiKey = String(useStored ? stored?.apiKey ?? '' : req.body?.apiKey ?? '');
      if (!apiKey.trim() || apiKey.length > 8_192) {
        res.status(400).json({ ok: false, error: 'Missing API key' });
        return;
      }
      const modelValue = boundedString(useStored ? stored?.model ?? '' : req.body?.model ?? '', 300);
      const baseUrlValue = boundedString(useStored ? stored?.baseUrl ?? '' : req.body?.baseUrl ?? '', 2_048);
      if (modelValue === null || baseUrlValue === null) {
        res.status(400).json({ ok: false, error: 'Model or base URL is too long.' });
        return;
      }
      const model = modelValue || provider.defaultModel;
      const baseUrl = baseUrlValue || provider.baseURL;

      // Throwaway client built directly from the posted (unsaved) values —
      // deliberately NOT getLlm(): that only ever reads persisted runtime
      // config, and this is testing credentials before any write happens.
      const client = new OpenAI({
        apiKey,
        baseURL: baseUrl,
        maxRetries: 0,
        timeout: 15_000,
        fetch: (url, init) => safeFetch(url, init, { timeoutMs: 15_000 }),
      });
      const body: ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      };
      provider.prepareBody(body, { reasoningSplit: false, thinkingDisabled: false });

      try {
        await client.chat.completions.create(body);
        await audit(req, 'integration.test_llm', 'llm_provider', providerId, { ok: true, model });
        res.json({ ok: true, model, vision: provider.supportsVision(model) });
      } catch (err) {
        logger.warn({ provider: providerId, errorType: err instanceof Error ? err.name : typeof err }, 'setup: LLM credential test failed');
        await audit(req, 'integration.test_llm', 'llm_provider', providerId, { ok: false, model });
        res.json({ ok: false, error: safeLlmTestError(err), model, vision: provider.supportsVision(model) });
      }
    }),
  );

  app.post(
    '/api/setup/test/woocommerce',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const useStored = req.body?.useStored === true;
      const stored = useStored ? await wooConfig() : null;
      // As with the LLM probe, persisted credentials may only be sent to the
      // persisted endpoint. Posted URL/credential fields are ignored in this
      // mode rather than mixed with secrets from another configuration.
      const rawUrlValue = boundedString(useStored ? stored?.url ?? '' : req.body?.url ?? '', 2_048);
      const consumerKeyValue = boundedString(
        useStored ? stored?.consumerKey ?? '' : req.body?.consumerKey ?? '',
        8_192,
      );
      const consumerSecretValue = boundedString(
        useStored ? stored?.consumerSecret ?? '' : req.body?.consumerSecret ?? '',
        8_192,
      );
      const rawUrl = (rawUrlValue ?? '').replace(/\/$/, '');
      const consumerKey = consumerKeyValue ?? '';
      const consumerSecret = consumerSecretValue ?? '';
      if (!rawUrl || !consumerKey || !consumerSecret) {
        res.status(400).json({ ok: false, error: 'Missing url, consumerKey or consumerSecret' });
        return;
      }
      let base: URL;
      try {
        base = new URL(rawUrl);
      } catch {
        res.status(400).json({ ok: false, error: 'Invalid store URL' });
        return;
      }

      const auth = 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
      try {
        const target = new URL('/wp-json/wc/v3/products', base);
        target.searchParams.set('per_page', '1');
        const resp = await safeFetch(target, {
          headers: { Authorization: auth, Accept: 'application/json' },
        }, { timeoutMs: 15_000 });
        if (!resp.ok) {
          await resp.body?.cancel().catch(() => {});
          await audit(req, 'integration.test_woocommerce', 'woocommerce', base.origin, { ok: false, status: resp.status });
          res.json({ ok: false, error: safeWooTestError(resp.status) });
          return;
        }
        const data = JSON.parse(await readTextLimited(resp, 1_000_000)) as unknown;
        const products = Array.isArray(data) ? (data as Array<{ name?: unknown }>) : [];
        await audit(req, 'integration.test_woocommerce', 'woocommerce', base.origin, { ok: true });
        res.json({ ok: true, sampleProductName: typeof products[0]?.name === 'string' ? products[0].name : null });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'AbortError';
        const unsafe = err instanceof UnsafeRemoteUrlError;
        logger.warn({ errorType: err instanceof Error ? err.name : typeof err }, 'setup: WooCommerce credential test failed');
        await audit(req, 'integration.test_woocommerce', 'woocommerce', base.origin, { ok: false, unsafe });
        res.json({
          ok: false,
          error: unsafe
            ? 'This URL is not allowed by the server network policy.'
            : timedOut
              ? 'Request timed out.'
              : 'Could not connect to the WooCommerce store with these credentials.',
        });
      }
    }),
  );

  // ---- WhatsApp pairing status + manual restart (auth) ----
  app.get('/api/whatsapp/status', requireAuth, (_req, res) => {
    res.json(whatsappStatus(deps.gateway));
  });

  app.post(
    '/api/whatsapp/restart',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const force = req.body?.force === true;
      const wasConnected = deps.gateway.connected;
      if (wasConnected && !force) {
        res.status(409).json({ error: 'already_connected' });
        return;
      }
      // `force` always means a real re-pair, including when the transport is
      // currently disconnected: persisted Signal state can still exist even
      // with no live socket. The gateway clears that state fail-closed before
      // exposing a replacement socket.
      await deps.gateway.restart(force ? { clearSession: true } : {});
      await audit(req, 'whatsapp.restarted', 'whatsapp', config.WA_ACCOUNT_ID, { clearedSession: force });
      publishEvent({ type: 'whatsapp.updated' });
      res.json({ ok: true, whatsapp: whatsappStatus(deps.gateway) });
    }),
  );

  // ---- setup wizard: mark complete ----
  app.post(
    '/api/setup/complete',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      await repo.upsertSetting('setup.completed', 'true');
      invalidateSettings();
      await audit(req, 'setup.completed', 'settings', 'setup.completed');
      deps.recoverUnanswered?.();
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/conversations',
    requireAuth,
    ah(async (req, res) => {
      const rawLimit = req.query.limit === undefined ? 100 : positiveInteger(req.query.limit);
      const cursor = decodeConversationCursor(req.query.cursor);
      if (!rawLimit || (req.query.cursor !== undefined && !cursor)) {
        res.status(400).json({ error: 'invalid_conversation_cursor' });
        return;
      }
      const page = await repo.listConversations(req.user!.id, {
        cursor: cursor ?? undefined,
        limit: Math.min(rawLimit, 200),
      });
      res.json({ conversations: page.conversations, nextCursor: encodeConversationCursor(page.nextCursor) });
    }),
  );

  app.get(
    '/api/conversations/:id',
    requireAuth,
    ah(async (req, res) => {
      const id = req.params.id as string;
      const conv = await repo.getConversation(id);
      if (!conv) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      const [messages, receipts] = await Promise.all([
        repo.getMessages(conv.id),
        repo.getReceipts(conv.id),
      ]);
      res.json({ conversation: conv, messages, receipts });
    }),
  );

  app.get(
    '/api/conversations/:id/messages',
    requireAuth,
    ah(async (req, res) => {
      const id = req.params.id as string;
      if (!(await repo.getConversation(id))) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      const before = req.query.before;
      const after = req.query.after;
      if ((before !== undefined && !isUuid(before)) || (after !== undefined && !isUuid(after)) || (before && after)) {
        res.status(400).json({ error: 'invalid_message_cursor' });
        return;
      }
      const rawLimit = req.query.limit === undefined ? 100 : positiveInteger(req.query.limit);
      if (!rawLimit) {
        res.status(400).json({ error: 'invalid_limit' });
        return;
      }
      res.json(
        await repo.getMessagePage(id, {
          beforeId: before as string | undefined,
          afterId: after as string | undefined,
          limit: Math.min(rawLimit, 200),
        }),
      );
    }),
  );

  app.post(
    '/api/conversations/:id/read',
    requireAuth,
    ah(async (req, res) => {
      const id = req.params.id as string;
      if (!(await repo.markConversationRead(id, req.user!.id))) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      publishEvent({ type: 'conversation.updated', conversationId: id });
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/conversations/:id/mode',
    requireAuth,
    ah(async (req, res) => {
      const mode = req.body?.mode;
      if (mode !== 'bot' && mode !== 'human') {
        res.status(400).json({ error: 'invalid_mode' });
        return;
      }
      const id = req.params.id as string;
      if (!(await repo.getConversation(id))) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      const user = req.user!;
      if (mode === 'human') deps.cancelConversationTurn?.(id);
      await repo.setConversationMode(id, mode, {
        assignedTo: mode === 'human' ? user.id : null,
        escalationReason: mode === 'human' ? 'Taken by staff' : null,
      });
      await audit(req, 'conversation.mode_changed', 'conversation', id, { mode });
      publishEvent({ type: 'conversation.updated', conversationId: id });
      res.json(await repo.getConversation(id));
    }),
  );

  app.post(
    '/api/conversations/:id/messages',
    requireAuth,
    ah(async (req, res) => {
      const body = boundedString(req.body?.body ?? '', MAX_MESSAGE_LEN);
      if (!body) {
        res.status(400).json({ error: 'empty_message' });
        return;
      }
      const conv = await repo.getConversation(req.params.id as string);
      if (!conv) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      if (conv.mode !== 'human') {
        res.status(409).json({ error: 'conversation_not_human' });
        return;
      }
      const user = req.user!;
      const requestedClientId = req.body?.clientId;
      if (requestedClientId !== undefined && !isUuid(requestedClientId)) {
        res.status(400).json({ error: 'invalid_client_id' });
        return;
      }
      const clientId = isUuid(requestedClientId) ? requestedClientId : randomUUID();
      const waId = stableWhatsAppMessageId(clientId);
      const prepared = await repo.prepareOutboundMessage({
        conversationId: conv.id,
        sender: 'human',
        body,
        clientId,
        waMessageId: waId,
        sentBy: user.id,
      });
      const existing = prepared.message;
      if (
        existing.conversation_id !== conv.id ||
        existing.sender !== 'human' ||
        existing.body !== body ||
        existing.sent_by !== user.id
      ) {
        res.status(409).json({ error: 'idempotency_key_reused' });
        return;
      }
      if (!prepared.created && existing.send_status === 'sent') {
        res.json(existing);
        return;
      }
      const claimed = await repo.claimMessageForSending(existing.id, { respectBackoff: false });
      if (!claimed) {
        const current = await repo.getMessageByClientId(clientId);
        res.status(current?.send_status === 'sent' ? 200 : 202).json(current ?? existing);
        return;
      }
      if (!claimed.send_attempt_id) throw new Error('claimed outbound message has no send attempt token');
      const beforeSend = await repo.getConversation(conv.id);
      if (beforeSend?.mode !== 'human') {
        await repo.cancelOutboundMessage(claimed.id, 'conversation_not_human');
        res.status(409).json({ error: 'conversation_not_human' });
        return;
      }
      try {
        const actualWaId = await deps.gateway.sendText(conv.wa_jid, body, waId);
        const finalized = await repo.markMessageSent(existing.id, claimed.send_attempt_id, actualWaId ?? waId);
        if (!finalized) {
          const current = await repo.getMessageByClientId(clientId);
          res.status(current?.send_status === 'sent' ? 200 : 202).json(current ?? existing);
          return;
        }
        await repo.touchConversation(conv.id, { preview: body, incomingFromCustomer: false });
        await audit(req, 'message.sent', 'conversation', conv.id, { messageId: existing.id });
        publishEvent({ type: 'message.updated', conversationId: conv.id });
        const sent = await repo.getMessageByClientId(clientId);
        res.json(sent ?? { ...existing, send_status: 'sent', wa_message_id: waId, error: null });
      } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 500) : 'send_failed';
        await repo.markMessageFailed(existing.id, claimed.send_attempt_id, error).catch(() => false);
        logger.error({ errorType: err instanceof Error ? err.name : typeof err, conversationId: conv.id }, 'failed to send human reply');
        await audit(req, 'message.send_failed', 'conversation', conv.id, { messageId: existing.id });
        publishEvent({ type: 'message.updated', conversationId: conv.id });
        const failed = await repo.getMessageByClientId(clientId);
        res.status(502).json(failed ?? { ...existing, send_status: 'failed', error });
      }
    }),
  );

  // ---- settings: grouped, sanitized DTO (secrets NEVER sent in plaintext) ----
  app.get(
    '/api/settings',
    requireAuth,
    requireAdmin,
    ah(async (_req, res) => {
      const meta = await getResolvedWithMeta();
      res.json(buildSettingsDto(meta));
    }),
  );
  app.put(
    '/api/settings',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      // Accepts both the new batch shape ({ updates: [...] }) and the legacy
      // single shape ({ key, value }) — the pre-Phase-7 dashboard config page
      // still sends the latter.
      const inputs = normalizeSettingsUpdates(req.body);
      if (inputs.length === 0) {
        res.status(400).json({ error: 'no_updates_provided' });
        return;
      }
      const validated = validateSettingsUpdates(inputs, new Set(envLockedKeys()));
      if (!validated.ok) {
        res.status(400).json({
          error: 'invalid_settings_keys',
          keys: validated.offenders,
        });
        return;
      }
      const invalidValues = invalidSettingsValues(validated.updates);
      for (const { entry, raw } of validated.updates) {
        if (!['llm.base_url', 'wc.url', 'wc.front_url'].includes(entry.key)) continue;
        const value = String(raw ?? '').trim();
        if (!value) continue;
        try {
          parseRemoteUrl(value);
        } catch {
          invalidValues.push(entry.key);
        }
      }
      if (invalidValues.length > 0) {
        res.status(400).json({ error: 'invalid_settings_values', keys: [...new Set(invalidValues)] });
        return;
      }
      const entries = validated.updates
        .filter(({ entry, raw }) => !isNoOpSecretUpdate(entry, raw))
        .map(({ entry, raw }) => {
          const stored = coerceForStorage(entry, raw);
          return { key: entry.key, value: entry.secret ? encryptSecret(stored) : stored };
        });
      try {
        await repo.upsertSettings(entries);
      } finally {
        invalidateSettings();
      }
      await audit(req, 'settings.updated', 'settings', undefined, { keys: entries.map((entry) => entry.key) });
      publishEvent({ type: 'settings.updated' });
      deps.recoverUnanswered?.();
      res.json({ ok: true });
    }),
  );

  // ---- staff (agentes) management ----
  app.get(
    '/api/staff',
    requireAuth,
    requireAdmin,
    ah(async (_req, res) => {
      res.json(await repo.listStaff());
    }),
  );

  app.post(
    '/api/staff',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const name = boundedString(req.body?.name ?? '', 200) || null;
      const email = (boundedString(req.body?.email ?? '', 320) ?? '').toLowerCase();
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const role: StaffRole = req.body?.role === 'admin' ? 'admin' : 'agent';
      if (!EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'invalid_email' });
        return;
      }
      if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
        res.status(400).json({ error: 'password_too_short' });
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      // Atomic INSERT ... ON CONFLICT DO NOTHING (see createStaffStrict) instead
      // of a getStaffByEmail pre-check: a pre-check + insert has a race window
      // where two concurrent requests for the same email could both pass the
      // check before either commits.
      const staff = await repo.createStaffStrict(email, hash, name, role);
      if (!staff) {
        res.status(409).json({ error: 'staff_exists' });
        return;
      }
      await audit(req, 'staff.created', 'staff', staff.id, { role });
      res.status(201).json({ id: staff.id, email: staff.email, name: staff.name, role: staff.role });
    }),
  );

  app.delete(
    '/api/staff/:id',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const id = req.params.id as string;
      const user = req.user!;
      const result = await repo.deleteStaffSafely(user.id, id);
      if (result === 'self') {
        res.status(400).json({ error: 'cannot_delete_self' });
        return;
      }
      if (result === 'last_admin') {
        res.status(400).json({ error: 'cannot_delete_last_admin' });
        return;
      }
      if (result === 'not_found') {
        res.status(404).json({ error: 'staff_not_found' });
        return;
      }
      await audit(req, 'staff.deleted', 'staff', id);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/staff/:id/password',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const id = req.params.id as string;
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
        res.status(400).json({ error: 'password_too_short' });
        return;
      }
      if (!(await repo.getStaffById(id))) {
        res.status(404).json({ error: 'staff_not_found' });
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      await repo.updateStaffPassword(id, hash);
      await audit(req, 'staff.password_reset', 'staff', id);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/staff/:id/role',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const role = req.body?.role;
      if (role !== 'admin' && role !== 'agent') {
        res.status(400).json({ error: 'invalid_role' });
        return;
      }
      const result = await repo.updateStaffRoleSafely(req.params.id as string, role);
      if (result.status !== 'updated') {
        res
          .status(result.status === 'not_found' ? 404 : 400)
          .json({ error: result.status === 'not_found' ? 'staff_not_found' : 'cannot_demote_last_admin' });
        return;
      }
      await audit(req, 'staff.role_changed', 'staff', result.staff.id, { role });
      res.json(result.staff);
    }),
  );

  // ---- a customer's WooCommerce orders (for the staff panel) ----
  app.get(
    '/api/conversations/:id/orders',
    requireAuth,
    ah(async (req, res) => {
      const id = req.params.id as string;
      const conv = await repo.getConversation(id);
      if (!conv) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      const byId = new Map<number, WcOrder>();
      try {
        if (conv.phone) (await woo.findOrdersByPhone(conv.phone)).forEach((o) => byId.set(o.id, o));
        if (conv.customer_email) {
          (await woo.findOrdersByEmail(conv.customer_email)).forEach((o) => byId.set(o.id, o));
        }
      } catch (err) {
        logger.error({ err, id }, 'failed to fetch customer orders');
        res.status(502).json({ error: 'orders_fetch_failed', orders: [] });
        return;
      }
      const orders = [...byId.values()]
        .sort((a, b) => (a.date_created < b.date_created ? 1 : -1))
        .slice(0, 10)
        .map(orderForStaff);
      res.json({ orders });
    }),
  );

  // ---- change a WooCommerce order's status from the panel ----
  app.post(
    '/api/conversations/:id/orders/:orderId/status',
    requireAuth,
    ah(async (req, res) => {
      const orderId = positiveInteger(req.params.orderId)!;
      const status = String(req.body?.status ?? '').trim();
      const conv = await repo.getConversation(req.params.id as string);
      if (!conv) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      if (!STATUS_ES[status]) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      try {
        const current = await woo.getOrder(orderId);
        if (!orderBelongsToConversation(current, conv)) {
          res.status(404).json({ error: 'order_not_found_for_customer' });
          return;
        }
        const updated = await woo.updateOrderStatus(orderId, status);
        await audit(req, 'order.status_changed', 'order', String(orderId), {
          conversationId: conv.id,
          from: current.status,
          to: status,
        });
        res.json({ order: orderForStaff(updated) });
      } catch (err) {
        logger.error({ err, orderId, status }, 'failed to update order status');
        res.status(502).json({ error: 'order_status_update_failed' });
      }
    }),
  );

  // ---- send the tracking link + delivery code to the customer ----
  app.post(
    '/api/conversations/:id/orders/:orderId/delivery',
    requireAuth,
    ah(async (req, res) => {
      const orderId = positiveInteger(req.params.orderId)!;
      const trackingUrl = boundedString(req.body?.trackingUrl ?? '', 2_048) ?? '';
      const deliveryCode = boundedString(req.body?.deliveryCode ?? '', 200) ?? '';
      if (!trackingUrl || !deliveryCode) {
        res.status(400).json({ error: 'missing_delivery_fields' });
        return;
      }
      try {
        const tracking = new URL(trackingUrl);
        if (!['https:', 'http:'].includes(tracking.protocol)) throw new Error('bad protocol');
      } catch {
        res.status(400).json({ error: 'invalid_tracking_url' });
        return;
      }
      const conv = await repo.getConversation(req.params.id as string);
      if (!conv) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      let ownedOrder: WcOrder;
      try {
        ownedOrder = await woo.getOrder(orderId);
      } catch (err) {
        logger.error({ err, orderId }, 'failed to fetch order before delivery');
        res.status(502).json({ error: 'orders_fetch_failed' });
        return;
      }
      if (!orderBelongsToConversation(ownedOrder, conv)) {
        res.status(404).json({ error: 'order_not_found_for_customer' });
        return;
      }
      const orderNumber = ownedOrder.number;
      const user = req.user!;
      const profile = await businessProfile();
      const template = (await dispatchTemplate()).trim() || DEFAULT_DELIVERY_TEMPLATE[profile.language];
      const body = buildDeliveryMessage(template, {
        numero: orderNumber,
        link: trackingUrl,
        codigo: deliveryCode,
      });

      if (req.body?.clientId !== undefined && !isUuid(req.body.clientId)) {
        res.status(400).json({ error: 'invalid_client_id' });
        return;
      }
      const clientId = isUuid(req.body?.clientId) ? req.body.clientId : randomUUID();
      const waId = stableWhatsAppMessageId(clientId);
      const prepared = await repo.prepareOutboundMessage({
        conversationId: conv.id,
        sender: 'human',
        body,
        clientId,
        waMessageId: waId,
        sentBy: user.id,
      });
      if (
        prepared.message.conversation_id !== conv.id ||
        prepared.message.body !== body ||
        prepared.message.sender !== 'human' ||
        prepared.message.sent_by !== user.id
      ) {
        res.status(409).json({ error: 'idempotency_key_reused' });
        return;
      }
      if (prepared.message.send_status !== 'sent') {
        const claimed = await repo.claimMessageForSending(prepared.message.id, { respectBackoff: false });
        if (!claimed) {
          const current = await repo.getMessageByClientId(clientId);
          res.status(current?.send_status === 'sent' ? 200 : 202).json({
            message: current ?? prepared.message,
            statusUpdated: false,
          });
          return;
        }
        if (!claimed.send_attempt_id) throw new Error('claimed outbound message has no send attempt token');
        try {
          const actualWaId = await deps.gateway.sendText(conv.wa_jid, body, waId);
          const finalized = await repo.markMessageSent(
            prepared.message.id,
            claimed.send_attempt_id,
            actualWaId ?? waId,
          );
          if (!finalized) {
            const current = await repo.getMessageByClientId(clientId);
            res.status(current?.send_status === 'sent' ? 200 : 202).json({
              message: current ?? prepared.message,
              statusUpdated: false,
            });
            return;
          }
          await repo.touchConversation(conv.id, { preview: body, incomingFromCustomer: false });
        } catch (err) {
          const error = err instanceof Error ? err.message.slice(0, 500) : 'send_failed';
          await repo.markMessageFailed(prepared.message.id, claimed.send_attempt_id, error).catch(() => false);
          logger.error(
            { errorType: err instanceof Error ? err.name : typeof err, conversationId: conv.id },
            'failed to send delivery tracking message',
          );
          const failed = await repo.getMessageByClientId(clientId);
          res.status(502).json({ message: failed ?? { ...prepared.message, send_status: 'failed', error }, statusUpdated: false });
          return;
        }
      }
      const message = (await repo.getMessageByClientId(clientId)) ?? prepared.message;

      // Best-effort: move the order to the dispatch status, if one is configured.
      // An empty wc.status_after_dispatch means the dispatch feature sets no
      // custom status — the message still went out either way. If a custom
      // status isn't registered in WooCommerce the update fails; it's logged,
      // not surfaced as an error (the message already sent is the primary action).
      let statusUpdated = false;
      const wc = await wooConfig();
      if (wc.statusAfterDispatch) {
        try {
          await woo.updateOrderStatus(orderId, wc.statusAfterDispatch);
          statusUpdated = true;
        } catch (err) {
          logger.warn({ err, orderId }, 'could not set dispatch status after delivery message');
        }
      }

      await audit(req, 'order.delivery_sent', 'order', String(orderId), {
        conversationId: conv.id,
        messageId: message.id,
        statusUpdated,
      });
      publishEvent({ type: 'message.updated', conversationId: conv.id });
      res.json({ message, statusUpdated });
    }),
  );

  // ---- explicit human review of a receipt amount/identity match ------------
  app.post(
    '/api/receipts/:receiptId/review',
    requireAuth,
    ah(async (req, res) => {
      const receiptId = req.params.receiptId as string;
      const decision = req.body?.decision;
      const note = boundedString(req.body?.note ?? '', 2_000);
      if ((decision !== 'approved' && decision !== 'rejected') || note === null) {
        res.status(400).json({ error: 'invalid_receipt_review' });
        return;
      }
      const receipt = await repo.getReceipt(receiptId);
      if (!receipt) {
        res.status(404).json({ error: 'receipt_not_found' });
        return;
      }
      if (receipt.review_status !== 'pending') {
        res.status(409).json({ error: 'receipt_already_reviewed' });
        return;
      }
      if (decision === 'rejected') {
        const reviewed = await repo.reviewReceipt(receipt.id, req.user!.id, 'rejected', note || null);
        if (!reviewed) {
          res.status(409).json({ error: 'receipt_already_reviewed' });
          return;
        }
        await audit(req, 'receipt.rejected', 'receipt', receipt.id, { orderId: receipt.woo_order_id });
        publishEvent({ type: 'receipt.updated', conversationId: receipt.conversation_id });
        res.json({ receipt: reviewed });
        return;
      }

      if (receipt.match_status !== 'match' || !receipt.woo_order_id) {
        res.status(409).json({ error: 'receipt_not_approvable' });
        return;
      }
      if (receipt.media_sha256 && (await repo.findApprovedReceiptByHash(receipt.media_sha256, receipt.id))) {
        res.status(409).json({ error: 'receipt_already_used' });
        return;
      }
      if (await repo.findApprovedReceiptByOrder(receipt.woo_order_id, receipt.id)) {
        res.status(409).json({ error: 'order_payment_already_recorded' });
        return;
      }
      const conv = await repo.getConversation(receipt.conversation_id);
      if (!conv) {
        res.status(409).json({ error: 'receipt_conversation_missing' });
        return;
      }
      const wc = await wooConfig();
      const claimed = await repo.claimReceiptReview(receipt.id, req.user!.id, wc.statusAfterPayment);
      const attemptId = claimed?.review_attempt_id;
      if (!claimed || !attemptId) {
        res.status(409).json({ error: 'receipt_already_reviewed' });
        return;
      }
      const release = async (reason: string) => {
        await repo.releaseReceiptReview(receipt.id, attemptId, reason).catch(() => {});
      };

      let order: WcOrder;
      try {
        order = await woo.getOrder(receipt.woo_order_id);
      } catch (err) {
        await release('No se pudo consultar la orden durante la revisión; reintento pendiente.');
        logger.error({ err, receiptId, orderId: receipt.woo_order_id }, 'failed to fetch order during receipt review');
        res.status(502).json({ error: 'orders_fetch_failed' });
        return;
      }
      if (!orderBelongsToConversation(order, conv)) {
        await repo.finalizeReceiptReview(receipt.id, attemptId, 'rejected', 'La orden no pertenece al cliente verificado.');
        res.status(409).json({ error: 'order_not_found_for_customer' });
        return;
      }
      const alreadyPaid = ['processing', 'completed'].includes(order.status);
      const confirmable = ['pending', 'on-hold', 'failed'].includes(order.status);
      if (!alreadyPaid && !confirmable) {
        await repo.finalizeReceiptReview(receipt.id, attemptId, 'rejected', `Estado no confirmable: ${order.status}.`);
        res.status(409).json({ error: 'order_not_confirmable' });
        return;
      }
      const currentTotal = parseAmount(order.total, decimalHintForCurrency(order.currency || wc.currency));
      const receiptAmount = receipt.extracted_amount;
      const currencyMatches =
        !receipt.currency || !order.currency || receipt.currency.toUpperCase() === order.currency.toUpperCase();
      if (
        currentTotal === null ||
        receiptAmount === null ||
        !currencyMatches ||
        !amountsMatch(currentTotal, receiptAmount, wc.tolerance)
      ) {
        await release('El total o la moneda de la orden cambió; se requiere una nueva validación.');
        res.status(409).json({ error: 'receipt_amount_changed' });
        return;
      }
      let updatedOrder = order;
      if (!alreadyPaid) {
        try {
          updatedOrder = await woo.updateOrderStatus(order.id, wc.statusAfterPayment);
        } catch (err) {
          logger.error({ err, receiptId, orderId: order.id }, 'failed to mark reviewed receipt paid');
          const reconciliation = await reconcileReceiptAfterAmbiguousOrderUpdate({
            receiptId: receipt.id,
            attemptId,
            orderId: order.id,
            statusAfterPayment: wc.statusAfterPayment,
            approvedNote: note || 'Pago aprobado y reconciliado después de una respuesta ambigua de WooCommerce.',
          });
          if (reconciliation.state === 'approved') {
            const reviewed = await repo.getReceipt(receipt.id);
            await audit(req, 'receipt.approved_reconciled', 'receipt', receipt.id, {
              orderId: order.id,
              from: order.status,
              to: reconciliation.order.status,
            });
            publishEvent({ type: 'receipt.updated', conversationId: receipt.conversation_id });
            res.json({ receipt: reviewed, order: orderForStaff(reconciliation.order), reconciled: true });
            return;
          }
          if (reconciliation.state === 'rejected') {
            res.status(409).json({ error: 'order_not_confirmable' });
            return;
          }
          res.status(502).json({
            error: reconciliation.state === 'uncertain' ? 'order_status_unknown' : 'order_status_update_failed',
          });
          return;
        }
      }
      try {
        const reviewed = await repo.finalizeReceiptReview(receipt.id, attemptId, 'approved', note || null);
        if (!reviewed) {
          res.status(409).json({ error: 'receipt_already_reviewed' });
          return;
        }
        await audit(req, 'receipt.approved', 'receipt', receipt.id, {
          orderId: order.id,
          from: order.status,
          to: updatedOrder.status,
        });
        publishEvent({ type: 'receipt.updated', conversationId: receipt.conversation_id });
        res.json({ receipt: reviewed, order: orderForStaff(updatedOrder) });
      } catch (err) {
        if ((err as { code?: string } | null)?.code === '23505') {
          await repo.finalizeReceiptReview(
            receipt.id,
            attemptId,
            'rejected',
            'Otra revisión ya registró el pago de esta orden.',
          ).catch(() => null);
          res.status(409).json({ error: 'order_payment_already_recorded' });
          return;
        }
        throw err;
      }
    }),
  );

  app.get(
    '/api/audit',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const limit = req.query.limit === undefined ? 100 : positiveInteger(req.query.limit);
      if (!limit) {
        res.status(400).json({ error: 'invalid_limit' });
        return;
      }
      res.json({ events: await repo.listAuditEvents(Math.min(limit, 500)) });
    }),
  );

  app.get(
    '/api/analytics/usage',
    requireAuth,
    requireAdmin,
    ah(async (req, res) => {
      const days = req.query.days === undefined ? 30 : positiveInteger(req.query.days);
      if (!days) {
        res.status(400).json({ error: 'invalid_days' });
        return;
      }
      res.json({ rows: await repo.getLlmUsageSummary(Math.min(days, 365)) });
    }),
  );

  app.get('/api/metrics', requireAuth, requireAdmin, (_req, res) => {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics());
  });

  app.get(
    '/api/media/*',
    requireAuth,
    ah(async (req, res) => {
      const objectPath = (req.params as unknown as Record<string, string>)[0] ?? '';
      const buf = await readReceiptImage(objectPath);
      if (!buf) {
        res.status(404).end();
        return;
      }
      const ext = objectPath.split('.').pop()?.toLowerCase() ?? '';
      res.type(MIME_BY_EXT[ext] ?? 'application/octet-stream');
      // Receipt images are payment evidence. Never leave them in a shared or
      // browser cache after the authenticated session ends.
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(buf);
    }),
  );

  // error handler
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const shaped = err as { type?: unknown; status?: unknown } | null;
    if (err instanceof SyntaxError && shaped?.type === 'entity.parse.failed') {
      logger.warn({ requestId: (req as AuthedRequest).requestId }, 'invalid JSON request body');
      if (!res.headersSent) res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (shaped?.type === 'entity.too.large' || shaped?.status === 413) {
      logger.warn({ requestId: (req as AuthedRequest).requestId }, 'request body exceeded limit');
      if (!res.headersSent) res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    logger.error(
      { requestId: (req as AuthedRequest).requestId, errorType: err instanceof Error ? err.name : typeof err },
      'API error',
    );
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
