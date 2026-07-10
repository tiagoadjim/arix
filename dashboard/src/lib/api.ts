import type {
  Agent,
  AuditEvent,
  Conversation,
  Message,
  Receipt,
  StaffOrder,
  StaffRole,
  UsageSummaryRow,
} from './types';
import type { Dictionary } from './i18n';

/**
 * Thrown by every strict request helper (including GET/text) on a non-2xx
 * response. `code` is the stable
 * snake_case error code from the server's `{ error: '<code>' }` body (see
 * server/src/api/server.ts) — never a human-readable string. Callers
 * translate it via {@link apiErrorMessage} (which looks it up in
 * `t.errors`) instead of rendering `.message` directly; `.message` here is
 * only a fallback for the rare case the server didn't return a recognizable
 * code at all.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Localizes an error thrown by the api/jpost/jput/jdelete helpers for
 * display (toast, inline form error, etc.): a known {@link ApiError} code is
 * translated via `t.errors`, an unknown code falls back to the raw code
 * (still readable, just untranslated), and any other failure (network error,
 * etc.) falls back to `.message` or the given `fallback`.
 */
export function apiErrorMessage(err: unknown, t: Dictionary, fallback: string): string {
  if (err instanceof ApiError) return t.errors[err.code] ?? err.code;
  if (err instanceof Error) return err.message;
  return fallback;
}

type ResponseType = 'json' | 'text';

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  responseType?: ResponseType;
  /** Public/auth endpoints must handle their own 401 instead of treating it as an expired staff session. */
  redirectOnUnauthorized?: boolean;
  /** Credential-test endpoints intentionally return useful JSON on validation errors. */
  allowErrorResponse?: boolean;
}

let unauthorizedRedirect: Promise<void> | null = null;

async function errorCode(res: Response): Promise<string> {
  try {
    const data = (await res.clone().json()) as unknown;
    if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
      return data.error;
    }
  } catch {
    // Some upstream failures are plain text or empty; the status remains the stable fallback.
  }
  return `http_${res.status}`;
}

/**
 * Clear the httpOnly session cookie server-side before leaving the protected UI.
 * The module-level promise makes simultaneous failed polls converge on one logout
 * request and one navigation instead of racing multiple redirects.
 */
async function clearSessionAndRedirect(): Promise<void> {
  if (typeof window === 'undefined' || window.location.pathname === '/login') return;
  if (!unauthorizedRedirect) {
    unauthorizedRedirect = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
        });
      } catch {
        // Navigation still clears the client UI even if the best-effort logout failed.
      } finally {
        clearTimeout(timeout);
      }
      window.location.replace('/login?expired=1');
    })();
  }
  await unauthorizedRedirect;
}

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const {
    body,
    responseType = 'json',
    redirectOnUnauthorized = true,
    allowErrorResponse = false,
    headers: suppliedHeaders,
    ...init
  } = options;
  const headers = new Headers(suppliedHeaders);
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(url, {
    ...init,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });

  if (!res.ok) {
    if (res.status === 401 && redirectOnUnauthorized) await clearSessionAndRedirect();
    if (!allowErrorResponse) throw new ApiError(await errorCode(res), res.status);
  }

  if (res.status === 204) return undefined as T;
  return (responseType === 'text' ? res.text() : res.json()) as Promise<T>;
}

async function jget<T>(url: string, signal?: AbortSignal, redirectOnUnauthorized = true): Promise<T> {
  return request<T>(url, { method: 'GET', signal, redirectOnUnauthorized });
}

/** Like {@link jget}, but for endpoints that respond with plain text (e.g. the WhatsApp QR string). */
async function jgettext(url: string, signal?: AbortSignal): Promise<string> {
  return request<string>(url, { method: 'GET', signal, responseType: 'text' });
}

async function jpost<T>(
  url: string,
  body?: unknown,
  options: { signal?: AbortSignal; redirectOnUnauthorized?: boolean; headers?: HeadersInit } = {},
): Promise<T> {
  return request<T>(url, { method: 'POST', body, ...options });
}

/**
 * Like {@link jpost}, but never throws on a non-2xx status: the setup
 * credential-test endpoints always respond with a `{ok, error?, ...}` body
 * (200 for a rejected credential, 400 for a malformed request), so the
 * caller can check `.ok` uniformly instead of juggling try/catch AND a
 * result flag. Those endpoints' `error` is already a safe, human-readable
 * English sentence (see safeLlmTestError/safeWooTestError server-side) —
 * NOT a stable code — so it's rendered as-is, never through apiErrorMessage.
 */
async function jpostLenient<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    body,
    allowErrorResponse: true,
  });
}

async function jput<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'PUT', body });
}

async function jdelete<T>(url: string): Promise<T> {
  return request<T>(url, { method: 'DELETE' });
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

export interface SetupAdminInput {
  setupToken: string;
  name: string;
  email: string;
  password: string;
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
  /** Inclusive server-defined bounds for numeric settings. */
  min?: number;
  max?: number;
}

export interface SettingsUpdate {
  key: string;
  value: unknown;
}

export interface MessagesPage {
  messages: Message[];
  /** More results exist in the requested cursor direction. */
  hasMore: boolean;
}

export interface MessagePageOptions {
  after?: string;
  before?: string;
  limit?: number;
}

export interface ConversationPage {
  conversations: Conversation[];
  nextCursor: string | null;
}

export interface SkillCatalogEntry {
  id: string;
  label: string;
  description: string;
  toolNames: string[];
  enabled: boolean;
}

export interface McpServerDto {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'http';
  url: string;
  headerKeys: string[];
  allowedTools: string[];
  allowMutatingTools: boolean;
  connected?: boolean;
}

export interface McpToolInfo {
  serverId: string;
  name: string;
  namespacedName: string;
  description?: string;
  readOnly: boolean;
}

export interface TestMcpResult {
  ok: boolean;
  error?: string;
  tools?: McpToolInfo[];
}

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  role: StaffRole;
}

export const api = {
  me: () => jget<SessionUser>('/api/me'),
  logout: () => jpost('/api/auth/logout', undefined, { redirectOnUnauthorized: false }),
  conversations: (signal?: AbortSignal, cursor?: string, limit = 100) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return jget<ConversationPage>(`/api/conversations?${query.toString()}`, signal);
  },
  conversation: (id: string, signal?: AbortSignal) =>
    jget<{ conversation: Conversation; messages: Message[]; receipts: Receipt[] }>(`/api/conversations/${id}`, signal),
  messages: (id: string, options: MessagePageOptions, signal?: AbortSignal) => {
    if (options.after && options.before) throw new Error('Message pagination accepts either after or before, not both.');
    const query = new URLSearchParams();
    if (options.after) query.set('after', options.after);
    if (options.before) query.set('before', options.before);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return jget<MessagesPage>(`/api/conversations/${id}/messages?${query.toString()}`, signal);
  },
  markRead: (id: string, signal?: AbortSignal) =>
    jpost<{ ok: true }>(`/api/conversations/${id}/read`, undefined, { signal }),
  reviewReceipt: (receiptId: string, decision: 'approved' | 'rejected', note?: string) =>
    jpost<{ receipt: Receipt; order?: StaffOrder }>(`/api/receipts/${receiptId}/review`, {
      decision,
      note: note?.trim() || undefined,
    }),
  setMode: (id: string, mode: 'bot' | 'human') => jpost<Conversation>(`/api/conversations/${id}/mode`, { mode }),
  send: (id: string, body: string, clientId: string) =>
    jpost<Message>(`/api/conversations/${id}/messages`, { body, clientId }),
  orders: (id: string, signal?: AbortSignal) => jget<{ orders: StaffOrder[] }>(`/api/conversations/${id}/orders`, signal),
  mediaUrl: (path: string) => `/api/media/${path.split('/').map(encodeURIComponent).join('/')}`,

  // ---- setup wizard ----
  setupStatus: () => jget<SetupStatus>('/api/setup/status', undefined, false),
  setupAdmin: ({ setupToken, ...body }: SetupAdminInput) =>
    jpost<{ id: string; email: string; name: string | null }>('/api/setup/admin', body, {
      redirectOnUnauthorized: false,
      // The one-shot bootstrap credential is a header, never part of the JSON
      // payload that validation/error tooling may retain.
      headers: { 'x-setup-token': setupToken },
    }),
  testLlm: (body: { provider: string; apiKey: string; model?: string; baseUrl?: string; useStored?: boolean }) =>
    jpostLenient<TestLlmResult>('/api/setup/test/llm', body),
  testWoo: (body: { url: string; consumerKey: string; consumerSecret: string; useStored?: boolean }) =>
    jpostLenient<TestWooResult>('/api/setup/test/woocommerce', body),
  setupComplete: () => jpost<{ ok: boolean }>('/api/setup/complete'),

  // ---- WhatsApp pairing ----
  whatsappStatus: (signal?: AbortSignal) => jget<WhatsAppStatus>('/api/whatsapp/status', signal),
  whatsappRestart: (force?: boolean) => jpost<{ ok: true; whatsapp: WhatsAppStatus }>('/api/whatsapp/restart', { force: force ?? false }),
  qr: (signal?: AbortSignal) => jgettext('/api/qr', signal),

  // ---- settings: grouped, sanitized DTO (the shape GET /api/settings
  // actually returns since Fase 6) ----
  settingsGrouped: () => jget<Record<string, SettingDto[]>>('/api/settings'),
  saveSettings: (updates: SettingsUpdate[]) => jput<{ ok: boolean }>('/api/settings', { updates }),

  // ---- skills + MCP ----
  skills: () => jget<{ skills: SkillCatalogEntry[] }>('/api/skills'),
  mcpStatus: () => jget<{ servers: McpServerDto[]; tools: McpToolInfo[] }>('/api/mcp'),
  testMcp: (body: unknown) => jpostLenient<TestMcpResult>('/api/mcp/test', body),

  // ---- agentes (staff) ----
  staff: () => jget<Agent[]>('/api/staff'),
  createStaff: (body: { name: string; email: string; password: string; role: StaffRole }) =>
    jpost<{ id: string; email: string; name: string | null; role: StaffRole }>('/api/staff', body),
  deleteStaff: (id: string) => jdelete<{ ok: boolean }>(`/api/staff/${id}`),
  resetStaffPassword: (id: string, password: string) => jpost<{ ok: boolean }>(`/api/staff/${id}/password`, { password }),
  updateStaffRole: (id: string, role: StaffRole) => jpost<Agent>(`/api/staff/${id}/role`, { role }),

  // ---- analytics and operator diagnostics (admin only) ----
  usage: (days: number, signal?: AbortSignal) =>
    jget<{ rows: UsageSummaryRow[] }>(`/api/analytics/usage?days=${encodeURIComponent(String(days))}`, signal),
  audit: (limit = 100, signal?: AbortSignal) =>
    jget<{ events: AuditEvent[] }>(`/api/audit?limit=${encodeURIComponent(String(limit))}`, signal),
  metrics: (signal?: AbortSignal) => jgettext('/api/metrics', signal),

  // ---- orders: status change + delivery tracking message ----
  updateOrderStatus: (convId: string, orderId: number, status: string) =>
    jpost<{ order: StaffOrder }>(`/api/conversations/${convId}/orders/${orderId}/status`, { status }),
  sendDelivery: (convId: string, orderId: number, payload: { trackingUrl: string; deliveryCode: string; clientId: string }) =>
    jpost<{ message: Message; statusUpdated: boolean }>(`/api/conversations/${convId}/orders/${orderId}/delivery`, payload),
};

export async function login(email: string, password: string): Promise<void> {
  await jpost<{ id: string; email: string; name: string | null }>('/api/auth/login', { email, password }, { redirectOnUnauthorized: false });
}
