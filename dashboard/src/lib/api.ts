import type { Agent, Conversation, Message, Receipt, StaffOrder } from './types';

export interface Me {
  id: string;
  email: string;
  name?: string;
}

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json() as Promise<T>;
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

export const api = {
  me: () => jget<Me>('/api/me'),
  logout: () => jpost('/api/auth/logout'),
  conversations: () => jget<Conversation[]>('/api/conversations'),
  conversation: (id: string) =>
    jget<{ conversation: Conversation; messages: Message[]; receipts: Receipt[] }>(
      `/api/conversations/${id}`,
    ),
  messagesSince: (id: string, since: string) =>
    jget<Message[]>(`/api/conversations/${id}/messages?since=${encodeURIComponent(since)}`),
  setMode: (id: string, mode: 'bot' | 'human') =>
    jpost<Conversation>(`/api/conversations/${id}/mode`, { mode }),
  send: (id: string, body: string) => jpost<Message>(`/api/conversations/${id}/messages`, { body }),
  orders: (id: string) => jget<{ orders: StaffOrder[] }>(`/api/conversations/${id}/orders`),
  mediaUrl: (path: string) => `/api/media/${path.split('/').map(encodeURIComponent).join('/')}`,
  settings: () => jget<Record<string, string>>('/api/settings'),
  saveSetting: (key: string, value: string) => jput<{ ok: boolean }>('/api/settings', { key, value }),

  // ---- agentes (staff) ----
  staff: () => jget<Agent[]>('/api/staff'),
  createStaff: (body: { name: string; email: string; password: string }) =>
    jpost<{ id: string; email: string; name: string | null }>('/api/staff', body),
  deleteStaff: (id: string) => jdelete<{ ok: boolean }>(`/api/staff/${id}`),
  resetStaffPassword: (id: string, password: string) =>
    jpost<{ ok: boolean }>(`/api/staff/${id}/password`, { password }),

  // ---- pedidos: cambio de estado + envío Uber Moto ----
  updateOrderStatus: (convId: string, orderId: number, status: string) =>
    jpost<{ order: StaffOrder }>(`/api/conversations/${convId}/orders/${orderId}/status`, { status }),
  sendDelivery: (
    convId: string,
    orderId: number,
    payload: { trackingUrl: string; deliveryCode: string; orderNumber: string },
  ) =>
    jpost<{ message: Message; statusUpdated: boolean }>(
      `/api/conversations/${convId}/orders/${orderId}/delivery`,
      payload,
    ),
};

export async function login(email: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? 'Error de login');
  }
}
