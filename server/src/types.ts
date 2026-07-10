// Shared domain types for the server.

export type ConversationMode = 'bot' | 'human';
export type StaffRole = 'admin' | 'agent';

export interface Conversation {
  id: string;
  account_id: string;
  wa_jid: string;
  phone: string | null;
  customer_name: string | null;
  customer_email: string | null;
  mode: ConversationMode;
  assigned_to: string | null;
  status: 'open' | 'closed';
  escalation_reason: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageDirection = 'in' | 'out';
export type MessageSender = 'customer' | 'agent' | 'human' | 'system';
export type MessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'other';
export type SendStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface Message {
  id: string;
  conversation_id: string;
  account_id: string;
  direction: MessageDirection;
  sender: MessageSender;
  wa_message_id: string | null;
  msg_type: MessageType;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  send_status: SendStatus | null;
  sent_by: string | null;
  error: string | null;
  /** Stable caller-provided idempotency key for outbound messages. */
  client_id: string | null;
  send_lease_until: string | null;
  send_attempts: number;
  /** Opaque owner token for the current `sending` lease. Late workers may only
   * finalize the attempt whose token they originally claimed. */
  send_attempt_id: string | null;
  created_at: string;
}

export type ReceiptMatchStatus = 'match' | 'mismatch' | 'unreadable' | 'pending';

export interface Receipt {
  id: string;
  conversation_id: string;
  message_id: string | null;
  account_id: string;
  order_number: string | null;
  woo_order_id: number | null;
  media_url: string | null;
  extracted_amount: number | null;
  woo_total: number | null;
  currency: string | null;
  match_status: ReceiptMatchStatus;
  review_status: 'pending' | 'processing' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  media_sha256: string | null;
  transaction_reference: string | null;
  review_attempt_id: string | null;
  review_target_status: string | null;
  note: string | null;
  created_at: string;
}

/**
 * Context handed to every tool when the agent calls it. Lets tools act on behalf of
 * the current conversation/customer WITHOUT trusting the model to supply
 * sensitive values (e.g. the customer's phone is taken from here, not the LLM).
 */
export interface ToolContext {
  conversationId: string;
  jid: string;
  /** Customer phone (E.164 digits) when known, else null. */
  phone: string | null;
  customerName: string | null;
  /** Shared wall-clock budget signal for the active agent turn. Tool handlers
   * must pass it to remote calls and check it before every side effect. */
  signal?: AbortSignal;
  /** Most recent image the customer sent in this turn (for receipt reading). */
  lastImage: {
    base64: string;
    mime: string;
    mediaUrl: string | null;
    messageId: string | null;
    sha256: string;
  } | null;
  /** Called by the payment tool once a receipt is confirmed, so the router can
   * stop attaching that image to subsequent turns. */
  onReceiptConsumed?: () => void;
}

/** Result returned by a tool implementation; serialized back to the model. */
export type ToolResult = Record<string, unknown>;
