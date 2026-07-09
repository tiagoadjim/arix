import { describe, it, expect } from 'vitest';
import {
  buildDeliveryMessage,
  DEFAULT_DELIVERY_TEMPLATE,
  STATUS_ES,
  orderForStaff,
} from '../src/skills/orders';
import type { WcOrder } from '../src/integrations/woocommerce';

describe('buildDeliveryMessage', () => {
  it('replaces every placeholder, including repeats', () => {
    const tpl = 'Pedido #{numero}: {link} — código {codigo}. Repetido: {numero}/{codigo}';
    const out = buildDeliveryMessage(tpl, {
      numero: '1500',
      link: 'https://tracking.test/track/abc',
      codigo: '7788',
    });
    expect(out).toBe(
      'Pedido #1500: https://tracking.test/track/abc — código 7788. Repetido: 1500/7788',
    );
    expect(out).not.toMatch(/\{(numero|link|codigo)\}/);
  });

  it('fills the default Spanish template with real values', () => {
    const out = buildDeliveryMessage(DEFAULT_DELIVERY_TEMPLATE.es, {
      numero: '42',
      link: 'https://tracking.test/x',
      codigo: '0001',
    });
    expect(out).toContain('#42');
    expect(out).toContain('https://tracking.test/x');
    expect(out).toContain('0001');
    expect(out).not.toContain('{');
  });

  it('fills the default English template with real values', () => {
    const out = buildDeliveryMessage(DEFAULT_DELIVERY_TEMPLATE.en, {
      numero: '42',
      link: 'https://tracking.test/x',
      codigo: '0001',
    });
    expect(out).toContain('#42');
    expect(out).toContain('https://tracking.test/x');
    expect(out).toContain('0001');
    expect(out).not.toContain('{');
  });

  it('leaves unrelated braces untouched', () => {
    const out = buildDeliveryMessage('hola {numero} {otro}', {
      numero: '7',
      link: 'l',
      codigo: 'c',
    });
    expect(out).toBe('hola 7 {otro}');
  });
});

describe('STATUS_ES', () => {
  it('includes the custom en-camino dispatch status', () => {
    expect(STATUS_ES['en-camino']).toBeTruthy();
  });
});

describe('orderForStaff', () => {
  it('exposes the internal WooCommerce id (needed for status/delivery endpoints)', () => {
    const order = {
      id: 8732,
      number: '1500',
      status: 'processing',
      currency: 'ARS',
      total: '10000.00',
      date_created: '2026-06-29T12:00:00',
      date_paid: null,
      payment_method: 'bacs',
      payment_method_title: 'Transferencia',
      billing: { first_name: 'Ana', last_name: 'Gomez', email: 'a@b.com', phone: '1122334455' },
      shipping: { address_1: 'Calle 1', city: 'CABA' },
      line_items: [{ name: 'Vape X', quantity: 2 }],
    } as unknown as WcOrder;

    const staff = orderForStaff(order);
    expect(staff.id).toBe(8732);
    expect(staff.number).toBe('1500');
    expect(staff.items).toEqual([{ product: 'Vape X', quantity: 2 }]);
  });
});
