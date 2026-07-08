import { woo, phoneSuffix, type WcOrder } from '../integrations/woocommerce';
import { setConversationEmail } from '../db/repo';
import { logger } from '../logger';
import type { ToolSpec } from '../agent/tool-spec';
import type { ToolContext } from '../types';

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

/** Default WhatsApp template sent to the customer when an order ships via Uber Moto.
 *  Placeholders: {numero} {link} {codigo}. Editable from the dashboard (settings key
 *  `uber_envio_template`); this constant is the fallback when that setting is empty. */
export const DEFAULT_DELIVERY_TEMPLATE = `🛵 ¡Tu pedido #{numero} ya salió para entrega con Uber Moto!

Seguí al repartidor en tiempo real acá:
{link}

Tu código de entrega es: *{codigo}*
Decíselo al repartidor cuando llegue para recibir tu pedido. ¡Gracias por tu compra! 💚`;

/** Fill the Uber-Moto delivery template with the tracking link + code. */
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
  const chatSuffix = phoneSuffix(ctx.phone);
  const orderSuffix = phoneSuffix(order.billing?.phone);
  const phoneMatch = Boolean(chatSuffix && orderSuffix && chatSuffix === orderSuffix);

  const e = (email ?? '').trim().toLowerCase();
  const orderEmail = (order.billing?.email ?? '').trim().toLowerCase();
  const emailMatch = Boolean(e && orderEmail && e === orderEmail);

  return { verified: phoneMatch || emailMatch, emailProvided: Boolean(e), byEmail: emailMatch };
}

const STATUS_LABEL = (s: string) => STATUS_ES[s] ?? s;

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
    numero: order.number,
    fecha: order.date_created,
    estado: order.status,
    estado_texto: STATUS_LABEL(order.status),
    total: order.total,
    moneda: order.currency,
    metodo_pago: order.payment_method_title || order.payment_method || null,
    pagado: Boolean(order.date_paid),
    items: (order.line_items ?? []).map((li) => ({ producto: li.name, cantidad: li.quantity })),
    envio: {
      nombre: name,
      direccion: [s.address_1 ?? b.address_1, s.address_2 ?? b.address_2].filter(Boolean).join(', ') || null,
      ciudad: s.city ?? b.city ?? null,
      provincia: s.state ?? b.state ?? null,
      cp: s.postcode ?? b.postcode ?? null,
    },
    telefono: b.phone || null,
    email: b.email || null,
  };
}

/** Build a customer-safe summary of an order + whether the chat phone matches. */
export function orderSummary(order: WcOrder, ctx: ToolContext) {
  const chatSuffix = phoneSuffix(ctx.phone);
  const orderSuffix = phoneSuffix(order.billing?.phone);
  const telefonoCoincide = chatSuffix && orderSuffix ? chatSuffix === orderSuffix : null;
  return {
    encontrada: true,
    numero: order.number,
    order_id: order.id,
    estado: order.status,
    estado_texto: STATUS_ES[order.status] ?? order.status,
    total: order.total,
    moneda: order.currency,
    metodo_pago: order.payment_method_title || order.payment_method,
    cliente: [order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(' ') || null,
    items: (order.line_items ?? []).map((li) => ({ producto: li.name, cantidad: li.quantity })),
    fecha: order.date_created,
    pagado: Boolean(order.date_paid),
    telefono_coincide: telefonoCoincide,
  };
}

export const orderTools: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'buscar_orden',
        description:
          'Busca una orden por su número y verifica identidad: por el teléfono del chat o, si no coincide, por el email que te dé el cliente. Devuelve estado, total e items SOLO si la identidad está verificada. Pedí el número de orden antes de usar esta tool.',
        parameters: {
          type: 'object',
          properties: {
            numero_orden: {
              type: 'string',
              description: 'El número de orden que dio el cliente (sólo dígitos/guiones).',
            },
            email: {
              type: 'string',
              description:
                'Opcional. Email del cliente, para verificar identidad cuando el teléfono del chat no coincide con la orden.',
            },
          },
          required: ['numero_orden'],
        },
      },
    },
    handler: async (args, ctx) => {
      const numero = String(args.numero_orden ?? '').trim();
      const email = String(args.email ?? '').trim();
      if (!numero) return { encontrada: false, motivo: 'falta_numero_orden' };
      const order = await woo.resolveOrderByNumber(numero);
      if (!order) return { encontrada: false, numero };

      // Privacy gate: order numbers are guessable. Only reveal PII/total when the
      // identity is verified (phone or email). Otherwise ask for the email.
      const id = checkIdentity(order, ctx, email);
      if (!id.verified) {
        return {
          encontrada: true,
          verificada: false,
          numero: order.number,
          motivo: id.emailProvided ? 'email_no_coincide' : 'pedir_email',
          mensaje: id.emailProvided
            ? 'El email no coincide con la orden. Pedile que verifique el email, o derivá a un humano.'
            : 'El teléfono no coincide con la orden. Pedile el email con el que hizo la compra y volvé a intentar pasándolo en "email".',
        };
      }
      // Remember the verified email so the dashboard can list this customer's orders.
      if (id.byEmail && email) {
        await setConversationEmail(ctx.conversationId, email.trim().toLowerCase()).catch((err) =>
          logger.warn({ err }, 'failed to store customer email'),
        );
      }
      return orderSummary(order, ctx);
    },
  },
];
