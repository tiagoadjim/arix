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
} from '../types';

const ACCOUNT = config.WA_ACCOUNT_ID;

export interface Staff {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
}

/** Staff row safe to expose to the dashboard (no password hash). */
export interface StaffSummary {
  id: string;
  email: string;
  name: string | null;
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
  return one<Conversation>('select * from conversations where id = $1', [id]);
}

export async function listConversations(limit = 200): Promise<Conversation[]> {
  return many<Conversation>(
    `select * from conversations where account_id = $1
     order by last_message_at desc nulls last limit $2`,
    [ACCOUNT, limit],
  );
}

export async function getRecentBotConversations(limit = 100): Promise<{ id: string }[]> {
  return many<{ id: string }>(
    `select id from conversations where account_id = $1 and mode = 'bot'
     order by last_message_at desc nulls last limit $2`,
    [ACCOUNT, limit],
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
}): Promise<Message> {
  const row = await one<Message>(
    `insert into messages (conversation_id, account_id, direction, sender, msg_type, body, send_status, wa_message_id, media_url, sent_by, error)
     values ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $9, $10)
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
    ],
  );
  if (!row) throw new Error('failed to insert outbound message');
  return row;
}

export async function markMessageSent(id: string, waMessageId: string | null): Promise<void> {
  await one(`update messages set send_status = 'sent', wa_message_id = $2 where id = $1`, [
    id,
    waMessageId,
  ]);
}

export async function markMessageFailed(id: string, error: string): Promise<void> {
  await one(`update messages set send_status = 'failed', error = $2 where id = $1`, [id, error]);
}

export async function getRecentMessages(
  conversationId: string,
  limit = config.AGENT_HISTORY_LIMIT,
): Promise<Message[]> {
  const rows = await many<Message>(
    `select * from messages where conversation_id = $1 order by created_at desc limit $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

export async function getMessages(conversationId: string, limit = 500): Promise<Message[]> {
  return many<Message>(
    `select * from messages where conversation_id = $1 order by created_at asc limit $2`,
    [conversationId, limit],
  );
}

export async function getMessagesSince(conversationId: string, sinceIso: string): Promise<Message[]> {
  return many<Message>(
    `select * from messages where conversation_id = $1 and created_at > $2 order by created_at asc`,
    [conversationId, sinceIso],
  );
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
  note?: string | null;
}): Promise<Receipt> {
  const row = await one<Receipt>(
    `insert into receipts (conversation_id, message_id, account_id, order_number, woo_order_id, media_url, extracted_amount, woo_total, currency, match_status, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      input.note ?? null,
    ],
  );
  if (!row) throw new Error('failed to insert receipt');
  return row;
}

export async function getReceipts(conversationId: string): Promise<Receipt[]> {
  return many<Receipt>(
    'select * from receipts where conversation_id = $1 order by created_at desc',
    [conversationId],
  );
}

// ---- Staff (auth) -----------------------------------------------------------

export async function getStaffByEmail(email: string): Promise<Staff | null> {
  return one<Staff>('select id, email, password_hash, name from staff where lower(email) = lower($1)', [
    email,
  ]);
}

export async function getStaffById(id: string): Promise<Staff | null> {
  return one<Staff>('select id, email, password_hash, name from staff where id = $1', [id]);
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

export async function createStaff(email: string, passwordHash: string, name: string | null): Promise<Staff> {
  const row = await one<Staff>(
    `insert into staff (email, password_hash, name) values ($1, $2, $3)
     on conflict (email) do update set password_hash = excluded.password_hash, name = excluded.name
     returning id, email, password_hash, name`,
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
): Promise<Staff | null> {
  return one<Staff>(
    `insert into staff (email, password_hash, name) values ($1, $2, $3)
     on conflict (email) do nothing
     returning id, email, password_hash, name`,
    [email, passwordHash, name],
  );
}

export async function listStaff(): Promise<StaffSummary[]> {
  return many<StaffSummary>('select id, email, name, created_at from staff order by created_at asc');
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
      `insert into staff (email, password_hash, name) values ($1, $2, $3)
       returning id, email, password_hash, name`,
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
  await one('update staff set password_hash = $2 where id = $1', [id, passwordHash]);
}
