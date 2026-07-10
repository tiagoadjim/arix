import { woo as resolveWooConfig, settingsVersion } from '../config/runtime';
import { logger } from '../logger';
import { readTextLimited, safeFetch } from '../net/safe-fetch';

/**
 * Thin typed client for the WooCommerce REST API v3.
 * Auth: HTTP Basic (consumer key as user, secret as password) over HTTPS.
 * Docs: https://woocommerce.github.io/woocommerce-rest-api-docs/
 */

/** Raised when a WooCommerce call is attempted before the store is configured
 * (no URL/consumer key/secret set yet — a fresh, not-yet-onboarded install). */
export class WooNotConfiguredError extends Error {
  constructor(message = 'WooCommerce is not configured yet — set the store URL and API keys in the dashboard.') {
    super(message);
    this.name = 'WooNotConfiguredError';
  }
}

interface WooCreds {
  base: string;
  auth: string;
  configured: boolean;
}

let credsCache: (WooCreds & { version: number }) | null = null;

/** Resolve WooCommerce base URL + Basic-auth header from the runtime config
 * service, memoized until a settings write calls runtime.invalidate(). */
async function creds(): Promise<WooCreds> {
  const version = settingsVersion();
  if (credsCache && credsCache.version === version) return credsCache;

  const w = await resolveWooConfig();
  const resolved: WooCreds & { version: number } = {
    version,
    base: `${w.url.replace(/\/$/, '')}/wp-json/wc/v3`,
    auth: 'Basic ' + Buffer.from(`${w.consumerKey}:${w.consumerSecret}`).toString('base64'),
    configured: w.configured,
  };
  credsCache = resolved;
  return resolved;
}

export interface WcCategory {
  id: number;
  name: string;
  slug: string;
}

export interface WcProductAttribute {
  id: number;
  name: string;
  variation: boolean;
  options?: string[]; // parent product: full list of values (e.g. flavor names)
  option?: string; // variation: the single chosen value
}

export interface WcProduct {
  id: number;
  name: string;
  slug: string;
  sku: string;
  type: string; // simple | variable | ...
  status: string;
  price: string;
  regular_price: string;
  sale_price: string;
  on_sale: boolean;
  stock_status: 'instock' | 'outofstock' | 'onbackorder';
  stock_quantity: number | null;
  manage_stock: boolean;
  permalink: string;
  categories: WcCategory[];
  attributes: WcProductAttribute[];
  variations: number[];
  short_description?: string;
}

export interface WcVariation {
  id: number;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  on_sale: boolean;
  stock_status: 'instock' | 'outofstock' | 'onbackorder';
  stock_quantity: number | null;
  attributes: WcProductAttribute[];
}

export interface WcLineItem {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  sku: string;
  price: number;
  subtotal: string;
  total: string;
  meta_data: Array<{ key: string; value: unknown; display_key?: string; display_value?: string }>;
}

export interface WcOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  total_tax: string;
  shipping_total: string;
  discount_total: string;
  date_created: string;
  date_paid: string | null;
  customer_id: number;
  payment_method: string;
  payment_method_title: string;
  billing: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
  };
  shipping?: {
    first_name?: string;
    last_name?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
  };
  line_items: WcLineItem[];
}

export class WooError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'WooError';
  }
}

const KNOWN_STOCK_STATUSES = new Set<string>(['instock', 'outofstock', 'onbackorder']);

/**
 * Light boundary validation for the WooCommerce fields the bot actually
 * consumes (see the fields listed below) — NOT a full schema validator (no
 * zod here, deliberately). A malformed/missing field never throws mid-turn:
 * it's logged and degraded to a safe value, chosen so downstream code (which
 * already has to handle "unknown"/"unreadable" states) treats it the same as
 * a legitimate edge case rather than crashing or acting on bad data.
 */
export function sanitizeProduct(product: WcProduct): WcProduct {
  let out = product;
  if (!KNOWN_STOCK_STATUSES.has(out.stock_status)) {
    logger.warn(
      { productId: out.id, stockStatus: out.stock_status },
      'WooCommerce product.stock_status is not a recognized value — degrading to outofstock so the bot never claims false availability',
    );
    out = { ...out, stock_status: 'outofstock' };
  }
  if (typeof out.permalink !== 'string') {
    logger.warn(
      { productId: out.id },
      'WooCommerce product.permalink is missing/invalid — degrading to empty so productLink() falls back to the link template',
    );
    out = { ...out, permalink: '' };
  }
  return out;
}

const NUMERIC_STRING_RE = /^-?\d+(\.\d+)?$/;

export function sanitizeOrder(order: WcOrder): WcOrder {
  let out = order;
  if (typeof out.total !== 'string' || !NUMERIC_STRING_RE.test(out.total)) {
    logger.warn(
      { orderId: out.id, total: out.total },
      'WooCommerce order.total is not a numeric string — degrading to empty (parseAmount treats it as unreadable)',
    );
    out = { ...out, total: '' };
  }
  if (typeof out.status !== 'string' || !out.status) {
    logger.warn(
      { orderId: out.id, status: out.status },
      'WooCommerce order.status is missing/invalid — degrading to "unknown" (never matches a confirmable/paid state)',
    );
    out = { ...out, status: 'unknown' };
  }
  if (typeof out.number !== 'string' || !out.number) {
    logger.warn({ orderId: out.id }, 'WooCommerce order.number is missing/invalid — falling back to the internal id');
    out = { ...out, number: String(out.id) };
  }
  const billing = out.billing ?? ({} as WcOrder['billing']);
  const phoneOk = typeof billing.phone === 'string';
  const emailOk = typeof billing.email === 'string';
  if (!phoneOk || !emailOk) {
    logger.warn(
      { orderId: out.id },
      'WooCommerce billing.phone/email is missing/invalid — degrading to empty strings',
    );
    out = { ...out, billing: { ...billing, phone: phoneOk ? billing.phone : '', email: emailOk ? billing.email : '' } };
  }
  return out;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function request<T>(
  path: string,
  opts: {
    method?: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<{ data: T; headers: Headers }> {
  const { base, auth, configured } = await creds();
  if (!configured) throw new WooNotConfiguredError();

  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const method = opts.method ?? 'GET';
  const attempts = method === 'GET' ? 3 : 1;
  let res: Response | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      res = await safeFetch(
        url,
        {
          method,
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: opts.signal,
        },
        { timeoutMs: 20_000 },
      );
      if (attempt < attempts && (res.status === 429 || res.status >= 500)) {
        await res.body?.cancel().catch(() => {});
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter)
          ? Math.min(5_000, Math.max(250, retryAfter * 1000))
          : attempt * 500;
        await abortableDelay(delay, opts.signal);
        continue;
      }
      break;
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) throw err;
      await abortableDelay(attempt * 500, opts.signal);
    }
  }
  if (!res) throw lastError ?? new Error('WooCommerce request failed without a response');

  const text = await readTextLimited(res);
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    logger.warn({ path, method, status: res.status }, 'WooCommerce request failed');
    throw new WooError(
      `WooCommerce ${opts.method ?? 'GET'} ${path} -> ${res.status}`,
      res.status,
      parsed,
    );
  }
  return { data: parsed as T, headers: res.headers };
}

/** Canonical phone representation used for authorization decisions. Formatting
 * characters are ignored, but every digit (including country/area code) must
 * match. Never use a suffix as an identity boundary: unrelated customers can
 * legitimately share the same local tail. */
export function normalizePhone(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/** Digits-only tail used only to obtain fuzzy WooCommerce search candidates.
 * Candidate results must still be filtered with {@link normalizePhone}. */
export function phoneSuffix(phone: string | null | undefined, keep = 8): string {
  const digits = normalizePhone(phone);
  return digits.slice(-keep);
}

export const woo = {
  async searchProducts(params: {
    search?: string;
    category?: number;
    stockStatus?: 'instock' | 'outofstock' | 'onbackorder';
    type?: string;
    perPage?: number;
  }, signal?: AbortSignal): Promise<WcProduct[]> {
    const { data } = await request<WcProduct[]>('/products', {
      query: {
        search: params.search,
        category: params.category,
        stock_status: params.stockStatus,
        type: params.type,
        status: 'publish',
        per_page: params.perPage ?? 20,
        orderby: 'popularity',
      },
      signal,
    });
    return data.map(sanitizeProduct);
  },

  async getProduct(id: number, signal?: AbortSignal): Promise<WcProduct> {
    const { data } = await request<WcProduct>(`/products/${id}`, { signal });
    return sanitizeProduct(data);
  },

  async listCategories(signal?: AbortSignal): Promise<WcCategory[]> {
    const { data } = await request<WcCategory[]>('/products/categories', {
      query: { per_page: 100 }, signal,
    });
    return data;
  },

  async getVariations(productId: number, signal?: AbortSignal): Promise<WcVariation[]> {
    const { data } = await request<WcVariation[]>(`/products/${productId}/variations`, {
      query: { per_page: 100 }, signal,
    });
    return data;
  },

  async getOrder(id: number, signal?: AbortSignal): Promise<WcOrder> {
    const { data } = await request<WcOrder>(`/orders/${id}`, { signal });
    return sanitizeOrder(data);
  },

  async searchOrders(search: string, perPage = 100, signal?: AbortSignal): Promise<WcOrder[]> {
    const { data } = await request<WcOrder[]>('/orders', {
      query: { search, per_page: perPage, orderby: 'date', order: 'desc' },
      signal,
    });
    return data.map(sanitizeOrder);
  },

  /**
   * Resolve a human order number to a real order. Handles the common case where
   * number === id, and the sequential-order-number-plugin case (number !== id).
   */
  async resolveOrderByNumber(orderNumber: string, signal?: AbortSignal): Promise<WcOrder | null> {
    const clean = orderNumber.replace(/[^0-9A-Za-z-]/g, '');
    // Fast path: GET /orders/<id> returns the order whose INTERNAL id === clean.
    // That is only the right order when its customer-facing `number` also equals
    // what the customer quoted. If a sequential-number plugin makes number !== id,
    // this would be a stranger's order — so do NOT return it; fall through to search.
    if (/^\d+$/.test(clean)) {
      try {
        const order = await woo.getOrder(Number(clean), signal);
        if (order && order.number === clean) return order;
      } catch (err) {
        if (!(err instanceof WooError && err.status === 404)) throw err;
      }
    }
    // General path: search and match the customer-facing `number` field EXACTLY.
    // Match ONLY on `number` (the customer always quotes that, never the internal
    // id) — matching internal id here could return a stranger's order whose id
    // happens to equal the quoted number. Search is fuzzy, so a non-match must
    // resolve to null (caller reports "orden no encontrada").
    const results = await woo.searchOrders(clean, 100, signal);
    return results.find((o) => o.number === clean) ?? null;
  },

  /** Find a customer's orders by phone. Woo search is fuzzy, but the returned
   * rows cross an authorization boundary and therefore require a full exact
   * digits-only match. */
  async findOrdersByPhone(phone: string, signal?: AbortSignal): Promise<WcOrder[]> {
    const normalized = normalizePhone(phone);
    const suffix = phoneSuffix(phone);
    if (!normalized || !suffix) return [];
    const results = await woo.searchOrders(suffix, 100, signal);
    return results.filter((o) => normalizePhone(o.billing?.phone) === normalized);
  },

  /** Find a customer's orders by email (fuzzy search + defensive exact match). */
  async findOrdersByEmail(email: string, signal?: AbortSignal): Promise<WcOrder[]> {
    const e = email.trim().toLowerCase();
    if (!e) return [];
    const results = await woo.searchOrders(e, 100, signal);
    return results.filter((o) => (o.billing?.email ?? '').trim().toLowerCase() === e);
  },

  async updateOrderStatus(id: number, status: string, signal?: AbortSignal): Promise<WcOrder> {
    const { data } = await request<WcOrder>(`/orders/${id}`, {
      method: 'PUT',
      body: { status },
      signal,
    });
    return sanitizeOrder(data);
  },
};

export type Woo = typeof woo;
