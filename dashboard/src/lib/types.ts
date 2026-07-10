// DB row shapes (mirror of the server types / SQL schema).

export type ConversationMode = 'bot' | 'human';

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
  send_status: 'pending' | 'sent' | 'failed' | null;
  sent_by: string | null;
  error: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'staff';
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
  note: string | null;
  created_at: string;
}
