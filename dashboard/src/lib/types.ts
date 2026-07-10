// DB row shapes (mirror of the server types / SQL schema).

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

export interface Message {
  id: string;
  conversation_id: string;
  account_id: string;
  direction: 'in' | 'out';
  sender: 'customer' | 'agent' | 'human' | 'system';
  wa_message_id: string | null;
  msg_type: string;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  send_status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | null;
  sent_by: string | null;
  error: string | null;
  client_id: string | null;
  send_lease_until: string | null;
  send_attempts: number;
  created_at: string;
}

export interface Agent {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
  created_at: string;
}

export interface StaffOrder {
  id: number;
  number: string;
  date: string;
  // Raw WooCommerce status code — the dashboard renders the label itself via
  // its own i18n orderStatuses dict (see orders-panel.tsx's statusLabel()).
  status: string;
  total: string;
  currency: string;
  payment_method: string | null;
  paid: boolean;
  items: { product: string; quantity: number }[];
  shipping: {
    name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
  };
  phone: string | null;
  email: string | null;
}

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
  match_status: 'match' | 'mismatch' | 'unreadable' | 'pending';
  review_status: 'pending' | 'processing' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  media_sha256: string | null;
  transaction_reference: string | null;
  review_attempt_id: string | null;
  note: string | null;
  created_at: string;
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
