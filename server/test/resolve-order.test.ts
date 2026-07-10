import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { safeFetchMock, resolveWooConfig } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  lookup: vi.fn(),
  resolveWooConfig: vi.fn(),
}));

// SSRF/DNS-pinning behavior has its own safe-fetch contract suite. These Woo
// unit tests replace that boundary so they never open a real pinned socket.
vi.mock('../src/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/net/safe-fetch')>();
  return { ...actual, safeFetch: safeFetchMock };
});
vi.mock('../src/config/runtime', () => ({
  woo: resolveWooConfig,
  settingsVersion: () => 0,
}));

import { woo } from '../src/integrations/woocommerce';

type OrderRow = { id: number; number: string };

/** Stub the validated remote transport to serve orders deterministically. */
function stubWoo(orders: OrderRow[]) {
  safeFetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const url = request.url;
    const ok = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
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

beforeEach(() => {
  safeFetchMock.mockReset();
  resolveWooConfig.mockReset().mockResolvedValue({
    url: 'https://shop.example.com',
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
    configured: true,
  });
});

afterEach(() => vi.restoreAllMocks());

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
