import type { Agent, Conversation, Message, Receipt, StaffOrder } from './types';

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** Like {@link jget}, but for endpoints that respond with plain text (e.g. the WhatsApp QR string). */
async function jgettext(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function jpost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `POST ${url} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Like {@link jpost}, but never throws on a non-2xx status: the setup
 * credential-test endpoints always respond with a `{ok, error?, ...}` body
 * (200 for a rejected credential, 400 for a malformed request), so the
 * caller can check `.ok` uniformly instead of juggling try/catch AND a
 * result flag.
 */
async function jpostLenient<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  return res.json() as Promise<T>;
}

async function jput<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `PUT ${url} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function jdelete<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `DELETE ${url} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---- setup wizard (server/src/api/server.ts) ----

export interface WhatsAppStatus {
  connected: boolean;
  hasQr: boolean;
}

export interface SetupStatus {
  needsSetup: boolean;
  setupCompleted: boolean;
  whatsapp: WhatsAppStatus;
}

export interface TestLlmResult {
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
  /** Absent only on the earliest validation failures (unknown provider / missing key). */
  model?: string;
  vision?: boolean;
}

export interface TestWooResult {
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
  sampleProductName?: string | null;
}

// ---- settings (server/src/api/settings-dto.ts) ----

export type SettingType = 'string' | 'boolean' | 'number' | 'json' | 'enum';
export type SettingSource = 'env' | 'db' | 'default';

/** Sanitized, dashboard-facing view of one settings-schema entry — mirrors
 * server/src/api/settings-dto.ts's SettingDto 1:1. Secrets never carry a
 * plaintext `value`; `set` is the only signal for whether one is configured. */
export interface SettingDto {
  key: string;
  group: string;
  type: SettingType;
  label: string;
  value: unknown;
  set: boolean;
  source: SettingSource;
  readOnly: boolean;
  secret: boolean;
}

export interface SettingsUpdate {
  key: string;
  value: unknown;
}

export const api = {
  logout: () => jpost('/api/auth/logout'),
  conversations: () => jget<Conversation[]>('/api/conversations'),
  conversation: (id: string) =>
    jget<{ conversation: Conversation; messages: Message[]; receipts: Receipt[] }>(`/api/conversations/${id}`),
  setMode: (id: string, mode: 'bot' | 'human') => jpost<Conversation>(`/api/conversations/${id}/mode`, { mode }),
  send: (id: string, body: string) => jpost<Message>(`/api/conversations/${id}/messages`, { body }),
  orders: (id: string) => jget<{ orders: StaffOrder[] }>(`/api/conversations/${id}/orders`),
  mediaUrl: (path: string) => `/api/media/${path.split('/').map(encodeURIComponent).join('/')}`,

  // ---- setup wizard ----
  setupStatus: () => jget<SetupStatus>('/api/setup/status'),
  setupAdmin: (body: { name: string; email: string; password: string }) =>
    jpost<{ id: string; email: string; name: string | null }>('/api/setup/admin', body),
  testLlm: (body: { provider: string; apiKey: string; model?: string; baseUrl?: string }) =>
    jpostLenient<TestLlmResult>('/api/setup/test/llm', body),
  testWoo: (body: { url: string; consumerKey: string; consumerSecret: string }) =>
    jpostLenient<TestWooResult>('/api/setup/test/woocommerce', body),
  setupComplete: () => jpost<{ ok: boolean }>('/api/setup/complete'),

  // ---- WhatsApp pairing ----
  whatsappStatus: () => jget<WhatsAppStatus>('/api/whatsapp/status'),
  whatsappRestart: (force?: boolean) => jpost<{ ok: true; whatsapp: WhatsAppStatus }>('/api/whatsapp/restart', { force: force ?? false }),
  qr: () => jgettext('/api/qr'),

  // ---- settings: grouped, sanitized DTO (the shape GET /api/settings
  // actually returns since Fase 6) ----
  settingsGrouped: () => jget<Record<string, SettingDto[]>>('/api/settings'),
  saveSettings: (updates: SettingsUpdate[]) => jput<{ ok: boolean }>('/api/settings', { updates }),

  // ---- agentes (staff) ----
  staff: () => jget<Agent[]>('/api/staff'),
  createStaff: (body: { name: string; email: string; password: string }) =>
    jpost<{ id: string; email: string; name: string | null }>('/api/staff', body),
  deleteStaff: (id: string) => jdelete<{ ok: boolean }>(`/api/staff/${id}`),
  resetStaffPassword: (id: string, password: string) => jpost<{ ok: boolean }>(`/api/staff/${id}/password`, { password }),

  // ---- pedidos: cambio de estado + envío Uber Moto ----
  updateOrderStatus: (convId: string, orderId: number, status: string) =>
    jpost<{ order: StaffOrder }>(`/api/conversations/${convId}/orders/${orderId}/status`, { status }),
  sendDelivery: (convId: string, orderId: number, payload: { trackingUrl: string; deliveryCode: string; orderNumber: string }) =>
    jpost<{ message: Message; statusUpdated: boolean }>(`/api/conversations/${convId}/orders/${orderId}/delivery`, payload),
};

export async function login(email: string, password: string): Promise<void> {
  await jpost<{ id: string; email: string; name: string | null }>('/api/auth/login', { email, password });
}
