import { vi, describe, it, expect, beforeEach } from 'vitest';

const {
  resolveOrderByNumber,
  updateOrderStatus,
  getOrder,
  insertReceipt,
  setConversationEmail,
  getSettings,
  upsertSetting,
  claimReceiptReview,
  finalizeReceiptReview,
  releaseReceiptReview,
  findApprovedReceiptByHash,
  findApprovedReceiptByOrder,
  findReceiptByHash,
  findReceiptByTransactionReference,
  updateReceiptNote,
} = vi.hoisted(() => ({
  resolveOrderByNumber: vi.fn(),
  updateOrderStatus: vi.fn(),
  getOrder: vi.fn(),
  insertReceipt: vi.fn(),
  setConversationEmail: vi.fn(),
  // payments.ts resolves Woo settings through config/runtime, which imports
  // these repository methods too. Mock them explicitly rather than relying on
  // runtime.ts's noisy "DB unavailable" fallback in a unit test.
  getSettings: vi.fn(),
  upsertSetting: vi.fn(),
  claimReceiptReview: vi.fn(),
  finalizeReceiptReview: vi.fn(),
  releaseReceiptReview: vi.fn(),
  findApprovedReceiptByHash: vi.fn(),
  findApprovedReceiptByOrder: vi.fn(),
  findReceiptByHash: vi.fn(),
  findReceiptByTransactionReference: vi.fn(),
  updateReceiptNote: vi.fn(),
}));

vi.mock('../src/integrations/woocommerce', () => ({
  woo: { resolveOrderByNumber, updateOrderStatus, getOrder },
  normalizePhone: (p?: string | null) => (p ?? '').replace(/\D/g, ''),
  phoneSuffix: (p?: string | null) => (p ?? '').replace(/\D/g, '').slice(-8),
}));
vi.mock('../src/db/repo', () => ({
  insertReceipt,
  setConversationEmail,
  getSettings,
  upsertSetting,
  claimReceiptReview,
  finalizeReceiptReview,
  releaseReceiptReview,
  findApprovedReceiptByHash,
  findApprovedReceiptByOrder,
  findReceiptByHash,
  findReceiptByTransactionReference,
  updateReceiptNote,
}));

import { paymentTools } from '../src/skills/payments';
import { invalidate } from '../src/config/runtime';
import type { ToolContext } from '../src/types';

const confirmar = (args: Record<string, unknown>, ctx: ToolContext) =>
  paymentTools[0]!.handler(args, ctx) as Promise<Record<string, unknown>>;

const receiptImage: NonNullable<ToolContext['lastImage']> = {
  base64: 'cmVjZWlwdA==',
  mime: 'image/jpeg',
  mediaUrl: 'receipts/receipt.jpg',
  messageId: 'wamid.receipt',
  sha256: 'a'.repeat(64),
};

function ctxWith(
  phone: string | null,
  onReceiptConsumed = vi.fn(),
  lastImage: ToolContext['lastImage'] = receiptImage,
  signal?: AbortSignal,
): ToolContext {
  return { conversationId: 'c1', jid: 'j', phone, customerName: null, lastImage, onReceiptConsumed, signal };
}

const order = (over: Record<string, unknown> = {}) => ({
  id: 5,
  number: '1042',
  status: 'on-hold',
  total: '15400.00',
  currency: 'ARS',
  billing: { phone: '+54 9 11 1234-5678', email: 'cliente@mail.com' },
  ...over,
});

const receipt = (over: Record<string, unknown> = {}) => ({
  id: 'receipt-1',
  conversation_id: 'c1',
  message_id: receiptImage.messageId,
  account_id: 'default',
  order_number: '1042',
  woo_order_id: 5,
  media_url: receiptImage.mediaUrl,
  extracted_amount: 15400,
  woo_total: 15400,
  currency: 'ARS',
  match_status: 'match',
  review_status: 'pending',
  reviewed_by: null,
  reviewed_at: null,
  media_sha256: receiptImage.sha256,
  transaction_reference: null,
  review_attempt_id: null,
  review_target_status: null,
  note: null,
  created_at: '2026-07-10T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  resolveOrderByNumber.mockReset();
  updateOrderStatus.mockReset();
  getOrder.mockReset().mockResolvedValue(order());
  insertReceipt.mockReset().mockImplementation(async (input: Record<string, unknown>) =>
    receipt({
      conversation_id: input.conversationId,
      order_number: input.orderNumber,
      woo_order_id: input.wooOrderId,
      media_url: input.mediaUrl,
      media_sha256: input.mediaSha256,
      transaction_reference: input.transactionReference,
      match_status: input.matchStatus,
      review_status: input.reviewStatus ?? 'pending',
    }),
  );
  setConversationEmail.mockReset().mockResolvedValue(undefined);
  getSettings.mockReset().mockResolvedValue({});
  upsertSetting.mockReset().mockResolvedValue(undefined);
  claimReceiptReview.mockReset().mockResolvedValue(
    receipt({ review_status: 'processing', review_attempt_id: 'attempt-1' }),
  );
  finalizeReceiptReview.mockReset().mockResolvedValue(receipt({ review_status: 'approved' }));
  releaseReceiptReview.mockReset().mockResolvedValue(undefined);
  findApprovedReceiptByHash.mockReset().mockResolvedValue(null);
  findApprovedReceiptByOrder.mockReset().mockResolvedValue(null);
  findReceiptByHash.mockReset().mockResolvedValue(null);
  findReceiptByTransactionReference.mockReset().mockResolvedValue(null);
  updateReceiptNote.mockReset().mockResolvedValue(undefined);
  invalidate();
});

describe('confirm_payment', () => {
  it('queues a matching receipt for human review by default', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const onConsumed = vi.fn();
    const res = await confirmar({ order_number: '1042', receipt_amount: 15400 }, ctxWith('5491112345678', onConsumed));
    expect(res.ok).toBe(true);
    expect(res.confirmed).toBe(false);
    expect(res.requires_review).toBe(true);
    expect(res.receipt_id).toBe('receipt-1');
    expect(insertReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewStatus: 'pending',
        matchStatus: 'match',
        mediaSha256: receiptImage.sha256,
      }),
    );
    expect(updateOrderStatus).not.toHaveBeenCalled();
    expect(onConsumed).toHaveBeenCalled();
  });

  it('accepts EMAIL identity verification but still requires human review', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400, email: 'Cliente@Mail.com' },
      ctxWith('5499999999999'),
    );
    expect(res.ok).toBe(true);
    expect(res.identity_verified).toBe(true);
    expect(res.requires_review).toBe(true);
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('keeps the receipt in human review when auto-confirm is enabled but no transaction reference was supplied', async () => {
    getSettings.mockResolvedValue({ 'payment.auto_confirm': 'true' });
    invalidate();
    resolveOrderByNumber.mockResolvedValue(order());

    const res = await confirmar({ order_number: '1042', receipt_amount: 15400 }, ctxWith('5491112345678'));

    expect(res.ok).toBe(true);
    expect(res.confirmed).toBe(false);
    expect(res.requires_review).toBe(true);
    expect(res.auto_confirm_blocked).toBe('transaction_reference_required');
    expect(updateOrderStatus).not.toHaveBeenCalled();
    expect(claimReceiptReview).not.toHaveBeenCalled();
  });

  it('auto-confirms only after explicit opt-in and an independent transaction reference', async () => {
    getSettings.mockResolvedValue({ 'payment.auto_confirm': 'true' });
    invalidate();
    resolveOrderByNumber.mockResolvedValue(order());
    updateOrderStatus.mockResolvedValue({ status: 'processing' });

    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400, transaction_reference: 'op-123' },
      ctxWith('5491112345678'),
    );

    expect(res).toMatchObject({ ok: true, confirmed: true, status: 'processing' });
    expect(findReceiptByTransactionReference).toHaveBeenCalledWith('OP-123');
    expect(updateOrderStatus).toHaveBeenCalledWith(5, 'processing', undefined);
    expect(claimReceiptReview).toHaveBeenCalledWith('receipt-1', null, 'processing');
    expect(finalizeReceiptReview).toHaveBeenCalledWith(
      'receipt-1',
      'attempt-1',
      'approved',
      expect.stringContaining('configuración explícita'),
    );
    expect(releaseReceiptReview).not.toHaveBeenCalled();
  });

  it('does not claim a second receipt for an order whose payment is already recorded', async () => {
    getSettings.mockResolvedValue({ 'payment.auto_confirm': 'true' });
    invalidate();
    resolveOrderByNumber.mockResolvedValue(order());
    findApprovedReceiptByOrder.mockResolvedValue(receipt({ id: 'approved-for-order', review_status: 'approved' }));

    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400, transaction_reference: 'op-duplicate-order' },
      ctxWith('5491112345678'),
    );

    expect(res).toMatchObject({ ok: false, reason: 'order_payment_already_recorded' });
    expect(claimReceiptReview).not.toHaveBeenCalled();
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('revalidates the live Woo total after the claim and before mutating the order', async () => {
    getSettings.mockResolvedValue({ 'payment.auto_confirm': 'true' });
    invalidate();
    resolveOrderByNumber.mockResolvedValue(order());
    getOrder.mockResolvedValueOnce(order({ total: '20000.00' }));

    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400, transaction_reference: 'op-stale-snapshot' },
      ctxWith('5491112345678'),
    );

    expect(res).toMatchObject({ ok: false, reason: 'order_revalidation_failed' });
    expect(releaseReceiptReview).toHaveBeenCalledWith('receipt-1', 'attempt-1', expect.any(String));
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('finishes the durable receipt approval after Woo succeeds even if the turn signal expires', async () => {
    getSettings.mockResolvedValue({ 'payment.auto_confirm': 'true' });
    invalidate();
    resolveOrderByNumber.mockResolvedValue(order());
    const controller = new AbortController();
    updateOrderStatus.mockImplementationOnce(async () => {
      controller.abort(new Error('turn budget expired after Woo accepted the update'));
      return { status: 'processing' };
    });

    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400, transaction_reference: 'op-finalize-1' },
      ctxWith('5491112345678', vi.fn(), receiptImage, controller.signal),
    );

    expect(res).toMatchObject({ ok: true, confirmed: true });
    expect(finalizeReceiptReview).toHaveBeenCalledWith(
      'receipt-1',
      'attempt-1',
      'approved',
      expect.any(String),
    );
    expect(getOrder).toHaveBeenCalledWith(5, controller.signal);
  });

  it('reconciles an ambiguous Woo response before deciding whether the claim is retryable', async () => {
    getSettings.mockResolvedValue({ 'payment.auto_confirm': 'true' });
    invalidate();
    resolveOrderByNumber.mockResolvedValue(order());
    updateOrderStatus.mockRejectedValueOnce(new Error('socket closed after request write'));
    getOrder
      .mockResolvedValueOnce(order())
      .mockResolvedValueOnce(order({ status: 'processing' }));

    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400, transaction_reference: 'op-reconcile-1' },
      ctxWith('5491112345678'),
    );

    expect(res).toMatchObject({ ok: true, confirmed: true, reconciled: true, status: 'processing' });
    expect(getOrder).toHaveBeenCalledWith(5);
    expect(finalizeReceiptReview).toHaveBeenCalledWith(
      'receipt-1',
      'attempt-1',
      'approved',
      expect.stringContaining('reconciliado'),
    );
    expect(releaseReceiptReview).not.toHaveBeenCalled();
  });

  it('requires a persisted receipt image and hash', async () => {
    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400 },
      ctxWith('5491112345678', vi.fn(), null),
    );

    expect(res).toMatchObject({ ok: false, reason: 'receipt_image_required' });
    expect(resolveOrderByNumber).not.toHaveBeenCalled();
  });

  it('asks for email (reason: ask_email) when phone does not match and no email given', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar({ order_number: '1042', receipt_amount: 15400 }, ctxWith('5499999999999'));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ask_email');
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('does not accept a different international number that shares the same 8-digit suffix', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400 },
      ctxWith('34612345678'),
    );
    expect(res).toMatchObject({ ok: false, reason: 'ask_email' });
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('asks for email when the chat phone is unknown', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar({ order_number: '1042', receipt_amount: 15400 }, ctxWith(null));
    expect(res.reason).toBe('ask_email');
  });

  it('rejects (reason: identity_not_verifiable) when phone and email both wrong', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar(
      { order_number: '1042', receipt_amount: 15400, email: 'otro@mail.com' },
      ctxWith('5499999999999'),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('identity_not_verifiable');
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('does NOT reactivate a refunded order even if the amount matches', async () => {
    resolveOrderByNumber.mockResolvedValue(order({ status: 'refunded' }));
    const res = await confirmar({ order_number: '1042', receipt_amount: 15400 }, ctxWith('5491112345678'));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('order_not_confirmable');
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('rejects when the amount does not match', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    const res = await confirmar({ order_number: '1042', receipt_amount: 99999 }, ctxWith('5491112345678'));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('amount_mismatch');
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('rejects reuse of a receipt hash that was already approved', async () => {
    resolveOrderByNumber.mockResolvedValue(order());
    findApprovedReceiptByHash.mockResolvedValue({ id: 'receipt-used' });

    const res = await confirmar({ order_number: '1042', receipt_amount: 15400 }, ctxWith('5491112345678'));

    expect(res).toMatchObject({ ok: false, reason: 'receipt_already_used' });
    expect(insertReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ reviewStatus: 'rejected', matchStatus: 'mismatch' }),
    );
    expect(updateOrderStatus).not.toHaveBeenCalled();
  });

  it('reports reason: order_not_found when the order does not resolve', async () => {
    resolveOrderByNumber.mockResolvedValue(null);
    const res = await confirmar({ order_number: 'zzz', receipt_amount: 15400 }, ctxWith('5491112345678'));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('order_not_found');
  });
});
