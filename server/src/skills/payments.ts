import { woo } from '../integrations/woocommerce';
import { woo as wooConfig } from '../config/runtime';
import { insertReceipt } from '../db/repo';
import { logger } from '../logger';
import { checkIdentity, persistVerifiedEmail } from './orders';
import type { ToolSpec } from '../agent/tool-spec';
import type { ReceiptMatchStatus, ToolContext } from '../types';

/** Which character a currency conventionally uses as the DECIMAL separator —
 * 'comma' for ARS/EUR-style formatting ("1.234,56"), 'dot' for USD-style
 * ("1,234.56"). Only ever consulted to break a genuine tie (see parseAmount). */
export type DecimalSeparatorHint = 'comma' | 'dot';

// Currencies that conventionally write the decimal separator as ',' (and use
// '.' for thousands) — the reverse of USD-style formatting. Extend as needed;
// this only affects the ambiguous 3-trailing-digit case in parseAmount.
const COMMA_DECIMAL_CURRENCIES = new Set(['ARS', 'EUR', 'BRL', 'CLP', 'UYU', 'PYG', 'COP']);

/** Decimal-separator hint for a store's currency (e.g. wc.currency). */
export function decimalHintForCurrency(currency: string): DecimalSeparatorHint {
  return COMMA_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase()) ? 'comma' : 'dot';
}

/**
 * Normalize an amount that may arrive as a number or a localized string
 * ("1.234,56", "1,234.56", "$ 1234"). Returns a float or null.
 *
 * `decimalHint` only breaks the tie for a genuinely ambiguous input: a LONE
 * separator (dot or comma, not both) followed by exactly 3 digits, e.g.
 * "1.234" — is that thousands-grouped 1234, or a literal 1.234? Every other
 * shape (2 trailing digits, both separators present, etc.) is unambiguous
 * already and completely unaffected by the hint. Omitting the hint keeps the
 * pre-existing (AR-leaning) behavior exactly as before. Pure + exported for
 * unit testing.
 */
export function parseAmount(
  input: number | string | null | undefined,
  decimalHint?: DecimalSeparatorHint,
): number | null {
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
    const ambiguous = parts.length === 2 && (parts[1]?.length ?? 0) === 3;
    s =
      ambiguous && decimalHint === 'comma'
        ? `${parts[0]}.${parts[1]}`
        : parts.length === 2 && (parts[1]?.length ?? 0) <= 2
          ? `${parts[0]}.${parts[1]}`
          : parts.join('');
  } else if (hasDot) {
    const parts = s.split('.');
    const ambiguous = parts.length === 2 && (parts[1]?.length ?? 0) === 3;
    s =
      ambiguous && decimalHint === 'dot'
        ? `${parts[0]}.${parts[1]}`
        : parts.length === 2 && (parts[1]?.length ?? 0) <= 2
          ? `${parts[0]}.${parts[1]}`
          : parts.join('');
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
      // Resolved up front (it never depended on the order) so the same
      // currency-derived decimal hint applies to both amounts parsed below.
      const wc = await wooConfig();
      const decimalHint = decimalHintForCurrency(wc.currency);
      const receiptAmount = parseAmount(args.receipt_amount as number | string, decimalHint);
      if (!orderNumber) return { ok: false, reason: 'missing_order_number' };
      if (receiptAmount == null || receiptAmount <= 0) return { ok: false, reason: 'invalid_amount' };

      const order = await woo.resolveOrderByNumber(orderNumber);
      if (!order) return { ok: false, reason: 'order_not_found', numero: orderNumber };

      const total = parseAmount(order.total, decimalHint);
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
        return { ok: false, reason: id.emailProvided ? 'identity_not_verifiable' : 'ask_email' };
      }
      await persistVerifiedEmail(ctx, id, email);

      // Idempotency: never "re-confirm" an order already paid/being prepared.
      if (order.status === 'processing' || order.status === 'completed') {
        ctx.onReceiptConsumed?.();
        return {
          ok: true,
          ya_confirmada: true,
          // Raw WooCommerce status code — no Spanish label (see orders.ts's
          // STATUS_ES docstring).
          estado: order.status,
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
          reason: 'order_not_confirmable',
          estado: order.status,
        };
      }

      if (total == null) {
        await record('unreadable', 'No se pudo interpretar el total de la orden.');
        return { ok: false, reason: 'order_total_unreadable' };
      }

      if (!amountsMatch(total, receiptAmount, wc.tolerance)) {
        await record('mismatch', `Monto comprobante ${receiptAmount} ≠ total ${total}.`);
        return {
          ok: false,
          reason: 'amount_mismatch',
          total: order.total,
          moneda: order.currency,
          receipt_amount: receiptAmount,
          diferencia: Math.round((receiptAmount - total) * 100) / 100,
        };
      }

      // Amounts match + identity verified + confirmable state → mark as paid.
      try {
        const updated = await woo.updateOrderStatus(order.id, wc.statusAfterPayment);
        await record('match', 'Pago confirmado automáticamente (identidad verificada).');
        ctx.onReceiptConsumed?.();
        return {
          ok: true,
          confirmada: true,
          estado: updated.status,
          total: order.total,
          moneda: order.currency,
          receipt_amount: receiptAmount,
          identidad_verificada: true,
        };
      } catch (err) {
        await record('match', 'Monto coincide pero falló el cambio de estado en WooCommerce.');
        logger.error({ err, orderId: order.id }, 'failed to update order status');
        return { ok: false, reason: 'order_update_failed' };
      }
    },
  },
];
