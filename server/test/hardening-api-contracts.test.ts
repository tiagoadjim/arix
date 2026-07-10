import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Conversation, Message, Receipt, StaffRole } from '../src/types';

const mocks = vi.hoisted(() => ({
  repo: {
    getStaffById: vi.fn(),
    insertAuditEvent: vi.fn(),
    getConversation: vi.fn(),
    listConversations: vi.fn(),
    getMessagePage: vi.fn(),
    prepareOutboundMessage: vi.fn(),
    claimMessageForSending: vi.fn(),
    cancelOutboundMessage: vi.fn(),
    markMessageSent: vi.fn(),
    markMessageFailed: vi.fn(),
    touchConversation: vi.fn(),
    getMessageByClientId: vi.fn(),
    getReceipt: vi.fn(),
    reviewReceipt: vi.fn(),
    claimReceiptReview: vi.fn(),
    finalizeReceiptReview: vi.fn(),
    releaseReceiptReview: vi.fn(),
    findApprovedReceiptByHash: vi.fn(),
    findApprovedReceiptByOrder: vi.fn(),
  },
  getOrder: vi.fn(),
  updateOrderStatus: vi.fn(),
  wooConfig: vi.fn(),
  recordHttp: vi.fn(),
  publishEvent: vi.fn(),
}));

vi.mock('../src/db/repo', () => mocks.repo);
vi.mock('../src/db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() },
}));
vi.mock('../src/integrations/woocommerce', () => ({
  phoneSuffix: (value?: string | null) => (value ?? '').replace(/\D/g, '').slice(-8),
  normalizePhone: (value?: string | null) => (value ?? '').replace(/\D/g, ''),
  woo: {
    getOrder: mocks.getOrder,
    updateOrderStatus: mocks.updateOrderStatus,
    findOrdersByPhone: vi.fn(),
    findOrdersByEmail: vi.fn(),
  },
}));
vi.mock('../src/config/runtime', () => ({
  woo: mocks.wooConfig,
  dispatchTemplate: vi.fn(),
  invalidate: vi.fn(),
  getResolvedWithMeta: vi.fn(),
  envLockedKeys: vi.fn(() => []),
  setupCompleted: vi.fn(),
  businessProfile: vi.fn(),
}));
vi.mock('../src/storage', () => ({ readReceiptImage: vi.fn() }));
vi.mock('../src/whatsapp/socket', () => ({
  stableWhatsAppMessageId: (clientId: string) => `WA-${clientId}`,
}));
vi.mock('../src/metrics', () => ({
  recordHttp: mocks.recordHttp,
  renderMetrics: vi.fn(() => '# metrics\n'),
}));
vi.mock('../src/events', () => ({
  publishEvent: mocks.publishEvent,
  subscribeEvents: vi.fn(() => vi.fn()),
}));
vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import { createApiServer } from '../src/api/server';
import { SESSION_COOKIE, signSession } from '../src/api/auth';
import type { WhatsAppGateway } from '../src/whatsapp/socket';

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';

const staff = (role: StaffRole) => ({
  id: role === 'admin' ? ADMIN_ID : AGENT_ID,
  email: `${role}@example.com`,
  password_hash: 'unused',
  name: role,
  role,
  session_version: 7,
});

const conversation: Conversation = {
  id: CONVERSATION_ID,
  account_id: 'default',
  wa_jid: '5491112345678@s.whatsapp.net',
  phone: '5491112345678',
  customer_name: 'Customer',
  customer_email: 'customer@example.com',
  mode: 'human',
  assigned_to: AGENT_ID,
  status: 'open',
  escalation_reason: null,
  unread_count: 0,
  last_message_at: null,
  last_message_preview: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const outbound = (
  body = 'hello',
  clientId = CLIENT_ID,
  sendStatus: Message['send_status'] = 'pending',
): Message => ({
  id: MESSAGE_ID,
  conversation_id: CONVERSATION_ID,
  account_id: 'default',
  direction: 'out',
  sender: 'human',
  wa_message_id: `WA-${clientId}`,
  msg_type: 'text',
  body,
  media_url: null,
  media_mime: null,
  send_status: sendStatus,
  sent_by: AGENT_ID,
  error: sendStatus === 'failed' ? 'network failure' : null,
  client_id: clientId,
  send_lease_until: sendStatus === 'sending' ? '2026-01-01T00:02:00Z' : null,
  send_attempts: sendStatus === 'pending' ? 0 : 1,
  send_attempt_id: sendStatus === 'sending' ? '77777777-7777-4777-8777-777777777777' : null,
  created_at: '2026-01-01T00:00:00Z',
});

const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  id: RECEIPT_ID,
  conversation_id: CONVERSATION_ID,
  message_id: MESSAGE_ID,
  account_id: 'default',
  order_number: '99',
  woo_order_id: 99,
  media_url: 'receipt.png',
  extracted_amount: 1_000,
  woo_total: 1_000,
  currency: 'ARS',
  match_status: 'match',
  review_status: 'pending',
  reviewed_by: null,
  reviewed_at: null,
  media_sha256: 'a'.repeat(64),
  transaction_reference: null,
  review_attempt_id: null,
  review_target_status: null,
  note: null,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

function gateway() {
  return {
    connected: true,
    latestQR: null,
    sendText: vi.fn().mockResolvedValue('remote-wa-id'),
    restart: vi.fn().mockResolvedValue(undefined),
    indicateTyping: vi.fn(),
  } as unknown as WhatsAppGateway;
}

async function cookie(role: StaffRole): Promise<string> {
  const token = await signSession(staff(role));
  return `${SESSION_COOKIE}=${token}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repo.getStaffById.mockImplementation(async (id: string) =>
    id === AGENT_ID ? staff('agent') : id === ADMIN_ID ? staff('admin') : null,
  );
  mocks.repo.insertAuditEvent.mockResolvedValue(undefined);
  mocks.repo.getConversation.mockResolvedValue(conversation);
  mocks.repo.listConversations.mockResolvedValue({ conversations: [conversation], nextCursor: null });
  mocks.repo.getMessagePage.mockResolvedValue({ messages: [], hasMore: false });
  mocks.repo.claimMessageForSending.mockResolvedValue(outbound('hello', CLIENT_ID, 'sending'));
  mocks.repo.cancelOutboundMessage.mockResolvedValue(undefined);
  mocks.repo.markMessageSent.mockResolvedValue(true);
  mocks.repo.markMessageFailed.mockResolvedValue(true);
  mocks.repo.touchConversation.mockResolvedValue(undefined);
  mocks.repo.getMessageByClientId.mockResolvedValue(null);
  mocks.repo.claimReceiptReview.mockResolvedValue(receipt({
    review_status: 'processing',
    reviewed_by: AGENT_ID,
    reviewed_at: '2026-01-02T00:00:00Z',
    review_attempt_id: '66666666-6666-4666-8666-666666666666',
  }));
  mocks.repo.finalizeReceiptReview.mockResolvedValue(null);
  mocks.repo.releaseReceiptReview.mockResolvedValue(undefined);
  mocks.repo.findApprovedReceiptByHash.mockResolvedValue(null);
  mocks.repo.findApprovedReceiptByOrder.mockResolvedValue(null);
  mocks.wooConfig.mockResolvedValue({
    statusAfterPayment: 'processing',
    statusAfterDispatch: '',
    currency: 'ARS',
    tolerance: 1,
  });
});

describe('API UUID and cursor validation', () => {
  it('rejects an invalid conversation path identifier before querying the repository', async () => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app)
      .get('/api/conversations/not-a-uuid')
      .set('Cookie', await cookie('agent'));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_id' });
    expect(mocks.repo.getConversation).not.toHaveBeenCalled();
  });

  it('rejects malformed or conflicting message cursors', async () => {
    const app = createApiServer({ gateway: gateway() });
    const auth = await cookie('agent');

    const malformed = await request(app)
      .get(`/api/conversations/${CONVERSATION_ID}/messages?before=not-a-uuid`)
      .set('Cookie', auth);
    const conflicting = await request(app)
      .get(
        `/api/conversations/${CONVERSATION_ID}/messages?before=${CLIENT_ID}&after=${MESSAGE_ID}`,
      )
      .set('Cookie', auth);

    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'invalid_message_cursor' });
    expect(conflicting.status).toBe(400);
    expect(conflicting.body).toEqual({ error: 'invalid_message_cursor' });
    expect(mocks.repo.getMessagePage).not.toHaveBeenCalled();
  });

  it('rejects a malformed conversation-list cursor before querying the repository', async () => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app)
      .get('/api/conversations?cursor=not-a-valid-cursor')
      .set('Cookie', await cookie('agent'));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_conversation_cursor' });
    expect(mocks.repo.listConversations).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', 'NaN'])('rejects invalid page limit %s', async (limit) => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app)
      .get(`/api/conversations/${CONVERSATION_ID}/messages?limit=${limit}`)
      .set('Cookie', await cookie('agent'));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_limit' });
    expect(mocks.repo.getMessagePage).not.toHaveBeenCalled();
  });

  it('caps valid message page limits at 200', async () => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app)
      .get(`/api/conversations/${CONVERSATION_ID}/messages?limit=9999`)
      .set('Cookie', await cookie('agent'));

    expect(response.status).toBe(200);
    expect(mocks.repo.getMessagePage).toHaveBeenCalledWith(CONVERSATION_ID, {
      beforeId: undefined,
      afterId: undefined,
      limit: 200,
    });
  });

  it('rejects an explicitly malformed idempotency key instead of silently replacing it', async () => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app)
      .post(`/api/conversations/${CONVERSATION_ID}/messages`)
      .set('Cookie', await cookie('agent'))
      .send({ body: 'hello', clientId: 'not-a-uuid' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_client_id' });
    expect(mocks.repo.prepareOutboundMessage).not.toHaveBeenCalled();
  });
});

describe('role-based access control', () => {
  it.each([
    ['get', '/api/settings'],
    ['get', '/api/staff'],
    ['get', '/api/qr'],
    ['get', '/api/audit'],
    ['get', '/api/metrics'],
    ['post', '/api/whatsapp/restart'],
  ] as const)('denies an agent: %s %s', async (method, path) => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app)[method](path).set('Cookie', await cookie('agent'));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
  });

  it('still allows an agent to use the shared inbox', async () => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app).get('/api/conversations').set('Cookie', await cookie('agent'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ conversations: [conversation], nextCursor: null });
    expect(mocks.repo.listConversations).toHaveBeenCalledWith(AGENT_ID, {
      cursor: undefined,
      limit: 100,
    });
  });
});

describe('durable and idempotent human sends', () => {
  it('persists pending -> sending -> sent around the remote send', async () => {
    const appGateway = gateway();
    const pending = outbound();
    const sent = outbound('hello', CLIENT_ID, 'sent');
    mocks.repo.prepareOutboundMessage.mockResolvedValue({ message: pending, created: true });
    mocks.repo.getMessageByClientId.mockResolvedValue(sent);
    const app = createApiServer({ gateway: appGateway });

    const response = await request(app)
      .post(`/api/conversations/${CONVERSATION_ID}/messages`)
      .set('Cookie', await cookie('agent'))
      .send({ body: 'hello', clientId: CLIENT_ID });

    expect(response.status).toBe(200);
    expect(response.body.send_status).toBe('sent');
    expect(mocks.repo.prepareOutboundMessage).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      sender: 'human',
      body: 'hello',
      clientId: CLIENT_ID,
      waMessageId: `WA-${CLIENT_ID}`,
      sentBy: AGENT_ID,
    });
    expect(mocks.repo.claimMessageForSending).toHaveBeenCalledWith(MESSAGE_ID, {
      respectBackoff: false,
    });
    expect(appGateway.sendText).toHaveBeenCalledWith(
      conversation.wa_jid,
      'hello',
      `WA-${CLIENT_ID}`,
    );
    expect(mocks.repo.markMessageSent).toHaveBeenCalledWith(
      MESSAGE_ID,
      '77777777-7777-4777-8777-777777777777',
      'remote-wa-id',
    );
    expect(mocks.repo.touchConversation).toHaveBeenCalledWith(CONVERSATION_ID, {
      preview: 'hello',
      incomingFromCustomer: false,
    });

    const preparedAt = mocks.repo.prepareOutboundMessage.mock.invocationCallOrder[0]!;
    const sendingAt = mocks.repo.claimMessageForSending.mock.invocationCallOrder[0]!;
    const remoteAt = (appGateway.sendText as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const sentAt = mocks.repo.markMessageSent.mock.invocationCallOrder[0]!;
    expect(preparedAt).toBeLessThan(sendingAt);
    expect(sendingAt).toBeLessThan(remoteAt);
    expect(remoteAt).toBeLessThan(sentAt);
  });

  it('returns an already-sent row without creating a second WhatsApp send', async () => {
    const appGateway = gateway();
    const sent = outbound('hello', CLIENT_ID, 'sent');
    mocks.repo.prepareOutboundMessage.mockResolvedValue({ message: sent, created: false });
    const app = createApiServer({ gateway: appGateway });

    const response = await request(app)
      .post(`/api/conversations/${CONVERSATION_ID}/messages`)
      .set('Cookie', await cookie('agent'))
      .send({ body: 'hello', clientId: CLIENT_ID });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(MESSAGE_ID);
    expect(appGateway.sendText).not.toHaveBeenCalled();
    expect(mocks.repo.claimMessageForSending).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different payload', async () => {
    const appGateway = gateway();
    mocks.repo.prepareOutboundMessage.mockResolvedValue({
      message: outbound('original body', CLIENT_ID, 'pending'),
      created: false,
    });
    const app = createApiServer({ gateway: appGateway });

    const response = await request(app)
      .post(`/api/conversations/${CONVERSATION_ID}/messages`)
      .set('Cookie', await cookie('agent'))
      .send({ body: 'different body', clientId: CLIENT_ID });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'idempotency_key_reused' });
    expect(appGateway.sendText).not.toHaveBeenCalled();
  });

  it('persists a failed state when the remote send fails', async () => {
    const appGateway = gateway();
    (appGateway.sendText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network failure'));
    mocks.repo.prepareOutboundMessage.mockResolvedValue({ message: outbound(), created: true });
    mocks.repo.getMessageByClientId.mockResolvedValue(outbound('hello', CLIENT_ID, 'failed'));
    const app = createApiServer({ gateway: appGateway });

    const response = await request(app)
      .post(`/api/conversations/${CONVERSATION_ID}/messages`)
      .set('Cookie', await cookie('agent'))
      .send({ body: 'hello', clientId: CLIENT_ID });

    expect(response.status).toBe(502);
    expect(response.body.send_status).toBe('failed');
    expect(mocks.repo.markMessageFailed).toHaveBeenCalledWith(
      MESSAGE_ID,
      '77777777-7777-4777-8777-777777777777',
      'network failure',
    );
    expect(mocks.repo.markMessageSent).not.toHaveBeenCalled();
  });
});

describe('manual receipt review', () => {
  it('rejects a pending receipt without touching WooCommerce', async () => {
    const pending = receipt();
    const rejected = receipt({
      review_status: 'rejected',
      reviewed_by: AGENT_ID,
      reviewed_at: '2026-01-02T00:00:00Z',
    });
    mocks.repo.getReceipt.mockResolvedValue(pending);
    mocks.repo.reviewReceipt.mockResolvedValue(rejected);
    const app = createApiServer({ gateway: gateway() });

    const response = await request(app)
      .post(`/api/receipts/${RECEIPT_ID}/review`)
      .set('Cookie', await cookie('agent'))
      .send({ decision: 'rejected', note: 'Amount is not visible' });

    expect(response.status).toBe(200);
    expect(response.body.receipt.review_status).toBe('rejected');
    expect(mocks.repo.reviewReceipt).toHaveBeenCalledWith(
      RECEIPT_ID,
      AGENT_ID,
      'rejected',
      'Amount is not visible',
    );
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(mocks.updateOrderStatus).not.toHaveBeenCalled();
  });

  it('does not approve a receipt that the analyzer did not match to an order amount', async () => {
    mocks.repo.getReceipt.mockResolvedValue(receipt({ match_status: 'mismatch' }));
    const app = createApiServer({ gateway: gateway() });

    const response = await request(app)
      .post(`/api/receipts/${RECEIPT_ID}/review`)
      .set('Cookie', await cookie('agent'))
      .send({ decision: 'approved' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'receipt_not_approvable' });
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it('prevents reuse of an already-approved receipt image hash', async () => {
    mocks.repo.getReceipt.mockResolvedValue(receipt());
    mocks.repo.findApprovedReceiptByHash.mockResolvedValue(receipt({
      id: '55555555-5555-4555-8555-555555555555',
      review_status: 'approved',
    }));
    const app = createApiServer({ gateway: gateway() });

    const response = await request(app)
      .post(`/api/receipts/${RECEIPT_ID}/review`)
      .set('Cookie', await cookie('agent'))
      .send({ decision: 'approved' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'receipt_already_used' });
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it('prevents approving a second receipt for the same WooCommerce order', async () => {
    mocks.repo.getReceipt.mockResolvedValue(receipt());
    mocks.repo.findApprovedReceiptByOrder.mockResolvedValue(receipt({
      id: '55555555-5555-4555-8555-555555555555',
      review_status: 'approved',
    }));
    const app = createApiServer({ gateway: gateway() });

    const response = await request(app)
      .post(`/api/receipts/${RECEIPT_ID}/review`)
      .set('Cookie', await cookie('agent'))
      .send({ decision: 'approved' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'order_payment_already_recorded' });
    expect(mocks.repo.claimReceiptReview).not.toHaveBeenCalled();
    expect(mocks.updateOrderStatus).not.toHaveBeenCalled();
  });

  it('checks customer ownership, updates WooCommerce, then records explicit approval', async () => {
    const pending = receipt();
    const approved = receipt({
      review_status: 'approved',
      reviewed_by: AGENT_ID,
      reviewed_at: '2026-01-02T00:00:00Z',
    });
    mocks.repo.getReceipt.mockResolvedValue(pending);
    mocks.repo.claimReceiptReview.mockResolvedValue(receipt({
      review_status: 'processing',
      reviewed_by: AGENT_ID,
      reviewed_at: '2026-01-02T00:00:00Z',
      review_attempt_id: '66666666-6666-4666-8666-666666666666',
    }));
    mocks.repo.finalizeReceiptReview.mockResolvedValue(approved);
    mocks.getOrder.mockResolvedValue({
      id: 99,
      number: '99',
      status: 'on-hold',
      currency: 'ARS',
      total: '1000.00',
      date_created: '2026-01-01T00:00:00Z',
      billing: { phone: '+54 9 11 1234-5678', email: 'customer@example.com' },
      line_items: [],
    });
    mocks.updateOrderStatus.mockResolvedValue({
      id: 99,
      number: '99',
      status: 'processing',
      currency: 'ARS',
      total: '1000.00',
      date_created: '2026-01-01T00:00:00Z',
      billing: { phone: '+54 9 11 1234-5678', email: 'customer@example.com' },
      line_items: [],
    });
    const app = createApiServer({ gateway: gateway() });

    const response = await request(app)
      .post(`/api/receipts/${RECEIPT_ID}/review`)
      .set('Cookie', await cookie('agent'))
      .send({ decision: 'approved', note: 'Verified by staff' });

    expect(response.status).toBe(200);
    expect(response.body.receipt.review_status).toBe('approved');
    expect(response.body.order.status).toBe('processing');
    expect(mocks.getOrder).toHaveBeenCalledWith(99);
    expect(mocks.updateOrderStatus).toHaveBeenCalledWith(99, 'processing');
    expect(mocks.repo.claimReceiptReview).toHaveBeenCalledWith(RECEIPT_ID, AGENT_ID, 'processing');
    expect(mocks.repo.finalizeReceiptReview).toHaveBeenCalledWith(
      RECEIPT_ID,
      '66666666-6666-4666-8666-666666666666',
      'approved',
      'Verified by staff',
    );
  });
});

describe('request hardening middleware', () => {
  it('blocks a cross-origin unsafe request before authentication', async () => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app)
      .post('/api/auth/logout')
      .set('Host', 'dashboard.example.com')
      .set('Origin', 'https://evil.example.com');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'invalid_origin' });
  });

  it('returns security headers and replaces an invalid caller request ID', async () => {
    const app = createApiServer({ gateway: gateway() });
    const response = await request(app).get('/health/live').set('X-Request-Id', '<script>');

    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
