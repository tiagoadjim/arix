import { describe, it, expect } from 'vitest';
import { sanitizeOrder, sanitizeProduct } from '../src/integrations/woocommerce';
import type { WcOrder, WcProduct } from '../src/integrations/woocommerce';

const baseOrder = (over: Partial<WcOrder> = {}): WcOrder => ({
  id: 1,
  number: '1001',
  status: 'processing',
  currency: 'USD',
  total: '100.00',
  total_tax: '0.00',
  shipping_total: '0.00',
  discount_total: '0.00',
  date_created: '2026-01-01T00:00:00',
  date_paid: null,
  customer_id: 0,
  payment_method: '',
  payment_method_title: '',
  billing: { first_name: '', last_name: '', email: 'a@b.com', phone: '123' },
  line_items: [],
  ...over,
});

const baseProduct = (over: Partial<WcProduct> = {}): WcProduct => ({
  id: 1,
  name: 'Test product',
  slug: 'test-product',
  sku: '',
  type: 'simple',
  status: 'publish',
  price: '10',
  regular_price: '10',
  sale_price: '',
  on_sale: false,
  stock_status: 'instock',
  stock_quantity: null,
  manage_stock: false,
  permalink: 'https://shop.example.com/product/test-product',
  categories: [],
  attributes: [],
  variations: [],
  ...over,
});

describe('sanitizeOrder', () => {
  it('passes a well-formed order through unchanged', () => {
    const order = baseOrder();
    expect(sanitizeOrder(order)).toEqual(order);
  });

  it('degrades a non-numeric total to an empty string (parseAmount treats it as unreadable)', () => {
    const order = sanitizeOrder(baseOrder({ total: 'not-a-number' }));
    expect(order.total).toBe('');
  });

  it('accepts a negative or decimal-formatted total as valid', () => {
    expect(sanitizeOrder(baseOrder({ total: '-5.00' })).total).toBe('-5.00');
    expect(sanitizeOrder(baseOrder({ total: '1234' })).total).toBe('1234');
  });

  it('degrades a missing/non-string status to "unknown" (never matches a confirmable state)', () => {
    const order = sanitizeOrder(baseOrder({ status: undefined as unknown as string }));
    expect(order.status).toBe('unknown');
  });

  it('degrades an empty-string status to "unknown"', () => {
    const order = sanitizeOrder(baseOrder({ status: '' }));
    expect(order.status).toBe('unknown');
  });

  it('falls back order.number to the internal id when missing', () => {
    const order = sanitizeOrder(baseOrder({ number: undefined as unknown as string }));
    expect(order.number).toBe('1');
  });

  it('degrades non-string billing.phone/email to empty strings instead of throwing', () => {
    const order = sanitizeOrder(
      baseOrder({
        billing: {
          first_name: '',
          last_name: '',
          email: 42 as unknown as string,
          phone: null as unknown as string,
        },
      }),
    );
    expect(order.billing.email).toBe('');
    expect(order.billing.phone).toBe('');
  });

  it('tolerates a missing billing object entirely', () => {
    const order = sanitizeOrder(baseOrder({ billing: undefined as unknown as WcOrder['billing'] }));
    expect(order.billing.email).toBe('');
    expect(order.billing.phone).toBe('');
  });
});

describe('sanitizeProduct', () => {
  it('passes a well-formed product through unchanged', () => {
    const product = baseProduct();
    expect(sanitizeProduct(product)).toEqual(product);
  });

  it('degrades an unrecognized stock_status to outofstock (never claim false availability)', () => {
    const product = sanitizeProduct(
      baseProduct({ stock_status: 'discontinued' as unknown as WcProduct['stock_status'] }),
    );
    expect(product.stock_status).toBe('outofstock');
  });

  it('degrades a missing permalink to an empty string (falls through to the link template)', () => {
    const product = sanitizeProduct(baseProduct({ permalink: undefined as unknown as string }));
    expect(product.permalink).toBe('');
  });

  it('keeps the other known stock statuses untouched', () => {
    expect(sanitizeProduct(baseProduct({ stock_status: 'outofstock' })).stock_status).toBe('outofstock');
    expect(sanitizeProduct(baseProduct({ stock_status: 'onbackorder' })).stock_status).toBe('onbackorder');
  });
});
