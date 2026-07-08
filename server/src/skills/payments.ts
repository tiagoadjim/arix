import { woo } from '../integrations/woocommerce';
import { config } from '../config';
import { insertReceipt, setConversationEmail } from '../db/repo';
import { logger } from '../logger';
import { STATUS_ES, checkIdentity } from './orders';
import type { ToolSpec } from '../agent/tool-spec';
import type { ReceiptMatchStatus, ToolContext } from '../types';

/**
 * Normalize an amount that may arrive as a number or a localized string
 * ("1.234,56", "1,234.56", "$ 1234"). Returns a float or null.
 * Pure + exported for unit testing.
 */
export function parseAmount(input: number | string | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;

  let s = String(input).trim().replace(/[^0-9.,-]/g, '');
  if (!s) return null;

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    const decSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    s = s.split(thouSep).join('').replace(decSep, '.');
  } else if (hasComma) {
    const parts = s.split(',');
    s = parts.length === 2 && (parts[1]?.length ?? 0) <= 2 ? `${parts[0]}.${parts[1]}` : parts.join('');
  } else if (hasDot) {
    const parts = s.split('.');
    s = parts.length === 2 && (parts[1]?.length ?? 0) <= 2 ? `${parts[0]}.${parts[1]}` : parts.join('');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Deterministic amount comparison with an absolute tolerance. Pure + tested. */
export function amountsMatch(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= Math.abs(tolerance);
}

export const paymentTools: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'confirmar_pago',
        description:
          'Valida un comprobante de transferencia contra una orden de WooCommerce y, si el monto coincide con el total, marca la orden como pagada (cambia su estado). Primero leé el monto del comprobante (la imagen que mandó el cliente) y pasalo en monto_comprobante. El servidor compara el monto de forma exacta y cambia el estado solo si coincide; NO confíes en tu propia aritmética. Usá esta tool únicamente cuando el cliente ya envió la imagen del comprobante y te dio (o confirmaste) el número de orden.',
        parameters: {
          type: 'object',
          properties: {
            numero_orden: { type: 'string', description: 'Número de orden del cliente.' },
            monto_comprobante: {
              type: 'number',
              description:
                'El monto total que leíste en el comprobante de transferencia, como número, sin separador de miles y con punto decimal (ej: 15400 o 15400.50).',
            },
            email: {
              type: 'string',
              description:
                'Opcional. Email del cliente, para verificar identidad cuando el teléfono del chat no coincide con la orden.',
            },
          },
          required: ['numero_orden', 'monto_comprobante'],
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const numero = String(args.numero_orden ?? '').trim();
      const email = String(args.email ?? '').trim();
      const monto = parseAmount(args.monto_comprobante as number | string);
      if (!numero) return { ok: false, motivo: 'falta_numero_orden' };
      if (monto == null || monto <= 0) return { ok: false, motivo: 'monto_invalido' };

      const order = await woo.resolveOrderByNumber(numero);
      if (!order) return { ok: false, motivo: 'orden_no_encontrada', numero };

      const total = parseAmount(order.total);
      const mediaUrl = ctx.lastImage?.mediaUrl ?? null;
      const messageId = ctx.lastImage?.messageId ?? null;

      const record = (matchStatus: ReceiptMatchStatus, note: string) =>
        insertReceipt({
          conversationId: ctx.conversationId,
          messageId,
          orderNumber: order.number,
          wooOrderId: order.id,
          mediaUrl,
          extractedAmount: monto,
          wooTotal: total,
          currency: order.currency,
          matchStatus,
          note,
        }).catch((err) => logger.error({ err }, 'failed to record receipt'));

      // Identity: the chat phone must match the order's billing phone, OR the
      // customer provides the matching billing email. Without a verified identity
      // we never confirm (an attacker who knew the order number + total could
      // otherwise confirm a fabricated receipt). If the phone doesn't match and no
      // email was given yet, ask for the email instead of failing/escalating.
      const id = checkIdentity(order, ctx, email);
      if (!id.verified) {
        await record(
          'mismatch',
          id.emailProvided ? 'Email no coincide con la orden.' : 'Identidad no verificada (teléfono distinto, falta email).',
        );
        return { ok: false, motivo: id.emailProvided ? 'identidad_no_verificable' : 'pedir_email' };
      }
      if (id.byEmail && email) {
        await setConversationEmail(ctx.conversationId, email.trim().toLowerCase()).catch((err) =>
          logger.warn({ err }, 'failed to store customer email'),
        );
      }

      // Idempotency: never "re-confirm" an order already paid/being prepared.
      if (order.status === 'processing' || order.status === 'completed') {
        ctx.onReceiptConsumed?.();
        return {
          ok: true,
          ya_confirmada: true,
          estado: order.status,
          estado_texto: STATUS_ES[order.status] ?? order.status,
          total: order.total,
          moneda: order.currency,
        };
      }

      // State guard: only confirm from a genuine pre-payment state. Never
      // re-activate a cancelled/refunded order off a matching receipt.
      const CONFIRMABLE = new Set(['pending', 'on-hold', 'failed']);
      if (!CONFIRMABLE.has(order.status)) {
        await record('mismatch', `Estado de orden no confirmable: ${order.status}.`);
        return {
          ok: false,
          motivo: 'orden_no_confirmable',
          estado: order.status,
          estado_texto: STATUS_ES[order.status] ?? order.status,
        };
      }

      if (total == null) {
        await record('unreadable', 'No se pudo interpretar el total de la orden.');
        return { ok: false, motivo: 'no_se_pudo_leer_total_orden' };
      }

      if (!amountsMatch(total, monto, config.PAYMENT_AMOUNT_TOLERANCE)) {
        await record('mismatch', `Monto comprobante ${monto} ≠ total ${total}.`);
        return {
          ok: false,
          motivo: 'monto_no_coincide',
          total: order.total,
          moneda: order.currency,
          monto_comprobante: monto,
          diferencia: Math.round((monto - total) * 100) / 100,
        };
      }

      // Amounts match + identity verified + confirmable state → mark as paid.
      try {
        const updated = await woo.updateOrderStatus(order.id, config.WC_STATUS_AFTER_PAYMENT);
        await record('match', 'Pago confirmado automáticamente (identidad verificada).');
        ctx.onReceiptConsumed?.();
        return {
          ok: true,
          confirmada: true,
          estado: updated.status,
          estado_texto: STATUS_ES[updated.status] ?? updated.status,
          total: order.total,
          moneda: order.currency,
          monto_comprobante: monto,
          identidad_verificada: true,
        };
      } catch (err) {
        await record('match', 'Monto coincide pero falló el cambio de estado en WooCommerce.');
        logger.error({ err, orderId: order.id }, 'failed to update order status');
        return { ok: false, motivo: 'error_actualizando_orden' };
      }
    },
  },
];
