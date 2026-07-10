import { woo, normalizePhone, type WcOrder } from '../integrations/woocommerce';
import { setConversationEmail } from '../db/repo';
import { logger } from '../logger';
import type { ToolSpec } from '../agent/tool-spec';
import type { ToolContext } from '../types';

/**
 * Set of valid order status codes, keyed by the raw WooCommerce status
 * (values are Spanish labels kept only for the legacy `en-camino` custom
 * status's internal documentation — NEVER sent to the model or the
 * dashboard: both now render status purely from the raw code, the model via
 * the code itself and the dashboard via its own i18n orderStatuses dict).
 */
export const STATUS_ES: Record<string, string> = {
  pending: 'pago pendiente',
  processing: 'en preparación',
  'en-camino': 'en camino 🛵',
  'on-hold': 'en espera (pago no confirmado)',
  completed: 'completado',
  cancelled: 'cancelado',
  refunded: 'reembolsado',
  failed: 'fallido',
};

/** Default WhatsApp template sent to the customer when an order ships for delivery.
 *  Placeholders: {numero} {link} {codigo}. Editable from the dashboard (settings key
 *  `dispatch.template`, see config/runtime.ts's dispatchTemplate()); this is the
 *  fallback when that setting is empty, picked by the business's agent
 *  language (businessProfile().language) at the point the template is
 *  resolved — see POST /api/conversations/:id/orders/:orderId/delivery in
 *  api/server.ts. Courier-agnostic by design: no third-party delivery brand
 *  is baked in. */
export const DEFAULT_DELIVERY_TEMPLATE: Record<'es' | 'en', string> = {
  es: `🛵 ¡Tu pedido #{numero} ya salió para entrega!

Seguí el envío en tiempo real acá:
{link}

Tu código de entrega es: *{codigo}*
Decíselo a la persona que te lo entregue para recibir tu pedido. ¡Gracias por tu compra! 💚`,
  en: `🛵 Your order #{numero} is out for delivery!

Track it live here:
{link}

Your delivery code is: *{codigo}*
Give it to the person delivering it to receive your order. Thanks for your purchase! 💚`,
};

/** Fill the delivery message template with the tracking link + code. */
export function buildDeliveryMessage(
  template: string,
  vars: { numero: string; link: string; codigo: string },
): string {
  return template
    .replace(/\{numero\}/g, vars.numero)
    .replace(/\{link\}/g, vars.link)
    .replace(/\{codigo\}/g, vars.codigo);
}

/**
 * Verify the customer's identity for an order: the chat phone matches the order's
 * billing phone, OR (fallback) a provided email matches the order's billing email.
 */
export function checkIdentity(
  order: WcOrder,
  ctx: ToolContext,
  email?: string,
): { verified: boolean; emailProvided: boolean; byEmail: boolean } {
  const chatPhone = normalizePhone(ctx.phone);
  const orderPhone = normalizePhone(order.billing?.phone);
  const phoneMatch = Boolean(chatPhone && orderPhone && chatPhone === orderPhone);

  const e = (email ?? '').trim().toLowerCase();
  const orderEmail = (order.billing?.email ?? '').trim().toLowerCase();
  const emailMatch = Boolean(e && orderEmail && e === orderEmail);

  return { verified: phoneMatch || emailMatch, emailProvided: Boolean(e), byEmail: emailMatch };
}

/**
 * Persist the customer's email once identity was verified BY email (not by
 * phone) — lets the dashboard list this customer's orders later. Shared
 * between find_order (below) and confirm_payment (skills/payments.ts), which
 * both used to duplicate this exact side effect. Best-effort: a failure to
 * store the email never fails the tool call itself.
 */
export async function persistVerifiedEmail(
  ctx: ToolContext,
  identity: { byEmail: boolean },
  email: string,
): Promise<void> {
  if (!identity.byEmail || !email) return;
  if (ctx.signal?.aborted) throw ctx.signal.reason;
  await setConversationEmail(ctx.conversationId, email.trim().toLowerCase()).catch((err) =>
    logger.warn({ err }, 'failed to store customer email'),
  );
}

/** Detailed order view for the staff dashboard (items + shipping address). */
export function orderForStaff(order: WcOrder) {
  const s = order.shipping ?? {};
  const b = order.billing ?? ({} as WcOrder['billing']);
  const name =
    [s.first_name, s.last_name].filter(Boolean).join(' ') ||
    [b.first_name, b.last_name].filter(Boolean).join(' ') ||
    null;
  return {
    id: order.id,
    number: order.number,
    date: order.date_created,
    // Raw WooCommerce status code — the dashboard renders the label itself
    // via its own i18n orderStatuses dict (see orders-panel.tsx), so no
    // Spanish label is sent over the wire (see STATUS_ES's docstring).
    status: order.status,
    total: order.total,
    currency: order.currency,
    payment_method: order.payment_method_title || order.payment_method || null,
    paid: Boolean(order.date_paid),
    items: (order.line_items ?? []).map((li) => ({ product: li.name, quantity: li.quantity })),
    shipping: {
      name,
      address: [s.address_1 ?? b.address_1, s.address_2 ?? b.address_2].filter(Boolean).join(', ') || null,
      city: s.city ?? b.city ?? null,
      state: s.state ?? b.state ?? null,
      postal_code: s.postcode ?? b.postcode ?? null,
    },
    phone: b.phone || null,
    email: b.email || null,
  };
}

/** Build a customer-safe summary of an order + whether the chat phone matches. */
export function orderSummary(order: WcOrder, ctx: ToolContext) {
  const chatPhone = normalizePhone(ctx.phone);
  const orderPhone = normalizePhone(order.billing?.phone);
  const phoneMatches = chatPhone && orderPhone ? chatPhone === orderPhone : null;
  return {
    found: true,
    number: order.number,
    order_id: order.id,
    // Raw WooCommerce status code (no Spanish label) — the reply LANGUAGE is
    // already pinned by the persona prompt, so the model just needs the code.
    status: order.status,
    total: order.total,
    currency: order.currency,
    payment_method: order.payment_method_title || order.payment_method,
    customer: [order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(' ') || null,
    items: (order.line_items ?? []).map((li) => ({ product: li.name, quantity: li.quantity })),
    date: order.date_created,
    paid: Boolean(order.date_paid),
    phone_matches: phoneMatches,
  };
}

export const orderTools: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'find_order',
        description:
          "Looks up an order by its number and verifies identity: by the chat's phone or, if that doesn't match, by an email the customer gives you. Returns status, total and items ONLY if identity is verified. Ask for the order number before using this tool.",
        parameters: {
          type: 'object',
          properties: {
            order_number: {
              type: 'string',
              description: 'The order number the customer gave (digits/dashes only).',
            },
            email: {
              type: 'string',
              description:
                "Optional. The customer's email, to verify identity when the chat's phone doesn't match the order.",
            },
          },
          required: ['order_number'],
        },
      },
    },
    handler: async (args, ctx) => {
      const orderNumber = String(args.order_number ?? '').trim();
      const email = String(args.email ?? '').trim();
      if (!orderNumber) return { found: false, reason: 'missing_order_number' };
      const order = await woo.resolveOrderByNumber(orderNumber, ctx.signal);
      if (!order) return { found: false, number: orderNumber };

      // Privacy gate: order numbers are guessable. Only reveal PII/total when the
      // identity is verified (phone or email). Otherwise ask for the email.
      const id = checkIdentity(order, ctx, email);
      if (!id.verified) {
        return {
          found: true,
          verified: false,
          number: order.number,
          reason: id.emailProvided ? 'email_mismatch' : 'ask_email',
          message: id.emailProvided
            ? "The email doesn't match the order. Ask the customer to double-check the email, or hand off to a human."
            : 'The phone number doesn\'t match the order. Ask the customer for the email used for the purchase and call this tool again passing it in "email".',
        };
      }
      // Remember the verified email so the dashboard can list this customer's orders.
      await persistVerifiedEmail(ctx, id, email);
      return orderSummary(order, ctx);
    },
  },
];
