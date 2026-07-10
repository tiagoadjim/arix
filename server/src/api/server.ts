import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import * as repo from '../db/repo';
import { readReceiptImage } from '../storage';
import { woo, type WcOrder } from '../integrations/woocommerce';
import {
  woo as wooConfig,
  dispatchTemplate,
  invalidate as invalidateSettings,
  getResolvedWithMeta,
  getResolved,
  envLockedKeys,
  setupCompleted,
  businessProfile,
  enabledSkills,
  mcpServers,
} from '../config/runtime';
import { encryptSecret } from '../config/secret';
import { PROVIDERS, type ProviderSpec } from '../agent/llm/providers';
import {
  buildSettingsDto,
  normalizeSettingsUpdates,
  validateSettingsUpdates,
  coerceForStorage,
  isNoOpSecretUpdate,
} from './settings-dto';
import { buildSkillCatalog } from '../skills/registry';
import {
  invalidateMcpPool,
  listConnectedServerIds,
  listMcpTools,
  testMcpServer,
} from '../mcp/manager';
import { normalizeMcpServers, toMcpServerDto } from '../mcp/types';
import {
  orderForStaff,
  STATUS_ES,
  buildDeliveryMessage,
  DEFAULT_DELIVERY_TEMPLATE,
} from '../skills/orders';
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from './auth';
import type { WhatsAppGateway } from '../whatsapp/socket';

type ChatCompletionCreateParamsNonStreaming = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/** {connected, hasQr} — the one shape /health, /api/setup/status and
 * /api/whatsapp/status all report the gateway's pairing state in. */
function whatsappStatus(gateway: WhatsAppGateway): { connected: boolean; hasQr: boolean } {
  return { connected: gateway.connected, hasQr: Boolean(gateway.latestQR) };
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

// Constant-time-ish dummy compare target so unknown emails take ~the same time
// as real ones (prevents login timing-based email enumeration).
const DUMMY_HASH = bcrypt.hashSync('arix-dummy-password', 10);

// Simple per-email login throttle (login traffic arrives via the proxy, so IPs
// collapse; throttling per account is the meaningful protection).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map<string, { count: number; resetAt: number }>();
function loginThrottled(email: string): boolean {
  const rec = loginFails.get(email);
  return Boolean(rec && Date.now() <= rec.resetAt && rec.count >= LOGIN_MAX_FAILS);
}
function recordLoginFail(email: string): void {
  const now = Date.now();
  const rec = loginFails.get(email);
  if (!rec || now > rec.resetAt) loginFails.set(email, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else rec.count += 1;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

type AuthedRequest = Request & { user?: SessionUser };

/** Wrap async handlers so rejections reach the express error handler. */
const ah =
  (fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  (req, res, next) =>
    void fn(req as AuthedRequest, res, next).catch(next);

export function createApiServer(deps: { gateway: WhatsAppGateway }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // ---- health (no auth) ----
  // ALWAYS 200: liveness (the process/API is up) is a different question from
  // pairing (WhatsApp connected). Docker's healthcheck (depends_on:
  // service_healthy) must pass BEFORE the first WhatsApp pairing, or the
  // wizard flow deadlocks on first boot — see docker-compose.yml.
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', whatsapp: whatsappStatus(deps.gateway) });
  });

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
      // Shares the login-throttle map/window/threshold below (defined further
      // down but hoisted as a function declaration) under a fixed key: this
      // endpoint is only ever meaningfully called once per deployment, so
      // there's no "existing account" to key by — any repeated
      // failed/rejected attempt is equally suspicious regardless of the
      // posted email.
      const throttleKey = 'setup-admin';
      if (loginThrottled(throttleKey)) {
        res.status(429).json({ error: 'too_many_attempts' });
        return;
      }
      const name = String(req.body?.name ?? '').trim() || null;
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (!EMAIL_RE.test(email)) {
        recordLoginFail(throttleKey);
        res.status(400).json({ error: 'invalid_email' });
        return;
      }
      if (password.length < MIN_PASSWORD_LEN) {
        recordLoginFail(throttleKey);
        res.status(400).json({ error: 'password_too_short' });
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      const staff = await repo.createFirstAdmin(email, hash, name);
      if (!staff) {
        recordLoginFail(throttleKey);
        res.status(409).json({ error: 'setup_already_completed' });
        return;
      }
      loginFails.delete(throttleKey);
      const token = await signSession(staff);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.COOKIE_SECURE,
        path: '/',
        maxAge: 7 * 24 * 3600 * 1000,
      });
      res.json({ id: staff.id, email: staff.email, name: staff.name });
    }),
  );

  // ---- auth ----
  app.post(
    '/api/auth/login',
    ah(async (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (!email || !password) {
        res.status(400).json({ error: 'email_password_required' });
        return;
      }
      if (loginThrottled(email)) {
        res.status(429).json({ error: 'too_many_attempts' });
        return;
      }
      const staff = await repo.getStaffByEmail(email);
      // Always run a bcrypt compare (real or dummy) so timing doesn't reveal whether the email exists.
      const ok = await bcrypt.compare(password, staff?.password_hash ?? DUMMY_HASH);
      if (!staff || !ok) {
        recordLoginFail(email);
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      loginFails.delete(email);
      const token = await signSession(staff);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.COOKIE_SECURE, // set COOKIE_SECURE=true behind HTTPS
        path: '/',
        maxAge: 7 * 24 * 3600 * 1000,
      });
      res.json({ id: staff.id, email: staff.email, name: staff.name });
    }),
  );

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---- auth gate for the rest of /api ----
  const requireAuth = ah(async (req, res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const user = token ? await verifySession(token) : null;
    // Re-validate against the DB so a deleted/disabled staff member is revoked
    // immediately (the JWT alone would stay valid until expiry).
    if (!user || !(await repo.getStaffById(user.id))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.user = user;
    next();
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json((req as AuthedRequest).user);
  });

  // WhatsApp pairing QR — AUTH REQUIRED (the QR is credential-equivalent).
  // For first-time setup, scan it from the server logs instead.
  app.get('/api/qr', requireAuth, (_req, res) => {
    res
      .type('text/plain; charset=utf-8')
      .send(deps.gateway.latestQR ?? (deps.gateway.connected ? 'connected' : 'no QR yet — check logs'));
  });

  // ---- setup wizard: test posted (unsaved) credentials ----
  app.post(
    '/api/setup/test/llm',
    requireAuth,
    ah(async (req, res) => {
      const providerId = String(req.body?.provider ?? '');
      const provider = (PROVIDERS as Record<string, ProviderSpec>)[providerId];
      if (!provider) {
        res.status(400).json({ ok: false, error: 'Unknown provider' });
        return;
      }
      const apiKey = String(req.body?.apiKey ?? '');
      if (!apiKey.trim()) {
        res.status(400).json({ ok: false, error: 'Missing API key' });
        return;
      }
      const model = String(req.body?.model ?? '').trim() || provider.defaultModel;
      const baseUrl = String(req.body?.baseUrl ?? '').trim() || provider.baseURL;

      // Throwaway client built directly from the posted (unsaved) values —
      // deliberately NOT getLlm(): that only ever reads persisted runtime
      // config, and this is testing credentials before any write happens.
      const client = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: 15_000 });
      const body: ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      };
      provider.prepareBody(body, { reasoningSplit: false, thinkingDisabled: false });

      try {
        await client.chat.completions.create(body);
        res.json({ ok: true, model, vision: provider.supportsVision(model) });
      } catch (err) {
        logger.warn({ err, provider: providerId }, 'setup: LLM credential test failed');
        res.json({ ok: false, error: safeLlmTestError(err), model, vision: provider.supportsVision(model) });
      }
    }),
  );

  app.post(
    '/api/setup/test/woocommerce',
    requireAuth,
    ah(async (req, res) => {
      const rawUrl = String(req.body?.url ?? '').trim().replace(/\/$/, '');
      const consumerKey = String(req.body?.consumerKey ?? '').trim();
      const consumerSecret = String(req.body?.consumerSecret ?? '').trim();
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const target = new URL('/wp-json/wc/v3/products', base);
        target.searchParams.set('per_page', '1');
        const resp = await fetch(target, {
          headers: { Authorization: auth, Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!resp.ok) {
          res.json({ ok: false, error: safeWooTestError(resp.status) });
          return;
        }
        const data = (await resp.json()) as Array<{ name?: string }>;
        res.json({ ok: true, sampleProductName: data[0]?.name ?? null });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'AbortError';
        logger.warn({ err }, 'setup: WooCommerce credential test failed');
        res.json({
          ok: false,
          error: timedOut ? 'Request timed out.' : 'Could not connect to the WooCommerce store with these credentials.',
        });
      } finally {
        clearTimeout(timer);
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
    ah(async (req, res) => {
      const force = req.body?.force === true;
      const wasConnected = deps.gateway.connected;
      if (wasConnected && !force) {
        res.status(409).json({ error: 'already_connected' });
        return;
      }
      // A forced restart of an ALREADY connected/paired session must actually
      // invalidate the pairing (clearSession) to get a genuinely new QR —
      // otherwise Baileys just reconnects with the same stored creds and no
      // QR is ever emitted. A restart while still awaiting pairing (not yet
      // connected) just needs a fresh QR for the in-progress session.
      await deps.gateway.restart(wasConnected ? { clearSession: true } : {});
      res.json({ ok: true, whatsapp: whatsappStatus(deps.gateway) });
    }),
  );

  // ---- setup wizard: mark complete ----
  app.post(
    '/api/setup/complete',
    requireAuth,
    ah(async (_req, res) => {
      await repo.upsertSetting('setup.completed', 'true');
      invalidateSettings();
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/conversations',
    requireAuth,
    ah(async (_req, res) => {
      res.json(await repo.listConversations());
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
      const since = String(req.query.since ?? '');
      const msgs = since ? await repo.getMessagesSince(id, since) : await repo.getMessages(id);
      res.json(msgs);
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
      const user = req.user!;
      await repo.setConversationMode(id, mode, {
        assignedTo: mode === 'human' ? user.id : null,
        escalationReason: mode === 'human' ? 'Tomado por un agente' : null,
      });
      res.json(await repo.getConversation(id));
    }),
  );

  app.post(
    '/api/conversations/:id/messages',
    requireAuth,
    ah(async (req, res) => {
      const body = String(req.body?.body ?? '').trim();
      if (!body) {
        res.status(400).json({ error: 'empty_message' });
        return;
      }
      const conv = await repo.getConversation(req.params.id as string);
      if (!conv) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      const user = req.user!;
      let waId: string | null = null;
      let sendStatus: 'sent' | 'failed' = 'sent';
      let error: string | null = null;
      try {
        waId = await deps.gateway.sendText(conv.wa_jid, body);
      } catch (err) {
        sendStatus = 'failed';
        error = err instanceof Error ? err.message : String(err);
        logger.error({ err, conversationId: conv.id }, 'failed to send human reply');
      }
      const msg = await repo.insertOutboundMessage({
        conversationId: conv.id,
        sender: 'human',
        body,
        sendStatus,
        waMessageId: waId,
        sentBy: user.id,
        error,
      });
      await repo.touchConversation(conv.id, { preview: body, incomingFromCustomer: false });
      res.status(sendStatus === 'failed' ? 502 : 200).json(msg);
    }),
  );

  // ---- settings: grouped, sanitized DTO (secrets NEVER sent in plaintext) ----
  app.get(
    '/api/settings',
    requireAuth,
    ah(async (_req, res) => {
      const meta = await getResolvedWithMeta();
      res.json(buildSettingsDto(meta));
    }),
  );
  app.put(
    '/api/settings',
    requireAuth,
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
      // Snapshot current values before writing so mcp.servers can merge
      // blank env/header fields as "keep current" (see coerceForStorage).
      const previous = await getResolved();
      let touchedMcp = false;
      try {
        await Promise.all(
          validated.updates
            // An empty/null/undefined value for a `secret: true` key means
            // "keep the currently stored secret" — never overwrite it with
            // blank, and never treat it as an error (see isNoOpSecretUpdate).
            .filter(({ entry, raw }) => !isNoOpSecretUpdate(entry, raw))
            .map(({ entry, raw }) => {
              if (entry.key === 'mcp.servers') touchedMcp = true;
              const stored = coerceForStorage(entry, raw, previous[entry.key]);
              return repo.upsertSetting(entry.key, entry.secret ? encryptSecret(stored) : stored);
            }),
        );
      } finally {
        // Always invalidate, even on partial failure: Promise.all doesn't
        // cancel the writes that already started, so the cache must never
        // stay stale relative to whatever did land.
        invalidateSettings();
        if (touchedMcp) invalidateMcpPool();
      }
      res.json({ ok: true });
    }),
  );

  // ---- skills catalog (built-in, with enable flags) ----
  app.get(
    '/api/skills',
    requireAuth,
    ah(async (_req, res) => {
      const enabled = await enabledSkills();
      res.json({ skills: buildSkillCatalog(enabled) });
    }),
  );

  // ---- MCP servers: status + live tools + connection test ----
  app.get(
    '/api/mcp',
    requireAuth,
    ah(async (_req, res) => {
      const [servers, connectedIds, tools] = await Promise.all([
        mcpServers(),
        listConnectedServerIds(),
        listMcpTools(),
      ]);
      const connected = new Set(connectedIds);
      res.json({
        servers: servers.map((s) => ({
          ...toMcpServerDto(s),
          connected: connected.has(s.id),
        })),
        tools,
      });
    }),
  );

  app.post(
    '/api/mcp/test',
    requireAuth,
    ah(async (req, res) => {
      const configs = normalizeMcpServers([req.body]);
      const cfg = configs[0];
      if (!cfg) {
        res.status(400).json({ ok: false, error: 'Invalid MCP server configuration.' });
        return;
      }
      const result = await testMcpServer(cfg);
      res.json(result);
    }),
  );

  // ---- staff (agentes) management ----
  app.get(
    '/api/staff',
    requireAuth,
    ah(async (_req, res) => {
      res.json(await repo.listStaff());
    }),
  );

  app.post(
    '/api/staff',
    requireAuth,
    ah(async (req, res) => {
      const name = String(req.body?.name ?? '').trim() || null;
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (!EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'invalid_email' });
        return;
      }
      if (password.length < MIN_PASSWORD_LEN) {
        res.status(400).json({ error: 'password_too_short' });
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      // Atomic INSERT ... ON CONFLICT DO NOTHING (see createStaffStrict) instead
      // of a getStaffByEmail pre-check: a pre-check + insert has a race window
      // where two concurrent requests for the same email could both pass the
      // check before either commits.
      const staff = await repo.createStaffStrict(email, hash, name);
      if (!staff) {
        res.status(409).json({ error: 'staff_exists' });
        return;
      }
      res.status(201).json({ id: staff.id, email: staff.email, name: staff.name });
    }),
  );

  app.delete(
    '/api/staff/:id',
    requireAuth,
    ah(async (req, res) => {
      const id = req.params.id as string;
      const user = req.user!;
      if (id === user.id) {
        res.status(400).json({ error: 'cannot_delete_self' });
        return;
      }
      if ((await repo.countStaff()) <= 1) {
        res.status(400).json({ error: 'cannot_delete_last_staff' });
        return;
      }
      if (!(await repo.getStaffById(id))) {
        res.status(404).json({ error: 'staff_not_found' });
        return;
      }
      await repo.deleteStaff(id);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/staff/:id/password',
    requireAuth,
    ah(async (req, res) => {
      const id = req.params.id as string;
      const password = String(req.body?.password ?? '');
      if (password.length < MIN_PASSWORD_LEN) {
        res.status(400).json({ error: 'password_too_short' });
        return;
      }
      if (!(await repo.getStaffById(id))) {
        res.status(404).json({ error: 'staff_not_found' });
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      await repo.updateStaffPassword(id, hash);
      res.json({ ok: true });
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
      const orderId = Number(req.params.orderId);
      const status = String(req.body?.status ?? '').trim();
      if (!Number.isFinite(orderId)) {
        res.status(400).json({ error: 'invalid_order_id' });
        return;
      }
      if (!STATUS_ES[status]) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      try {
        const updated = await woo.updateOrderStatus(orderId, status);
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
      const orderId = Number(req.params.orderId);
      const trackingUrl = String(req.body?.trackingUrl ?? '').trim();
      const deliveryCode = String(req.body?.deliveryCode ?? '').trim();
      const orderNumber = String(req.body?.orderNumber ?? '').trim() || String(orderId);
      if (!Number.isFinite(orderId)) {
        res.status(400).json({ error: 'invalid_order_id' });
        return;
      }
      if (!trackingUrl || !deliveryCode) {
        res.status(400).json({ error: 'missing_delivery_fields' });
        return;
      }
      const conv = await repo.getConversation(req.params.id as string);
      if (!conv) {
        res.status(404).json({ error: 'conversation_not_found' });
        return;
      }
      const user = req.user!;
      const profile = await businessProfile();
      const template = (await dispatchTemplate()).trim() || DEFAULT_DELIVERY_TEMPLATE[profile.language];
      const body = buildDeliveryMessage(template, {
        numero: orderNumber,
        link: trackingUrl,
        codigo: deliveryCode,
      });

      // Send the WhatsApp message (the primary action) — same pattern as a human reply.
      let waId: string | null = null;
      let sendStatus: 'sent' | 'failed' = 'sent';
      let error: string | null = null;
      try {
        waId = await deps.gateway.sendText(conv.wa_jid, body);
      } catch (err) {
        sendStatus = 'failed';
        error = err instanceof Error ? err.message : String(err);
        logger.error({ err, conversationId: conv.id }, 'failed to send delivery tracking message');
      }
      const message = await repo.insertOutboundMessage({
        conversationId: conv.id,
        sender: 'agent',
        body,
        sendStatus,
        waMessageId: waId,
        sentBy: user.id,
        error,
      });
      await repo.touchConversation(conv.id, { preview: body, incomingFromCustomer: false });

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

      res.status(sendStatus === 'failed' ? 502 : 200).json({ message, statusUpdated });
    }),
  );

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
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(buf);
    }),
  );

  // error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'API error');
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
