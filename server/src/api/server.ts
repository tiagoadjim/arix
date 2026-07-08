import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { logger } from '../logger';
import * as repo from '../db/repo';
import { readReceiptImage } from '../storage';
import { woo, type WcOrder } from '../integrations/woocommerce';
import {
  orderForStaff,
  STATUS_ES,
  buildDeliveryMessage,
  DEFAULT_DELIVERY_TEMPLATE,
} from '../skills/orders';
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from './auth';
import type { WhatsAppGateway } from '../whatsapp/socket';

// Constant-time-ish dummy compare target so unknown emails take ~the same time
// as real ones (prevents login timing-based email enumeration).
const DUMMY_HASH = bcrypt.hashSync('nico-dummy-password', 10);

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

  // ---- health / QR (no auth) ----
  app.get('/health', (_req, res) => {
    res
      .status(deps.gateway.connected ? 200 : 503)
      .json({ connected: deps.gateway.connected, awaitingQr: Boolean(deps.gateway.latestQR) });
  });
  // ---- auth ----
  app.post(
    '/api/auth/login',
    ah(async (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (!email || !password) {
        res.status(400).json({ error: 'Email y contraseña requeridos' });
        return;
      }
      if (loginThrottled(email)) {
        res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
        return;
      }
      const staff = await repo.getStaffByEmail(email);
      // Always run a bcrypt compare (real or dummy) so timing doesn't reveal whether the email exists.
      const ok = await bcrypt.compare(password, staff?.password_hash ?? DUMMY_HASH);
      if (!staff || !ok) {
        recordLoginFail(email);
        res.status(401).json({ error: 'Credenciales inválidas' });
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
      res.status(401).json({ error: 'No autorizado' });
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
        res.status(404).json({ error: 'Conversación no encontrada' });
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
        res.status(400).json({ error: 'mode inválido' });
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
        res.status(400).json({ error: 'Mensaje vacío' });
        return;
      }
      const conv = await repo.getConversation(req.params.id as string);
      if (!conv) {
        res.status(404).json({ error: 'Conversación no encontrada' });
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

  // ---- store settings (payment methods, shipping, …) ----
  app.get(
    '/api/settings',
    requireAuth,
    ah(async (_req, res) => {
      res.json(await repo.getSettings());
    }),
  );
  app.put(
    '/api/settings',
    requireAuth,
    ah(async (req, res) => {
      const key = String(req.body?.key ?? '').trim();
      const value = String(req.body?.value ?? '');
      if (!key) {
        res.status(400).json({ error: 'Falta "key"' });
        return;
      }
      await repo.upsertSetting(key, value);
      res.json({ ok: true });
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
        res.status(400).json({ error: 'Email inválido' });
        return;
      }
      if (password.length < MIN_PASSWORD_LEN) {
        res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LEN} caracteres` });
        return;
      }
      if (await repo.getStaffByEmail(email)) {
        res.status(409).json({ error: 'Ya existe un agente con ese email' });
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      const staff = await repo.createStaff(email, hash, name);
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
        res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
        return;
      }
      if ((await repo.countStaff()) <= 1) {
        res.status(400).json({ error: 'No podés eliminar el último agente' });
        return;
      }
      if (!(await repo.getStaffById(id))) {
        res.status(404).json({ error: 'Agente no encontrado' });
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
        res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LEN} caracteres` });
        return;
      }
      if (!(await repo.getStaffById(id))) {
        res.status(404).json({ error: 'Agente no encontrado' });
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
        res.status(404).json({ error: 'Conversación no encontrada' });
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
        res.status(502).json({ error: 'No se pudieron traer las órdenes', orders: [] });
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
        res.status(400).json({ error: 'orderId inválido' });
        return;
      }
      if (!STATUS_ES[status]) {
        res.status(400).json({ error: 'Estado inválido' });
        return;
      }
      try {
        const updated = await woo.updateOrderStatus(orderId, status);
        res.json({ order: orderForStaff(updated) });
      } catch (err) {
        logger.error({ err, orderId, status }, 'failed to update order status');
        res.status(502).json({ error: 'No se pudo cambiar el estado en WooCommerce' });
      }
    }),
  );

  // ---- send the Uber Moto tracking link + delivery code to the customer ----
  app.post(
    '/api/conversations/:id/orders/:orderId/delivery',
    requireAuth,
    ah(async (req, res) => {
      const orderId = Number(req.params.orderId);
      const trackingUrl = String(req.body?.trackingUrl ?? '').trim();
      const deliveryCode = String(req.body?.deliveryCode ?? '').trim();
      const orderNumber = String(req.body?.orderNumber ?? '').trim() || String(orderId);
      if (!Number.isFinite(orderId)) {
        res.status(400).json({ error: 'orderId inválido' });
        return;
      }
      if (!trackingUrl || !deliveryCode) {
        res.status(400).json({ error: 'Faltan el enlace de seguimiento o el código de entrega' });
        return;
      }
      const conv = await repo.getConversation(req.params.id as string);
      if (!conv) {
        res.status(404).json({ error: 'Conversación no encontrada' });
        return;
      }
      const user = req.user!;
      const settings = await repo.getSettings();
      const template = settings.uber_envio_template?.trim() || DEFAULT_DELIVERY_TEMPLATE;
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
        logger.error({ err, conversationId: conv.id }, 'failed to send Uber delivery message');
      }
      const message = await repo.insertOutboundMessage({
        conversationId: conv.id,
        sender: 'nico',
        body,
        sendStatus,
        waMessageId: waId,
        sentBy: user.id,
        error,
      });
      await repo.touchConversation(conv.id, { preview: body, incomingFromCustomer: false });

      // Best-effort: move the order to the dispatch status. If the custom status
      // isn't registered in WooCommerce this fails — the message still went out.
      let statusUpdated = false;
      try {
        await woo.updateOrderStatus(orderId, config.WC_STATUS_AFTER_DISPATCH);
        statusUpdated = true;
      } catch (err) {
        logger.warn({ err, orderId }, 'could not set dispatch status after delivery message');
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
    if (!res.headersSent) res.status(500).json({ error: 'Error interno' });
  });

  return app;
}
