import { woo } from '../integrations/woocommerce';
import { woo as wooConfig } from '../config/runtime';
import {
  claimReceiptReview,
  finalizeReceiptReview,
  findApprovedReceiptByHash,
  findApprovedReceiptByOrder,
  findReceiptByHash,
  findReceiptByTransactionReference,
  insertReceipt,
  releaseReceiptReview,
  updateReceiptNote,
} from '../db/repo';
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

function throwIfToolAborted(ctx: ToolContext): void {
  if (!ctx.signal?.aborted) return;
  throw ctx.signal.reason instanceof Error
    ? ctx.signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function normalizeTransactionReference(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return normalized && normalized.length <= 128 && /^[A-Z0-9._/-]+$/.test(normalized) ? normalized : null;
}

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

const CONFIRMABLE_ORDER_STATUSES = new Set(['pending', 'on-hold', 'failed']);

export type ReceiptMutationReconciliation =
  | { state: 'approved'; order: Awaited<ReturnType<typeof woo.getOrder>> }
  | { state: 'released' | 'rejected' | 'uncertain' | 'superseded'; order?: Awaited<ReturnType<typeof woo.getOrder>> };

/** Reconcile an ambiguous WooCommerce status update before making the receipt
 * claim retryable. A timeout/abort can happen after Woo accepted the PUT, so
 * blindly releasing the claim would permit a second payment mutation. When
 * Woo itself cannot be read, leave the fenced `processing` row intact for the
 * periodic reconciler instead of guessing. */
export async function reconcileReceiptAfterAmbiguousOrderUpdate(input: {
  receiptId: string;
  attemptId: string;
  orderId: number;
  statusAfterPayment: string | null;
  approvedNote: string;
}): Promise<ReceiptMutationReconciliation> {
  let current: Awaited<ReturnType<typeof woo.getOrder>>;
  try {
    current = await woo.getOrder(input.orderId);
  } catch {
    await updateReceiptNote(
      input.receiptId,
      'El resultado en WooCommerce es incierto; la reconciliación automática sigue pendiente.',
    ).catch(() => {});
    return { state: 'uncertain' };
  }

  const confirmed =
    (input.statusAfterPayment !== null && current.status === input.statusAfterPayment) ||
    current.status === 'processing' ||
    current.status === 'completed';
  if (confirmed) {
    const finalized = await finalizeReceiptReview(
      input.receiptId,
      input.attemptId,
      'approved',
      input.approvedNote,
    );
    return finalized ? { state: 'approved', order: current } : { state: 'superseded', order: current };
  }

  if (CONFIRMABLE_ORDER_STATUSES.has(current.status)) {
    await releaseReceiptReview(
      input.receiptId,
      input.attemptId,
      'WooCommerce confirmó que la orden sigue sin pagar; la revisión puede reintentarse.',
    );
    return { state: 'released', order: current };
  }

  // Legacy interrupted rows may predate review_target_status. A custom Woo
  // status cannot be classified safely without that immutable target; keep the
  // claim fenced for manual reconciliation instead of falsely rejecting it.
  if (input.statusAfterPayment === null) {
    await updateReceiptNote(
      input.receiptId,
      `No se puede reconciliar automáticamente el estado ${current.status} sin el estado objetivo original.`,
    ).catch(() => {});
    return { state: 'uncertain', order: current };
  }

  const rejected = await finalizeReceiptReview(
    input.receiptId,
    input.attemptId,
    'rejected',
    `La orden cambió a un estado no confirmable durante la reconciliación: ${current.status}.`,
  );
  return rejected ? { state: 'rejected', order: current } : { state: 'superseded', order: current };
}

export const paymentTools: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'confirm_payment',
        description:
          "Validates a transfer receipt against a WooCommerce order and records the match for staff review. By default it does NOT mark the order paid; tell the customer the receipt is awaiting verification when requires_review is true. First read the amount off the receipt image and pass it as receipt_amount. The server compares it; do NOT rely on your own arithmetic. Use this tool only after the customer sent the receipt image and gave an order number.",
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
            transaction_reference: {
              type: 'string',
              description:
                'Optional bank/transfer operation reference visible on the receipt. Required for administrator-enabled auto-confirmation.',
            },
          },
          required: ['order_number', 'receipt_amount'],
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const orderNumber = String(args.order_number ?? '').trim();
      const email = String(args.email ?? '').trim();
      const transactionReference = normalizeTransactionReference(args.transaction_reference);
      // Resolved up front (it never depended on the order) so the same
      // currency-derived decimal hint applies to both amounts parsed below.
      const wc = await wooConfig();
      const decimalHint = decimalHintForCurrency(wc.currency);
      const receiptAmount = parseAmount(args.receipt_amount as number | string, decimalHint);
      if (!orderNumber) return { ok: false, reason: 'missing_order_number' };
      if (receiptAmount == null || receiptAmount <= 0) return { ok: false, reason: 'invalid_amount' };
      if (!ctx.lastImage?.mediaUrl || !ctx.lastImage.sha256) {
        return { ok: false, reason: 'receipt_image_required' };
      }

      const priorByHash = await findReceiptByHash(ctx.lastImage.sha256);
      if (priorByHash) {
        if (priorByHash.conversation_id === ctx.conversationId && priorByHash.review_status === 'pending') {
          return { ok: true, confirmed: false, requires_review: true, receipt_id: priorByHash.id };
        }
        return { ok: false, reason: 'receipt_already_used' };
      }
      if (transactionReference && (await findReceiptByTransactionReference(transactionReference))) {
        return { ok: false, reason: 'receipt_already_used' };
      }

      throwIfToolAborted(ctx);
      const order = await woo.resolveOrderByNumber(orderNumber, ctx.signal);
      if (!order) return { ok: false, reason: 'order_not_found', number: orderNumber };

      const total = parseAmount(order.total, decimalHint);
      const mediaUrl = ctx.lastImage?.mediaUrl ?? null;
      const messageId = ctx.lastImage?.messageId ?? null;
      const mediaSha256 = ctx.lastImage?.sha256 ?? null;

      const record = (
        matchStatus: ReceiptMatchStatus,
        note: string,
        reviewStatus: 'pending' | 'approved' | 'rejected' = 'pending',
      ) => {
        throwIfToolAborted(ctx);
        return insertReceipt({
          conversationId: ctx.conversationId,
          messageId,
          orderNumber: order.number,
          wooOrderId: order.id,
          mediaUrl,
          extractedAmount: receiptAmount,
          wooTotal: total,
          currency: order.currency,
          matchStatus,
          reviewStatus,
          mediaSha256,
          transactionReference,
          note,
        });
      };

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
          'rejected',
        );
        return { ok: false, reason: id.emailProvided ? 'identity_not_verifiable' : 'ask_email' };
      }
      await persistVerifiedEmail(ctx, id, email);
      throwIfToolAborted(ctx);

      // Idempotency: never "re-confirm" an order already paid/being prepared.
      if (order.status === 'processing' || order.status === 'completed') {
        ctx.onReceiptConsumed?.();
        return {
          ok: true,
          already_confirmed: true,
          // Raw WooCommerce status code — no Spanish label (see orders.ts's
          // STATUS_ES docstring).
          status: order.status,
          total: order.total,
          currency: order.currency,
        };
      }

      // State guard: only confirm from a genuine pre-payment state. Never
      // re-activate a cancelled/refunded order off a matching receipt.
      if (!CONFIRMABLE_ORDER_STATUSES.has(order.status)) {
        await record('mismatch', `Estado de orden no confirmable: ${order.status}.`, 'rejected');
        return {
          ok: false,
          reason: 'order_not_confirmable',
          status: order.status,
        };
      }

      if (total == null) {
        await record('unreadable', 'No se pudo interpretar el total de la orden.', 'rejected');
        return { ok: false, reason: 'order_total_unreadable' };
      }

      if (!amountsMatch(total, receiptAmount, wc.tolerance)) {
        await record('mismatch', `Monto comprobante ${receiptAmount} ≠ total ${total}.`, 'rejected');
        return {
          ok: false,
          reason: 'amount_mismatch',
          total: order.total,
          currency: order.currency,
          receipt_amount: receiptAmount,
          difference: Math.round((receiptAmount - total) * 100) / 100,
        };
      }

      const duplicate = mediaSha256 ? await findApprovedReceiptByHash(mediaSha256) : null;
      if (duplicate) {
        await record('mismatch', 'Comprobante reutilizado: ya fue aprobado para otra orden.', 'rejected');
        return { ok: false, reason: 'receipt_already_used' };
      }

      // A visual amount match is triage, not proof of bank settlement. Default
      // to a durable pending review and let staff approve it from the dashboard.
      const receipt = await record(
        'match',
        wc.autoConfirmPayment
          ? 'Monto e identidad coinciden; auto-confirmación habilitada por el administrador.'
          : 'Monto e identidad coinciden; pendiente de revisión humana.',
      );
      // `insertReceipt` resolves uniqueness races by returning the winning
      // durable row. Never let a loser use that row to pay a different order.
      if (
        receipt.conversation_id !== ctx.conversationId ||
        receipt.woo_order_id !== order.id ||
        (mediaSha256 && receipt.media_sha256 !== mediaSha256) ||
        (transactionReference && receipt.transaction_reference !== transactionReference)
      ) {
        return { ok: false, reason: 'receipt_already_used' };
      }
      if (!wc.autoConfirmPayment || !transactionReference) {
        ctx.onReceiptConsumed?.();
        return {
          ok: true,
          confirmed: false,
          requires_review: true,
          receipt_id: receipt.id,
          total: order.total,
          currency: order.currency,
          receipt_amount: receiptAmount,
          identity_verified: true,
          auto_confirm_blocked: wc.autoConfirmPayment && !transactionReference ? 'transaction_reference_required' : undefined,
        };
      }

      // Explicit opt-in only: amount + identity + confirmable state → mark paid.
      if (await findApprovedReceiptByOrder(order.id, receipt.id)) {
        return { ok: false, reason: 'order_payment_already_recorded' };
      }
      const claimed = await claimReceiptReview(receipt.id, null, wc.statusAfterPayment);
      const attemptId = claimed?.review_attempt_id;
      if (!claimed || !attemptId) {
        return { ok: false, reason: 'receipt_already_used' };
      }
      let currentOrder: Awaited<ReturnType<typeof woo.getOrder>>;
      try {
        throwIfToolAborted(ctx);
        currentOrder = await woo.getOrder(order.id, ctx.signal);
      } catch (err) {
        await releaseReceiptReview(
          receipt.id,
          attemptId,
          'No se pudo revalidar la orden inmediatamente antes de confirmar el pago.',
        );
        logger.error({ err, orderId: order.id }, 'failed to revalidate order before payment update');
        return { ok: false, reason: 'order_revalidation_failed' };
      }
      const currentIdentity = checkIdentity(currentOrder, ctx, email);
      const currentTotal = parseAmount(currentOrder.total, decimalHintForCurrency(currentOrder.currency || wc.currency));
      const currencyMatches =
        !currentOrder.currency || currentOrder.currency.toUpperCase() === order.currency.toUpperCase();
      if (
        !currentIdentity.verified ||
        currentTotal === null ||
        !currencyMatches ||
        !amountsMatch(currentTotal, receiptAmount, wc.tolerance)
      ) {
        await releaseReceiptReview(
          receipt.id,
          attemptId,
          'La identidad, el total o la moneda cambió antes de confirmar; se requiere revisión humana.',
        );
        return { ok: false, reason: 'order_revalidation_failed' };
      }
      if (!CONFIRMABLE_ORDER_STATUSES.has(currentOrder.status)) {
        await finalizeReceiptReview(
          receipt.id,
          attemptId,
          'rejected',
          `La orden cambió a un estado no confirmable antes de confirmar: ${currentOrder.status}.`,
        );
        return currentOrder.status === 'processing' || currentOrder.status === 'completed'
          ? { ok: true, already_confirmed: true, status: currentOrder.status }
          : { ok: false, reason: 'order_not_confirmable', status: currentOrder.status };
      }
      try {
        throwIfToolAborted(ctx);
        const updated = await woo.updateOrderStatus(currentOrder.id, wc.statusAfterPayment, ctx.signal);
        // Once Woo has acknowledged the side effect, durable finalization must
        // not be cancelled by the turn budget.
        const approved = await finalizeReceiptReview(
          receipt.id,
          attemptId,
          'approved',
          'Pago confirmado automáticamente por configuración explícita (identidad verificada).',
        );
        if (!approved) throw new Error('receipt review attempt was superseded');
        ctx.onReceiptConsumed?.();
        return {
          ok: true,
          confirmed: true,
          status: updated.status,
          total: order.total,
          currency: order.currency,
          receipt_amount: receiptAmount,
          identity_verified: true,
        };
      } catch (err) {
        const reconciliation = await reconcileReceiptAfterAmbiguousOrderUpdate({
          receiptId: receipt.id,
          attemptId,
          orderId: order.id,
          statusAfterPayment: wc.statusAfterPayment,
          approvedNote: 'Pago confirmado automáticamente y reconciliado después de una respuesta ambigua.',
        });
        if (reconciliation.state === 'approved') {
          ctx.onReceiptConsumed?.();
          return {
            ok: true,
            confirmed: true,
            reconciled: true,
            status: reconciliation.order.status,
            total: order.total,
            currency: order.currency,
            receipt_amount: receiptAmount,
            identity_verified: true,
          };
        }
        logger.error({ err, orderId: order.id }, 'failed to update order status');
        return {
          ok: false,
          reason: reconciliation.state === 'uncertain' ? 'order_update_uncertain' : 'order_update_failed',
        };
      }
    },
  },
];
