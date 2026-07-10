import { many, one, pool } from './pool';
import { config } from '../config';
import { logger } from '../logger';
import type {
  Conversation,
  ConversationMode,
  Message,
  MessageSender,
  MessageType,
  Receipt,
  ReceiptMatchStatus,
  StaffRole,
} from '../types';

const ACCOUNT = config.WA_ACCOUNT_ID;

export interface Staff {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  role: StaffRole;
  session_version: number;
}

/** Staff row safe to expose to the dashboard (no password hash). */
export interface StaffSummary {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  account_id: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  ip_hash: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ---- Conversations ----------------------------------------------------------

export async function getOrCreateConversation(input: {
  jid: string;
  phone: string | null;
  name: string | null;
}): Promise<Conversation> {
  const existing = await one<Conversation>(
    'select * from conversations where account_id = $1 and wa_jid = $2',
    [ACCOUNT, input.jid],
  );
  if (existing) {
    if ((!existing.phone && input.phone) || (!existing.customer_name && input.name)) {
      const updated = await one<Conversation>(
        `update conversations
         set phone = coalesce(phone, $2), customer_name = coalesce(customer_name, $3)
         where id = $1 returning *`,
        [existing.id, input.phone, input.name],
      );
      return updated ?? existing;
    }
    return existing;
  }

  const inserted = await one<Conversation>(
    `insert into conversations (account_id, wa_jid, phone, customer_name, mode)
     values ($1, $2, $3, $4, 'bot')
     on conflict (account_id, wa_jid) do update set wa_jid = excluded.wa_jid
     returning *`,
    [ACCOUNT, input.jid, input.phone, input.name],
  );
  if (!inserted) throw new Error('failed to create conversation');
  return inserted;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  return one<Conversation>('select * from conversations where id = $1 and account_id = $2', [id, ACCOUNT]);
}

export interface ConversationListCursor {
  at: string;
  id: string;
}

export interface ConversationListPage {
  conversations: Conversation[];
  nextCursor: ConversationListCursor | null;
}

export async function listConversations(
  staffId: string,
  opts: { cursor?: ConversationListCursor; limit?: number } = {},
): Promise<ConversationListPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200));
  const rows = await many<Conversation>(
    `select c.*,
            coalesce((
              select count(*)::int
              from messages incoming
              where incoming.conversation_id = c.id
                and incoming.direction = 'in'
                and (
                  read_cursor.id is null
                  or (incoming.created_at, incoming.id) > (read_cursor.created_at, read_cursor.id)
                )
            ), 0)::int as unread_count
     from conversations c
     left join conversation_reads reads
       on reads.conversation_id = c.id and reads.staff_id = $2
     left join messages read_cursor on read_cursor.id = reads.last_message_id
     where c.account_id = $1
       and ($3::timestamptz is null or
         (coalesce(c.last_message_at, c.created_at), c.id) < ($3::timestamptz, $4::uuid))
     order by coalesce(c.last_message_at, c.created_at) desc, c.id desc
     limit $5`,
    [ACCOUNT, staffId, opts.cursor?.at ?? null, opts.cursor?.id ?? null, limit + 1],
  );
  const conversations = rows.slice(0, limit);
  const last = conversations.at(-1);
  return {
    conversations,
    nextCursor:
      rows.length > limit && last
        ? { at: last.last_message_at ?? last.created_at, id: last.id }
        : null,
  };
}

export async function getRecentBotConversations(limit = 100): Promise<{ id: string }[]> {
  return many<{ id: string }>(
    `select id from conversations where account_id = $1 and mode = 'bot'
     order by last_message_at desc nulls last limit $2`,
    [ACCOUNT, limit],
  );
}

export async function getUnansweredBotConversations(limit = 1_000): Promise<{ id: string }[]> {
  return many<{ id: string }>(
    `select c.id
     from conversations c
     join lateral (
       select direction from messages m where m.conversation_id = c.id
         and (m.direction = 'in' or m.send_status = 'sent' or m.sender = 'system')
       order by m.created_at desc, m.id desc limit 1
     ) latest on true
     where c.account_id = $1 and c.mode = 'bot' and latest.direction = 'in'
     order by c.last_message_at asc nulls last limit $2`,
    [ACCOUNT, Math.max(1, Math.min(limit, 5_000))],
  );
}

export async function setConversationMode(
  id: string,
  mode: ConversationMode,
  opts: { escalationReason?: string | null; assignedTo?: string | null } = {},
): Promise<void> {
  if (mode === 'human') {
    await one(
      `update conversations set mode = 'human', escalation_reason = $2, assigned_to = $3 where id = $1`,
      [id, opts.escalationReason ?? null, opts.assignedTo ?? null],
    );
  } else {
    await one(
      `update conversations set mode = 'bot', escalation_reason = null, assigned_to = null,
       unread_count = 0 where id = $1`,
      [id],
    );
  }
}

export async function touchConversation(
  id: string,
  opts: { preview: string; incomingFromCustomer: boolean },
): Promise<void> {
  try {
    await one('select bump_conversation($1, $2, $3)', [id, opts.preview, opts.incomingFromCustomer]);
  } catch (err) {
    logger.error({ err, id }, 'bump_conversation failed');
  }
}

/** Mark the shared inbox badge read and persist the individual staff cursor in
 * one transaction so the UI never observes only half of the operation. */
export async function markConversationRead(conversationId: string, staffId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: conversations } = await client.query<{ id: string }>(
      `update conversations set unread_count = 0
       where id = $1 and account_id = $2 returning id`,
      [conversationId, ACCOUNT],
    );
    if (!conversations[0]) {
      await client.query('rollback');
      return false;
    }
    const { rows: latest } = await client.query<{ id: string }>(
      `select id from messages where conversation_id = $1
       order by created_at desc, id desc limit 1`,
      [conversationId],
    );
    await client.query(
      `insert into conversation_reads (conversation_id, staff_id, last_message_id, read_at)
       values ($1, $2, $3, now())
       on conflict (conversation_id, staff_id) do update
       set last_message_id = excluded.last_message_id, read_at = now()`,
      [conversationId, staffId, latest[0]?.id ?? null],
    );
    await client.query('commit');
    return true;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- Messages ---------------------------------------------------------------

export async function insertInboundMessage(input: {
  conversationId: string;
  waMessageId: string | null;
  msgType: MessageType;
  body: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
}): Promise<Message | null> {
  // Dedupe on (account_id, wa_message_id) — returns null if already processed.
  return one<Message>(
    `insert into messages (conversation_id, account_id, direction, sender, wa_message_id, msg_type, body, media_url, media_mime)
     values ($1, $2, 'in', 'customer', $3, $4, $5, $6, $7)
     on conflict (account_id, wa_message_id) where wa_message_id is not null do nothing
     returning *`,
    [
      input.conversationId,
      ACCOUNT,
      input.waMessageId,
      input.msgType,
      input.body,
      input.mediaUrl ?? null,
      input.mediaMime ?? null,
    ],
  );
}

export async function insertOutboundMessage(input: {
  conversationId: string;
  sender: MessageSender;
  body: string | null;
  msgType?: MessageType;
  sendStatus?: 'pending' | 'sending' | 'sent' | 'failed';
  waMessageId?: string | null;
  mediaUrl?: string | null;
  sentBy?: string | null;
  error?: string | null;
  clientId?: string | null;
}): Promise<Message> {
  const row = await one<Message>(
    `insert into messages (conversation_id, account_id, direction, sender, msg_type, body, send_status, wa_message_id, media_url, sent_by, error, client_id)
     values ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      input.conversationId,
      ACCOUNT,
      input.sender,
      input.msgType ?? 'text',
      input.body,
      input.sendStatus ?? 'sent',
      input.waMessageId ?? null,
      input.mediaUrl ?? null,
      input.sentBy ?? null,
      input.error ?? null,
      input.clientId ?? null,
    ],
  );
  if (!row) throw new Error('failed to insert outbound message');
  return row;
}

/** Create (or retrieve) the durable row for an outbound send. A repeated
 * clientId never creates another message; callers must verify the returned
 * payload matches before reusing it. */
export async function prepareOutboundMessage(input: {
  conversationId: string;
  sender: MessageSender;
  body: string;
  clientId: string;
  waMessageId: string;
  sentBy?: string | null;
}): Promise<{ message: Message; created: boolean }> {
  const inserted = await one<Message>(
    `insert into messages
       (conversation_id, account_id, direction, sender, msg_type, body, send_status, wa_message_id, sent_by, client_id)
     values ($1, $2, 'out', $3, 'text', $4, 'pending', $5, $6, $7)
     on conflict (account_id, client_id) where client_id is not null do nothing
     returning *`,
    [
      input.conversationId,
      ACCOUNT,
      input.sender,
      input.body,
      input.waMessageId,
      input.sentBy ?? null,
      input.clientId,
    ],
  );
  if (inserted) return { message: inserted, created: true };
  const existing = await one<Message>(
    'select * from messages where account_id = $1 and client_id = $2',
    [ACCOUNT, input.clientId],
  );
  if (!existing) throw new Error('idempotent outbound row disappeared');
  return { message: existing, created: false };
}

/** Atomically prepare every bubble for one agent turn before the first remote
 * send. A crash can then leave zero rows or the complete outbox, never a
 * prefix that recovery would mistake for the whole answer. */
export async function prepareOutboundBatch(input: {
  conversationId: string;
  sender: MessageSender;
  messages: Array<{ body: string; clientId: string; waMessageId: string }>;
  sentBy?: string | null;
}): Promise<Message[]> {
  if (input.messages.length === 0) return [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    const rows: Message[] = [];
    for (const item of input.messages) {
      const inserted = await client.query<Message>(
        `insert into messages
           (conversation_id, account_id, direction, sender, msg_type, body,
            send_status, wa_message_id, sent_by, client_id)
         values ($1, $2, 'out', $3, 'text', $4, 'pending', $5, $6, $7)
         on conflict (account_id, client_id) where client_id is not null do nothing
         returning *`,
        [
          input.conversationId,
          ACCOUNT,
          input.sender,
          item.body,
          item.waMessageId,
          input.sentBy ?? null,
          item.clientId,
        ],
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<Message>(
          'select * from messages where account_id = $1 and client_id = $2',
          [ACCOUNT, item.clientId],
        );
        row = existing.rows[0];
      }
      if (!row) throw new Error('idempotent outbound batch row disappeared');
      rows.push(row);
    }
    await client.query('commit');
    return rows;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getMessageByClientId(clientId: string): Promise<Message | null> {
  return one<Message>('select * from messages where account_id = $1 and client_id = $2', [ACCOUNT, clientId]);
}

export async function markMessageSent(id: string, attemptId: string, waMessageId: string | null): Promise<boolean> {
  const updated = await one<{ id: string }>(
    `update messages set send_status = 'sent', wa_message_id = coalesce($3, wa_message_id),
       error = null, send_lease_until = null, send_attempt_id = null
     where id = $1 and account_id = $4 and send_status = 'sending'
       and send_attempt_id = $2
     returning id`,
    [id, attemptId, waMessageId, ACCOUNT],
  );
  return Boolean(updated);
}

export async function markMessageFailed(id: string, attemptId: string, error: string): Promise<boolean> {
  const updated = await one<{ id: string }>(
    `update messages set send_status = 'failed', error = $2,
       send_lease_until = now() + (least(300, power(2, least(send_attempts, 8))) * interval '1 second'),
       send_attempt_id = null
     where id = $1 and account_id = $4 and send_status = 'sending'
       and send_attempt_id = $3
     returning id`,
    [id, error, attemptId, ACCOUNT],
  );
  return Boolean(updated);
}

export async function claimMessageForSending(
  id: string,
  opts: { respectBackoff?: boolean; leaseSeconds?: number } = {},
): Promise<Message | null> {
  const respectBackoff = opts.respectBackoff ?? true;
  const leaseSeconds = Math.max(10, Math.min(opts.leaseSeconds ?? 120, 600));
  return one<Message>(
    `update messages set send_status = 'sending', error = null,
       send_attempts = send_attempts + 1,
       send_lease_until = now() + ($3::int * interval '1 second'),
       send_attempt_id = gen_random_uuid()
     where id = $1 and account_id = $2 and (
       send_status = 'pending'
       or (send_status = 'failed' and ($4::boolean = false or send_lease_until is null or send_lease_until <= now()))
       or (send_status = 'sending' and (send_lease_until is null or send_lease_until <= now()))
     ) returning *`,
    [id, ACCOUNT, leaseSeconds, respectBackoff],
  );
}

export async function cancelOutboundMessage(id: string, reason: string): Promise<void> {
  await one(
    `update messages set send_status = 'cancelled', error = $2,
       send_lease_until = null, send_attempt_id = null
     where id = $1 and account_id = $3 and send_status <> 'sent'`,
    [id, reason.slice(0, 500), ACCOUNT],
  );
}

export async function cancelAgentOutboxForTurn(
  conversationId: string,
  turnCursor: string,
  reason: string,
): Promise<void> {
  const prefix = `agent:${conversationId}:${turnCursor}:`;
  await one(
    `update messages set send_status = 'cancelled', error = $4,
       send_lease_until = null, send_attempt_id = null
     where account_id = $1 and conversation_id = $2 and client_id like $3
       and send_status <> 'sent'`,
    [ACCOUNT, conversationId, `${prefix}%`, reason.slice(0, 500)],
  );
}

export async function getAgentOutboxForTurn(conversationId: string, turnCursor: string): Promise<Message[]> {
  const prefix = `agent:${conversationId}:${turnCursor}:`;
  return many<Message>(
    `select * from messages where account_id = $1 and conversation_id = $2
       and client_id like $3 and send_status <> 'cancelled'
     order by created_at asc, id asc`,
    [ACCOUNT, conversationId, `${prefix}%`],
  );
}

export interface RecoverableOutbound extends Message {
  wa_jid: string;
}

/** Candidate rows used only to discover incomplete durable agent batches. The
 * router reloads the complete turn (including already-sent earlier bubbles)
 * before transporting anything, so a later pending row can never jump an
 * earlier in-flight row. */
export async function getRecoverableAgentOutbox(limit = 100): Promise<RecoverableOutbound[]> {
  return many<RecoverableOutbound>(
    `select m.*, c.wa_jid from messages m
     join conversations c on c.id = m.conversation_id and c.account_id = m.account_id
     where m.account_id = $1 and m.direction = 'out' and m.sender = 'agent'
       and m.client_id like 'agent:%'
       and (
         m.send_status = 'pending'
         or (m.send_status in ('sending','failed') and (m.send_lease_until is null or m.send_lease_until <= now()))
       )
     order by m.created_at asc, m.id asc limit $2`,
    [ACCOUNT, Math.max(1, Math.min(limit, 500))],
  );
}

/** A durable agent batch is resumable only while its customer inbound remains
 * the newest relevant turn. Sent bubbles from the same batch are allowed;
 * newer customer/system activity or another sender's reply makes the unsent
 * suffix stale and it must be cancelled instead. */
export async function isAgentOutboxTurnCurrent(
  conversationId: string,
  turnCursor: string,
): Promise<boolean> {
  const prefix = `agent:${conversationId}:${turnCursor}:`;
  const row = await one<{ current: boolean }>(
    `select exists (
       select 1 from messages cursor
       where cursor.id = $2 and cursor.conversation_id = $1 and cursor.direction = 'in'
         and not exists (
           select 1 from messages newer
           where newer.conversation_id = $1
             and (newer.created_at, newer.id) > (cursor.created_at, cursor.id)
             and (
               newer.direction = 'in'
               or newer.sender = 'system'
               or (
                 newer.direction = 'out' and newer.send_status = 'sent'
                 and (newer.client_id is null or newer.client_id not like $3)
               )
             )
         )
     ) as current`,
    [conversationId, turnCursor, `${prefix}%`],
  );
  return row?.current === true;
}

export async function getRecoverableHumanOutbox(limit = 100): Promise<RecoverableOutbound[]> {
  return many<RecoverableOutbound>(
    `select m.*, c.wa_jid from messages m
     join conversations c on c.id = m.conversation_id and c.account_id = m.account_id
     where m.account_id = $1 and m.direction = 'out' and m.sender = 'human'
       and (
         m.send_status = 'pending'
         or (m.send_status in ('sending','failed') and (m.send_lease_until is null or m.send_lease_until <= now()))
       )
     order by m.created_at asc limit $2`,
    [ACCOUNT, Math.max(1, Math.min(limit, 500))],
  );
}

export async function getRecentMessages(
  conversationId: string,
  limit = config.AGENT_HISTORY_LIMIT,
): Promise<Message[]> {
  const rows = await many<Message>(
    `select * from messages where conversation_id = $1
       and (direction = 'in' or send_status = 'sent' or sender = 'system')
     order by created_at desc, id desc limit $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

export async function getMessages(conversationId: string, limit = 100): Promise<Message[]> {
  const rows = await many<Message>(
    `select * from messages where conversation_id = $1
     order by created_at desc, id desc limit $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

export async function getMessagesSince(conversationId: string, sinceIso: string): Promise<Message[]> {
  return many<Message>(
    `select * from messages where conversation_id = $1 and created_at > $2 order by created_at asc`,
    [conversationId, sinceIso],
  );
}

export interface MessagePage {
  messages: Message[];
  hasMore: boolean;
}

/** Stable keyset pagination. `beforeId` and `afterId` must belong to the same
 * conversation; an invalid/foreign cursor returns an empty page. */
export async function getMessagePage(
  conversationId: string,
  opts: { beforeId?: string; afterId?: string; limit?: number } = {},
): Promise<MessagePage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200));
  const take = limit + 1;
  if (opts.beforeId && opts.afterId) return { messages: [], hasMore: false };

  if (opts.afterId) {
    const rows = await many<Message>(
      `select m.* from messages m
       join messages cursor on cursor.id = $2 and cursor.conversation_id = $1
       where m.conversation_id = $1
         and (m.created_at, m.id) > (cursor.created_at, cursor.id)
       order by m.created_at asc, m.id asc limit $3`,
      [conversationId, opts.afterId, take],
    );
    return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  if (opts.beforeId) {
    const rows = await many<Message>(
      `select m.* from messages m
       join messages cursor on cursor.id = $2 and cursor.conversation_id = $1
       where m.conversation_id = $1
         and (m.created_at, m.id) < (cursor.created_at, cursor.id)
       order by m.created_at desc, m.id desc limit $3`,
      [conversationId, opts.beforeId, take],
    );
    return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
  }

  const rows = await many<Message>(
    `select * from messages where conversation_id = $1
     order by created_at desc, id desc limit $2`,
    [conversationId, take],
  );
  return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

// ---- Receipts ---------------------------------------------------------------

export async function insertReceipt(input: {
  conversationId: string;
  messageId?: string | null;
  orderNumber?: string | null;
  wooOrderId?: number | null;
  mediaUrl?: string | null;
  extractedAmount?: number | null;
  wooTotal?: number | null;
  currency?: string | null;
  matchStatus: ReceiptMatchStatus;
  reviewStatus?: 'pending' | 'approved' | 'rejected';
  mediaSha256?: string | null;
  transactionReference?: string | null;
  note?: string | null;
}): Promise<Receipt> {
  const row = await one<Receipt>(
    `insert into receipts
       (conversation_id, message_id, account_id, order_number, woo_order_id, media_url,
        extracted_amount, woo_total, currency, match_status, review_status,
        media_sha256, transaction_reference, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict do nothing
     returning *`,
    [
      input.conversationId,
      input.messageId ?? null,
      ACCOUNT,
      input.orderNumber ?? null,
      input.wooOrderId ?? null,
      input.mediaUrl ?? null,
      input.extractedAmount ?? null,
      input.wooTotal ?? null,
      input.currency ?? null,
      input.matchStatus,
      input.reviewStatus ?? 'pending',
      input.mediaSha256 ?? null,
      input.transactionReference ?? null,
      input.note ?? null,
    ],
  );
  if (!row && input.mediaSha256) {
    const existing = await one<Receipt>(
      'select * from receipts where account_id = $1 and media_sha256 = $2',
      [ACCOUNT, input.mediaSha256],
    );
    if (existing) return existing;
  }
  if (!row && input.transactionReference) {
    const existing = await one<Receipt>(
      'select * from receipts where account_id = $1 and transaction_reference = $2',
      [ACCOUNT, input.transactionReference],
    );
    if (existing) return existing;
  }
  if (!row) throw new Error('failed to insert receipt');
  return row;
}

export async function getReceipts(conversationId: string): Promise<Receipt[]> {
  return many<Receipt>(
    'select * from receipts where conversation_id = $1 order by created_at desc',
    [conversationId],
  );
}

export async function getReceipt(id: string): Promise<Receipt | null> {
  return one<Receipt>('select * from receipts where id = $1 and account_id = $2', [id, ACCOUNT]);
}

export async function findApprovedReceiptByHash(hash: string, excludeId?: string): Promise<Receipt | null> {
  return one<Receipt>(
    `select * from receipts
     where account_id = $1 and media_sha256 = $2 and review_status = 'approved'
       and ($3::uuid is null or id <> $3::uuid)
     order by reviewed_at desc nulls last limit 1`,
    [ACCOUNT, hash, excludeId ?? null],
  );
}

export async function findApprovedReceiptByOrder(orderId: number, excludeId?: string): Promise<Receipt | null> {
  return one<Receipt>(
    `select * from receipts
     where account_id = $1 and woo_order_id = $2 and review_status = 'approved'
       and ($3::uuid is null or id <> $3::uuid)
     order by reviewed_at asc nulls last, created_at asc limit 1`,
    [ACCOUNT, orderId, excludeId ?? null],
  );
}

export async function findReceiptByHash(hash: string): Promise<Receipt | null> {
  return one<Receipt>(
    'select * from receipts where account_id = $1 and media_sha256 = $2 order by created_at asc limit 1',
    [ACCOUNT, hash],
  );
}

export async function findReceiptByTransactionReference(reference: string): Promise<Receipt | null> {
  return one<Receipt>(
    'select * from receipts where account_id = $1 and transaction_reference = $2 order by created_at asc limit 1',
    [ACCOUNT, reference],
  );
}

/** Claim approval before any external order mutation. Approve/reject races are
 * resolved by the pending predicate; attemptId fences stale completions. */
export async function claimReceiptReview(
  id: string,
  reviewerId: string | null,
  targetStatus: string,
): Promise<Receipt | null> {
  try {
    return await one<Receipt>(
      `update receipts set review_status = 'processing', reviewed_by = $2,
         reviewed_at = now(), review_attempt_id = gen_random_uuid(), review_target_status = $4
       where id = $1 and account_id = $3 and review_status = 'pending'
         and woo_order_id is not null
         and not exists (
           select 1 from receipts active
           where active.account_id = receipts.account_id
             and active.woo_order_id = receipts.woo_order_id
             and active.id <> receipts.id
             and active.review_status in ('processing', 'approved')
         )
       returning *`,
      [id, reviewerId, ACCOUNT, targetStatus],
    );
  } catch (err) {
    // The partial unique index closes the race between the NOT EXISTS check
    // and concurrent claims for a different receipt on the same order.
    if ((err as { code?: string } | null)?.code === '23505') return null;
    throw err;
  }
}

export async function finalizeReceiptReview(
  id: string,
  attemptId: string,
  decision: 'approved' | 'rejected',
  note?: string | null,
): Promise<Receipt | null> {
  return one<Receipt>(
    `update receipts set review_status = $3, reviewed_at = now(),
       note = coalesce($4, note), review_attempt_id = null
     where id = $1 and account_id = $5 and review_status = 'processing'
       and review_attempt_id = $2
     returning *`,
    [id, attemptId, decision, note ?? null, ACCOUNT],
  );
}

export async function releaseReceiptReview(id: string, attemptId: string, note?: string | null): Promise<void> {
  await one(
    `update receipts set review_status = 'pending', reviewed_by = null,
       reviewed_at = null, review_attempt_id = null, review_target_status = null,
       note = coalesce($3, note)
     where id = $1 and account_id = $4 and review_status = 'processing'
       and review_attempt_id = $2`,
    [id, attemptId, note ?? null, ACCOUNT],
  );
}

/** Return fenced reviews old enough that their WooCommerce side effect may
 * have completed before a crash/timeout. Callers must reconcile the order
 * state before either finalizing or releasing the claim. */
export async function listStaleReceiptReviews(maxAgeMinutes = 10, limit = 100): Promise<Receipt[]> {
  return many<Receipt>(
    `select * from receipts
     where account_id = $1 and review_status = 'processing'
       and review_attempt_id is not null
       and reviewed_at < now() - ($2::int * interval '1 minute')
     order by reviewed_at asc limit $3`,
    [
      ACCOUNT,
      Math.max(1, Math.min(maxAgeMinutes, 1_440)),
      Math.max(1, Math.min(limit, 1_000)),
    ],
  );
}

/** Atomically claim a still-pending receipt review. Only one concurrent
 * reviewer can transition it out of pending. */
export async function reviewReceipt(
  id: string,
  reviewerId: string,
  decision: 'approved' | 'rejected',
  note?: string | null,
): Promise<Receipt | null> {
  return one<Receipt>(
    `update receipts set review_status = $3, reviewed_by = $2, reviewed_at = now(),
       note = coalesce($4, note)
     where id = $1 and account_id = $5 and review_status = 'pending'
     returning *`,
    [id, reviewerId, decision, note ?? null, ACCOUNT],
  );
}

export async function updateReceiptNote(id: string, note: string): Promise<void> {
  await one('update receipts set note = $2 where id = $1 and account_id = $3', [id, note, ACCOUNT]);
}

export async function listReceiptMediaMissingHashes(limit = 10_000): Promise<Array<{ id: string; media_url: string }>> {
  return many<{ id: string; media_url: string }>(
    `select id, media_url from receipts
     where account_id = $1 and media_sha256 is null and media_url is not null
     order by created_at asc limit $2`,
    [ACCOUNT, Math.max(1, Math.min(limit, 50_000))],
  );
}

export async function setReceiptMediaHash(id: string, hash: string): Promise<void> {
  await one(
    'update receipts set media_sha256 = $2 where id = $1 and account_id = $3 and media_sha256 is null',
    [id, hash, ACCOUNT],
  );
}

// ---- Staff (auth) -----------------------------------------------------------

export async function getStaffByEmail(email: string): Promise<Staff | null> {
  return one<Staff>(
    `select id, email, password_hash, name, role, session_version
     from staff where lower(email) = lower($1)`,
    [email],
  );
}

export async function getStaffById(id: string): Promise<Staff | null> {
  return one<Staff>(
    'select id, email, password_hash, name, role, session_version from staff where id = $1',
    [id],
  );
}

export async function setConversationEmail(id: string, email: string): Promise<void> {
  await one('update conversations set customer_email = $2 where id = $1 and customer_email is distinct from $2', [
    id,
    email,
  ]);
}

// ---- Settings (store info: payment methods, shipping, …) --------------------

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await many<{ key: string; value: string }>('select key, value from settings');
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function upsertSetting(key: string, value: string): Promise<void> {
  await one(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

export async function upsertSettings(entries: Array<{ key: string; value: string }>): Promise<void> {
  if (entries.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const entry of entries) {
      await client.query(
        `insert into settings (key, value, updated_at) values ($1, $2, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [entry.key, entry.value],
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function createStaff(email: string, passwordHash: string, name: string | null): Promise<Staff> {
  const row = await one<Staff>(
    `insert into staff (email, password_hash, name, role) values ($1, $2, $3, 'admin')
     on conflict (email) do update set password_hash = excluded.password_hash, name = excluded.name,
       session_version = staff.session_version + 1
     returning id, email, password_hash, name, role, session_version`,
    [email, passwordHash, name],
  );
  if (!row) throw new Error('failed to create staff');
  return row;
}

/**
 * Strict variant of {@link createStaff} for POST /api/staff: `DO NOTHING`
 * instead of `DO UPDATE`, so a duplicate email never silently overwrites an
 * existing account's password/name — returns null when the row already
 * existed (atomic, race-safe unlike a pre-check + insert), letting the
 * caller answer 409. `createStaff`'s upsert semantics are kept as-is for the
 * break-glass CLI, which intentionally resets a known account.
 */
export async function createStaffStrict(
  email: string,
  passwordHash: string,
  name: string | null,
  role: StaffRole = 'agent',
): Promise<Staff | null> {
  return one<Staff>(
    `insert into staff (email, password_hash, name, role) values ($1, $2, $3, $4)
     on conflict (email) do nothing
     returning id, email, password_hash, name, role, session_version`,
    [email, passwordHash, name, role],
  );
}

export async function listStaff(): Promise<StaffSummary[]> {
  return many<StaffSummary>('select id, email, name, role, created_at from staff order by created_at asc');
}

/**
 * One-shot bootstrap for the setup wizard: create the very first admin, but
 * ONLY if the staff table is still empty — returns null (never throws) when
 * it isn't, so the caller (POST /api/setup/admin) can answer 409 either way,
 * whether staff already existed or a concurrent request won the race.
 *
 * Race safety: wrapped in a SERIALIZABLE transaction around a plain
 * check-then-insert. Postgres's default READ COMMITTED isolation would let
 * two concurrent "table is empty" checks both succeed before either commits
 * (an INSERT ... WHERE NOT EXISTS alone does not prevent this — it only
 * guards against re-reading the SAME already-committed row). SERIALIZABLE
 * makes Postgres abort one of the two transactions with a 40001
 * serialization_failure instead, which we treat exactly like "staff already
 * exists" rather than a 500.
 */
export async function createFirstAdmin(
  email: string,
  passwordHash: string,
  name: string | null,
): Promise<Staff | null> {
  const client = await pool.connect();
  try {
    await client.query('begin isolation level serializable');
    const { rows: existing } = await client.query('select 1 from staff limit 1');
    if (existing.length > 0) {
      await client.query('rollback');
      return null;
    }
    const { rows } = await client.query<Staff>(
      `insert into staff (email, password_hash, name, role) values ($1, $2, $3, 'admin')
       returning id, email, password_hash, name, role, session_version`,
      [email, passwordHash, name],
    );
    await client.query('commit');
    return rows[0] ?? null;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    if ((err as { code?: string } | null)?.code === '40001') return null; // lost the race
    throw err;
  } finally {
    client.release();
  }
}

export async function countStaff(): Promise<number> {
  const row = await one<{ count: number }>('select count(*)::int as count from staff');
  return row?.count ?? 0;
}

export async function deleteStaff(id: string): Promise<void> {
  await one('delete from staff where id = $1', [id]);
}

export async function updateStaffPassword(id: string, passwordHash: string): Promise<void> {
  await one(
    'update staff set password_hash = $2, session_version = session_version + 1 where id = $1',
    [id, passwordHash],
  );
}

export async function updateStaffRole(id: string, role: StaffRole): Promise<StaffSummary | null> {
  return one<StaffSummary>(
    `update staff set role = $2, session_version = session_version + 1
     where id = $1 returning id, email, name, role, created_at`,
    [id, role],
  );
}

export type UpdateStaffRoleResult =
  | { status: 'updated'; staff: StaffSummary }
  | { status: 'not_found' | 'last_admin' };

export async function updateStaffRoleSafely(id: string, role: StaffRole): Promise<UpdateStaffRoleResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtext('arix:staff-admins'))");
    const { rows } = await client.query<{ id: string; role: StaffRole }>(
      'select id, role from staff where id = $1 for update',
      [id],
    );
    const current = rows[0];
    if (!current) {
      await client.query('rollback');
      return { status: 'not_found' };
    }
    if (current.role === 'admin' && role !== 'admin') {
      const { rows: counts } = await client.query<{ count: number }>(
        "select count(*)::int as count from staff where role = 'admin'",
      );
      if ((counts[0]?.count ?? 0) <= 1) {
        await client.query('rollback');
        return { status: 'last_admin' };
      }
    }
    const { rows: updated } = await client.query<StaffSummary>(
      `update staff set role = $2, session_version = session_version + 1
       where id = $1 returning id, email, name, role, created_at`,
      [id, role],
    );
    await client.query('commit');
    return { status: 'updated', staff: updated[0]! };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type DeleteStaffResult = 'deleted' | 'not_found' | 'self' | 'last_admin';

/** Serialize role-sensitive deletion so two admins cannot concurrently remove
 * each other and leave the deployment without an administrator. */
export async function deleteStaffSafely(actorId: string, targetId: string): Promise<DeleteStaffResult> {
  if (actorId === targetId) return 'self';
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtext('arix:staff-admins'))");
    const { rows } = await client.query<{ id: string; role: StaffRole }>(
      'select id, role from staff where id = $1 for update',
      [targetId],
    );
    const target = rows[0];
    if (!target) {
      await client.query('rollback');
      return 'not_found';
    }
    if (target.role === 'admin') {
      const { rows: counts } = await client.query<{ count: number }>(
        "select count(*)::int as count from staff where role = 'admin'",
      );
      if ((counts[0]?.count ?? 0) <= 1) {
        await client.query('rollback');
        return 'last_admin';
      }
    }
    await client.query('delete from staff where id = $1', [targetId]);
    await client.query('commit');
    return 'deleted';
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- Audit + analytics -------------------------------------------------------

export async function insertAuditEvent(input: {
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  ipHash?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await one(
    `insert into audit_events
       (account_id, actor_id, action, target_type, target_id, request_id, ip_hash, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      ACCOUNT,
      input.actorId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.requestId ?? null,
      input.ipHash ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function listAuditEvents(limit = 100): Promise<AuditEvent[]> {
  return many<AuditEvent>(
    `select * from audit_events where account_id = $1
     order by created_at desc limit $2`,
    [ACCOUNT, Math.max(1, Math.min(limit, 500))],
  );
}

export async function insertLlmUsage(input: {
  conversationId?: string | null;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number | null;
}): Promise<void> {
  await one(
    `insert into llm_usage
       (account_id, conversation_id, provider, model, prompt_tokens,
        completion_tokens, total_tokens, estimated_cost_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ACCOUNT,
      input.conversationId ?? null,
      input.provider,
      input.model,
      Math.max(0, Math.trunc(input.promptTokens)),
      Math.max(0, Math.trunc(input.completionTokens)),
      Math.max(0, Math.trunc(input.totalTokens)),
      input.estimatedCostUsd ?? null,
    ],
  );
}

export interface UsageSummaryRow {
  day: string;
  provider: string;
  model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

export async function getLlmUsageSummary(days = 30): Promise<UsageSummaryRow[]> {
  return many<UsageSummaryRow>(
    `select date_trunc('day', created_at)::date::text as day, provider, model,
            count(*)::int as requests,
            sum(prompt_tokens)::int as prompt_tokens,
            sum(completion_tokens)::int as completion_tokens,
            sum(total_tokens)::int as total_tokens,
            coalesce(sum(estimated_cost_usd), 0)::float8 as estimated_cost_usd
     from llm_usage
     where account_id = $1 and created_at >= now() - ($2::int * interval '1 day')
     group by 1, 2, 3 order by 1 asc, 2 asc, 3 asc`,
    [ACCOUNT, Math.max(1, Math.min(days, 365))],
  );
}
