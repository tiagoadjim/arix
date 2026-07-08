import { woo as resolveWooConfig, settingsVersion } from '../config/runtime';
import { logger } from '../logger';

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

async function request<T>(
  path: string,
  opts: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {},
): Promise<{ data: T; headers: Headers }> {
  const { base, auth, configured } = await creds();
  if (!configured) throw new WooNotConfiguredError();

  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    logger.warn({ path, status: res.status, body: parsed }, 'WooCommerce request failed');
    throw new WooError(
      `WooCommerce ${opts.method ?? 'GET'} ${path} -> ${res.status}`,
      res.status,
      parsed,
    );
  }
  return { data: parsed as T, headers: res.headers };
}

/** Digits-only, keep the last `keep` digits to compare phones across formats. */
export function phoneSuffix(phone: string | null | undefined, keep = 8): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.slice(-keep);
}

export const woo = {
  async searchProducts(params: {
    search?: string;
    category?: number;
    stockStatus?: 'instock' | 'outofstock' | 'onbackorder';
    type?: string;
    perPage?: number;
  }): Promise<WcProduct[]> {
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
    });
    return data;
  },

  async getProduct(id: number): Promise<WcProduct> {
    const { data } = await request<WcProduct>(`/products/${id}`);
    return data;
  },

  async listCategories(): Promise<WcCategory[]> {
    const { data } = await request<WcCategory[]>('/products/categories', {
      query: { per_page: 100 },
    });
    return data;
  },

  async getVariations(productId: number): Promise<WcVariation[]> {
    const { data } = await request<WcVariation[]>(`/products/${productId}/variations`, {
      query: { per_page: 100 },
    });
    return data;
  },

  async getOrder(id: number): Promise<WcOrder> {
    const { data } = await request<WcOrder>(`/orders/${id}`);
    return data;
  },

  async searchOrders(search: string, perPage = 100): Promise<WcOrder[]> {
    const { data } = await request<WcOrder[]>('/orders', {
      query: { search, per_page: perPage, orderby: 'date', order: 'desc' },
    });
    return data;
  },

  /**
   * Resolve a human order number to a real order. Handles the common case where
   * number === id, and the sequential-order-number-plugin case (number !== id).
   */
  async resolveOrderByNumber(orderNumber: string): Promise<WcOrder | null> {
    const clean = orderNumber.replace(/[^0-9A-Za-z-]/g, '');
    // Fast path: GET /orders/<id> returns the order whose INTERNAL id === clean.
    // That is only the right order when its customer-facing `number` also equals
    // what the customer quoted. If a sequential-number plugin makes number !== id,
    // this would be a stranger's order — so do NOT return it; fall through to search.
    if (/^\d+$/.test(clean)) {
      try {
        const order = await woo.getOrder(Number(clean));
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
    const results = await woo.searchOrders(clean);
    return results.find((o) => o.number === clean) ?? null;
  },

  /** Find a customer's orders by phone (fuzzy search + defensive suffix match). */
  async findOrdersByPhone(phone: string): Promise<WcOrder[]> {
    const suffix = phoneSuffix(phone);
    if (!suffix) return [];
    const results = await woo.searchOrders(suffix);
    return results.filter((o) => phoneSuffix(o.billing?.phone) === suffix);
  },

  /** Find a customer's orders by email (fuzzy search + defensive exact match). */
  async findOrdersByEmail(email: string): Promise<WcOrder[]> {
    const e = email.trim().toLowerCase();
    if (!e) return [];
    const results = await woo.searchOrders(e);
    return results.filter((o) => (o.billing?.email ?? '').trim().toLowerCase() === e);
  },

  async updateOrderStatus(id: number, status: string): Promise<WcOrder> {
    const { data } = await request<WcOrder>(`/orders/${id}`, {
      method: 'PUT',
      body: { status },
    });
    return data;
  },
};

export type Woo = typeof woo;
