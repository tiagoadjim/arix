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
        name: 'confirm_payment',
        description:
          "Validates a transfer receipt against a WooCommerce order and, if the amount matches the total, marks the order as paid (changes its status). First read the amount off the receipt (the image the customer sent) and pass it as receipt_amount. The server compares the amount exactly and only changes the status on a match; do NOT rely on your own arithmetic. Use this tool only once the customer has sent the receipt image and given you (or you've confirmed) the order number.",
        parameters: {
          type: 'object',
          properties: {
            order_number: { type: 'string', description: "The customer's order number." },
            receipt_amount: {
              type: 'number',
              description:
                'The total amount you read on the transfer receipt, as a number, with no thousands separator and a decimal point (e.g. 15400 or 15400.50).',
            },
            email: {
              type: 'string',
              description:
                "Optional. The customer's email, to verify identity when the chat's phone doesn't match the order.",
            },
          },
          required: ['order_number', 'receipt_amount'],
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const orderNumber = String(args.order_number ?? '').trim();
      const email = String(args.email ?? '').trim();
      const receiptAmount = parseAmount(args.receipt_amount as number | string);
      if (!orderNumber) return { ok: false, motivo: 'falta_numero_orden' };
      if (receiptAmount == null || receiptAmount <= 0) return { ok: false, motivo: 'monto_invalido' };

      const order = await woo.resolveOrderByNumber(orderNumber);
      if (!order) return { ok: false, motivo: 'orden_no_encontrada', numero: orderNumber };

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
          extractedAmount: receiptAmount,
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

      if (!amountsMatch(total, receiptAmount, config.PAYMENT_AMOUNT_TOLERANCE)) {
        await record('mismatch', `Monto comprobante ${receiptAmount} ≠ total ${total}.`);
        return {
          ok: false,
          motivo: 'monto_no_coincide',
          total: order.total,
          moneda: order.currency,
          receipt_amount: receiptAmount,
          diferencia: Math.round((receiptAmount - total) * 100) / 100,
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
          receipt_amount: receiptAmount,
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
