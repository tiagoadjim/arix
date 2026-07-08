import { describe, it, expect, vi, afterEach } from 'vitest';
import { woo } from '../src/integrations/woocommerce';

type OrderRow = { id: number; number: string };

/** Stub global fetch to serve GET /orders/<id> and GET /orders?search=... */
function stubWoo(orders: OrderRow[]) {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    const ok = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    });
    const m = url.match(/\/orders\/(\d+)(?:\?|$)/);
    if (m) {
      const id = Number(m[1]);
      const found = orders.find((o) => o.id === id);
      return found ? ok(found) : ok({ message: 'not found' }, 404);
    }
    // search
    const u = new URL(url);
    const search = u.searchParams.get('search') ?? '';
    return ok(orders.filter((o) => o.number.includes(search) || String(o.id).includes(search)));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveOrderByNumber', () => {
  it('resolves directly when number === id', async () => {
    stubWoo([{ id: 5, number: '5' }]);
    const order = await woo.resolveOrderByNumber('5');
    expect(order?.id).toBe(5);
  });

  it('does NOT return the wrong order when number !== id (sequential-number plugin)', async () => {
    // Customer quotes 1500. Internal id 1500 belongs to a STRANGER (number 1422).
    // The real order has number 1500 / internal id 8732.
    stubWoo([
      { id: 1500, number: '1422' },
      { id: 8732, number: '1500' },
    ]);
    const order = await woo.resolveOrderByNumber('1500');
    expect(order?.id).toBe(8732); // matched by `number`, not by internal id
    expect(order?.number).toBe('1500');
  });

  it('returns null when no order matches exactly (no arbitrary fuzzy fallback)', async () => {
    stubWoo([{ id: 1, number: '9' }]); // fuzzy search may return it, but it is not a match
    const order = await woo.resolveOrderByNumber('1234');
    expect(order).toBeNull();
  });
});
