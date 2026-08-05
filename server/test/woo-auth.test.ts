import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

/**
 * The one-click store connection, with the security properties that make its
 * unauthenticated callback acceptable pinned down as tests.
 */

// Cleared before `../src/config` is imported: setup-env.ts seeds WC_* so other
// suites get a configured store, but an env-seeded credential makes the connect
// endpoint (correctly) refuse to do anything, since env always beats the DB.
const { repoMocks, safeFetchMock, assertSafeRemoteUrlMock } = vi.hoisted(() => {
  delete process.env.WC_URL;
  delete process.env.WC_CONSUMER_KEY;
  delete process.env.WC_CONSUMER_SECRET;
  process.env.PUBLIC_URL = 'https://arix.example.com';
  return {
    repoMocks: {
      countStaff: vi.fn(),
      getStaffById: vi.fn(),
      getSettings: vi.fn(),
      upsertSetting: vi.fn(),
      upsertSettings: vi.fn(),
      insertAuditEvent: vi.fn(),
      createSetupAuthRequest: vi.fn(),
      consumeSetupAuthRequest: vi.fn(),
      getSetupAuthRequestStatus: vi.fn(),
      markSetupAuthRequestConnected: vi.fn(),
    },
    safeFetchMock: vi.fn(),
    assertSafeRemoteUrlMock: vi.fn(),
  };
});

vi.mock('../src/db/repo', () => repoMocks);
vi.mock('../src/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/net/safe-fetch')>();
  return { ...actual, safeFetch: safeFetchMock, assertSafeRemoteUrl: assertSafeRemoteUrlMock };
});

import { createApiServer } from '../src/api/server';
import { UnsafeRemoteUrlError } from '../src/net/safe-fetch';
import { signSession, SESSION_COOKIE } from '../src/api/auth';
import { invalidate } from '../src/config/runtime';
import { decryptSecret } from '../src/config/secret';
import {
  buildWooAuthorizeUrl,
  hashAuthState,
  mintAuthState,
  normalizeStoreUrl,
  parseWooCallbackBody,
  resetDeliveredCredentials,
  resolvePublicOrigin,
  StoreUrlError,
  wooCreateKeyUrl,
} from '../src/integrations/woocommerce-auth';
import type { WhatsAppGateway } from '../src/whatsapp/socket';

const STAFF = {
  id: 'staff-1',
  email: 'admin@example.com',
  password_hash: 'x',
  name: 'Admin',
  role: 'admin' as const,
  session_version: 0,
};

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CONSUMER_KEY = `ck_${'a'.repeat(40)}`;
const CONSUMER_SECRET = `cs_${'b'.repeat(40)}`;

const gateway = { connected: false, latestQR: null, restart: vi.fn() } as unknown as WhatsAppGateway;

function app() {
  return createApiServer({ gateway });
}

async function adminCookie(): Promise<string> {
  const token = await signSession({ id: STAFF.id, email: STAFF.email, name: STAFF.name, role: 'admin' }, 0);
  return `${SESSION_COOKIE}=${token}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDeliveredCredentials();
  invalidate();
  repoMocks.countStaff.mockResolvedValue(1);
  repoMocks.getStaffById.mockResolvedValue(STAFF);
  repoMocks.getSettings.mockResolvedValue({});
  repoMocks.upsertSettings.mockResolvedValue(undefined);
  repoMocks.insertAuditEvent.mockResolvedValue(undefined);
  repoMocks.createSetupAuthRequest.mockResolvedValue(REQUEST_ID);
  assertSafeRemoteUrlMock.mockImplementation(async (raw: string | URL) => new URL(String(raw)));
});

describe('normalizeStoreUrl', () => {
  it('accepts what people actually type', () => {
    expect(normalizeStoreUrl('mitienda.com')).toBe('https://mitienda.com');
    expect(normalizeStoreUrl('  https://mitienda.com/  ')).toBe('https://mitienda.com');
    expect(normalizeStoreUrl('https://mitienda.com/wp-admin/admin.php?page=wc-settings')).toBe(
      'https://mitienda.com',
    );
    expect(normalizeStoreUrl('https://mitienda.com/wp-json/wc/v3/products')).toBe('https://mitienda.com');
  });

  it('keeps a sub-directory install, because that path is part of the REST base', () => {
    expect(normalizeStoreUrl('https://ejemplo.com/tienda/')).toBe('https://ejemplo.com/tienda');
  });

  it('rejects junk and embedded credentials', () => {
    expect(() => normalizeStoreUrl('')).toThrow(StoreUrlError);
    expect(() => normalizeStoreUrl('ftp://mitienda.com')).toThrow(StoreUrlError);
    expect(() => normalizeStoreUrl('https://user:pass@mitienda.com')).toThrow(StoreUrlError);
  });
});

describe('resolvePublicOrigin', () => {
  it('prefers PUBLIC_URL over forwarded headers', () => {
    expect(resolvePublicOrigin({ forwardedProto: 'http', forwardedHost: 'evil.test' })?.origin).toBe(
      'https://arix.example.com',
    );
  });

  it('refuses anything that is not HTTPS — WooCommerce rejects those callbacks outright', () => {
    // A localhost install can never use the one-click flow. Detecting that here
    // is what lets the wizard offer the manual path instead of a dead end.
    expect(resolvePublicOrigin({ forwardedProto: 'http', forwardedHost: 'localhost:3000' }, null)).toBeNull();
    expect(resolvePublicOrigin({ forwardedProto: 'http', forwardedHost: 'arix.example.com' }, null)).toBeNull();
    expect(resolvePublicOrigin({}, 'http://arix.example.com')).toBeNull();
  });

  it('accepts a correctly forwarded HTTPS origin when PUBLIC_URL is unset', () => {
    expect(
      resolvePublicOrigin({ forwardedProto: 'https', forwardedHost: 'arix.example.com' }, null)?.origin,
    ).toBe('https://arix.example.com');
  });

  it('ignores a malformed forwarded host', () => {
    expect(resolvePublicOrigin({ forwardedProto: 'https', forwardedHost: 'has space' }, null)).toBeNull();
    expect(resolvePublicOrigin({ forwardedProto: 'https' }, null)).toBeNull();
  });
});

describe('buildWooAuthorizeUrl', () => {
  it('produces exactly the parameters WooCommerce requires, encoded', () => {
    const url = new URL(
      buildWooAuthorizeUrl({
        storeBase: 'https://mitienda.com',
        publicOrigin: new URL('https://arix.example.com'),
        requestId: REQUEST_ID,
        state: 'f'.repeat(64),
      }),
    );
    expect(url.origin + url.pathname).toBe('https://mitienda.com/wc-auth/v1/authorize');
    expect(url.searchParams.get('app_name')).toBe('Arix');
    // Read-only is not enough: confirming a payment moves the order forward.
    expect(url.searchParams.get('scope')).toBe('read_write');
    expect(url.searchParams.get('user_id')).toBe(REQUEST_ID);
    expect(url.searchParams.get('return_url')).toBe(`https://arix.example.com/setup?woo=${REQUEST_ID}`);
    expect(url.searchParams.get('callback_url')).toBe(
      `https://arix.example.com/api/integrations/woocommerce/callback/${'f'.repeat(64)}`,
    );
  });

  it('keeps a sub-directory install in the path', () => {
    const url = buildWooAuthorizeUrl({
      storeBase: 'https://ejemplo.com/tienda',
      publicOrigin: new URL('https://arix.example.com'),
      requestId: REQUEST_ID,
      state: 'f'.repeat(64),
    });
    expect(url).toContain('https://ejemplo.com/tienda/wc-auth/v1/authorize');
  });
});

describe('mintAuthState', () => {
  it('returns a 256-bit nonce and only ever stores its digest', () => {
    const { state, stateHash } = mintAuthState();
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    expect(stateHash).toBe(hashAuthState(state));
    expect(stateHash).not.toBe(state);
  });
});

describe('parseWooCallbackBody', () => {
  const good = {
    key_id: 3,
    user_id: REQUEST_ID,
    consumer_key: CONSUMER_KEY,
    consumer_secret: CONSUMER_SECRET,
    key_permissions: 'read_write',
  };

  it('accepts a well-formed payload', () => {
    expect(parseWooCallbackBody(good, REQUEST_ID)).toEqual({
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
    });
  });

  it('rejects a user_id that is not the request we minted', () => {
    expect(parseWooCallbackBody({ ...good, user_id: 'someone-else' }, REQUEST_ID)).toBeNull();
  });

  it('rejects read-only permissions rather than failing later', () => {
    expect(parseWooCallbackBody({ ...good, key_permissions: 'read' }, REQUEST_ID)).toBeNull();
  });

  it('rejects malformed credentials', () => {
    expect(parseWooCallbackBody({ ...good, consumer_key: 'nope' }, REQUEST_ID)).toBeNull();
    expect(parseWooCallbackBody({ ...good, consumer_secret: 42 }, REQUEST_ID)).toBeNull();
    expect(parseWooCallbackBody(null, REQUEST_ID)).toBeNull();
    expect(parseWooCallbackBody('a string', REQUEST_ID)).toBeNull();
  });
});

describe('wooCreateKeyUrl', () => {
  it('deep links straight to the create-key form', () => {
    expect(wooCreateKeyUrl('https://mitienda.com')).toBe(
      'https://mitienda.com/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys&create-key=1',
    );
  });
});

describe('POST /api/integrations/woocommerce/callback/:state', () => {
  const state = 'a'.repeat(64);

  function callbackBody() {
    return {
      key_id: 7,
      user_id: REQUEST_ID,
      consumer_key: CONSUMER_KEY,
      consumer_secret: CONSUMER_SECRET,
      key_permissions: 'read_write',
    };
  }

  it('succeeds with NO Origin header — wp_safe_remote_post sends none', async () => {
    // If sameOriginGuard ever stopped letting Origin-less requests through,
    // the whole one-click flow would break silently. Pinned here on purpose.
    repoMocks.consumeSetupAuthRequest.mockResolvedValue({
      id: REQUEST_ID,
      store_origin: 'https://mitienda.com',
      created_by: STAFF.id,
    });
    const res = await request(app()).post(`/api/integrations/woocommerce/callback/${state}`).send(callbackBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(repoMocks.consumeSetupAuthRequest).toHaveBeenCalledWith('woocommerce', hashAuthState(state));
  });

  it('persists nothing — the credentials wait for an authenticated claim', async () => {
    repoMocks.consumeSetupAuthRequest.mockResolvedValue({
      id: REQUEST_ID,
      store_origin: 'https://mitienda.com',
      created_by: STAFF.id,
    });
    await request(app()).post(`/api/integrations/woocommerce/callback/${state}`).send(callbackBody());
    expect(repoMocks.upsertSettings).not.toHaveBeenCalled();
  });

  it('never echoes the credentials back', async () => {
    repoMocks.consumeSetupAuthRequest.mockResolvedValue({
      id: REQUEST_ID,
      store_origin: 'https://mitienda.com',
      created_by: STAFF.id,
    });
    const res = await request(app()).post(`/api/integrations/woocommerce/callback/${state}`).send(callbackBody());
    expect(JSON.stringify(res.body)).not.toContain(CONSUMER_SECRET);
  });

  it('404s an unknown, expired or already-redeemed nonce, with no distinguishing detail', async () => {
    repoMocks.consumeSetupAuthRequest.mockResolvedValue(null);
    const res = await request(app()).post(`/api/integrations/woocommerce/callback/${state}`).send(callbackBody());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('404s a malformed nonce without touching the database', async () => {
    const res = await request(app()).post('/api/integrations/woocommerce/callback/short').send(callbackBody());
    expect(res.status).toBe(404);
    expect(repoMocks.consumeSetupAuthRequest).not.toHaveBeenCalled();
  });

  it('rejects a payload whose user_id is not the minted request', async () => {
    repoMocks.consumeSetupAuthRequest.mockResolvedValue({
      id: REQUEST_ID,
      store_origin: 'https://mitienda.com',
      created_by: STAFF.id,
    });
    const res = await request(app())
      .post(`/api/integrations/woocommerce/callback/${state}`)
      .send({ ...callbackBody(), user_id: 'attacker' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/setup/woocommerce/authorize/:requestId/claim', () => {
  const state = 'c'.repeat(64);

  async function deliverCredentials() {
    repoMocks.consumeSetupAuthRequest.mockResolvedValue({
      id: REQUEST_ID,
      store_origin: 'https://mitienda.com',
      created_by: STAFF.id,
    });
    await request(app())
      .post(`/api/integrations/woocommerce/callback/${state}`)
      .send({
        key_id: 7,
        user_id: REQUEST_ID,
        consumer_key: CONSUMER_KEY,
        consumer_secret: CONSUMER_SECRET,
        key_permissions: 'read_write',
      });
  }

  it('verifies the credentials, then stores them encrypted', async () => {
    await deliverCredentials();
    repoMocks.getSetupAuthRequestStatus.mockResolvedValue({
      id: REQUEST_ID,
      expired: false,
      consumed: true,
      connected: false,
    });
    safeFetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ name: 'Remera azul' }]), { status: 200 }),
    );

    const res = await request(app())
      .post(`/api/setup/woocommerce/authorize/${REQUEST_ID}/claim`)
      .set('Cookie', await adminCookie())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sampleProductName: 'Remera azul' });
    expect(JSON.stringify(res.body)).not.toContain(CONSUMER_SECRET);

    const written = repoMocks.upsertSettings.mock.calls[0]?.[0] as Array<{ key: string; value: string }>;
    const byKey = Object.fromEntries(written.map((entry) => [entry.key, entry.value]));
    // The store URL comes from our own row, never from the callback body.
    expect(byKey['wc.url']).toBe('https://mitienda.com');
    expect(byKey['wc.consumer_key']).toMatch(/^enc:v/);
    expect(decryptSecret(byKey['wc.consumer_key']!)).toBe(CONSUMER_KEY);
    expect(decryptSecret(byKey['wc.consumer_secret']!)).toBe(CONSUMER_SECRET);
  });

  it('saves nothing when the credentials do not actually work', async () => {
    await deliverCredentials();
    repoMocks.getSetupAuthRequestStatus.mockResolvedValue({
      id: REQUEST_ID,
      expired: false,
      consumed: true,
      connected: false,
    });
    safeFetchMock.mockResolvedValue(new Response('nope', { status: 401 }));

    const res = await request(app())
      .post(`/api/setup/woocommerce/authorize/${REQUEST_ID}/claim`)
      .set('Cookie', await adminCookie())
      .send({});

    expect(res.body.ok).toBe(false);
    expect(repoMocks.upsertSettings).not.toHaveBeenCalled();
  });

  it('is single-use: a second claim finds nothing left', async () => {
    await deliverCredentials();
    repoMocks.getSetupAuthRequestStatus.mockResolvedValue({
      id: REQUEST_ID,
      expired: false,
      consumed: true,
      connected: false,
    });
    safeFetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await request(app())
      .post(`/api/setup/woocommerce/authorize/${REQUEST_ID}/claim`)
      .set('Cookie', await adminCookie())
      .send({});
    const second = await request(app())
      .post(`/api/setup/woocommerce/authorize/${REQUEST_ID}/claim`)
      .set('Cookie', await adminCookie())
      .send({});

    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'woo_auth_not_delivered' });
  });

  it('requires an authenticated administrator', async () => {
    const res = await request(app()).post(`/api/setup/woocommerce/authorize/${REQUEST_ID}/claim`).send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /api/setup/woocommerce/authorize', () => {
  it('offers the one-click flow when the deployment is public HTTPS', async () => {
    // WordPress REST index: WooCommerce present, pretty permalinks working.
    safeFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ name: 'Mi Tienda', namespaces: ['wp/v2', 'wc/v3'] }), { status: 200 }),
    );
    const res = await request(app())
      .post('/api/setup/woocommerce/authorize')
      .set('Cookie', await adminCookie())
      .send({ url: 'mitienda.com' });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('oauth');
    expect(res.body.authorizeUrl).toContain('/wc-auth/v1/authorize');
    expect(res.body.createKeyUrl).toContain('create-key=1');
    expect(repoMocks.createSetupAuthRequest).toHaveBeenCalledOnce();
  });

  it('falls back to the manual flow when our own origin is not publicly reachable', async () => {
    // An HTTPS origin that resolves to a private address passes WooCommerce's
    // scheme check and then fails silently, because wp_safe_remote_post refuses
    // private destinations. Catching it here is what turns a mystery spinner
    // into a working manual flow.
    assertSafeRemoteUrlMock.mockImplementation(async (raw: string | URL) => {
      const url = new URL(String(raw));
      if (url.hostname === 'arix.example.com') throw new UnsafeRemoteUrlError('private');
      return url;
    });
    safeFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ name: 'Mi Tienda', namespaces: ['wc/v3'] }), { status: 200 }),
    );
    const res = await request(app())
      .post('/api/setup/woocommerce/authorize')
      .set('Cookie', await adminCookie())
      .send({ url: 'mitienda.com' });

    expect(res.body.mode).toBe('manual');
    expect(res.body.reason).toBe('no_public_https');
    // The manual path still gets everything it needs to be one click.
    expect(res.body.createKeyUrl).toContain('create-key=1');
    expect(repoMocks.createSetupAuthRequest).not.toHaveBeenCalled();
  });

  it('rejects a store URL the network policy forbids', async () => {
    assertSafeRemoteUrlMock.mockImplementation(async (raw: string | URL) => {
      const url = new URL(String(raw));
      if (url.hostname === 'mitienda.com') throw new UnsafeRemoteUrlError('private');
      return url;
    });
    const res = await request(app())
      .post('/api/setup/woocommerce/authorize')
      .set('Cookie', await adminCookie())
      .send({ url: 'mitienda.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsafe_store_url' });
  });

  it('falls back when the store uses plain permalinks, which the auth endpoint needs', async () => {
    safeFetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'Mi Tienda', namespaces: ['wc/v3'] }), { status: 200 }),
      );
    const res = await request(app())
      .post('/api/setup/woocommerce/authorize')
      .set('Cookie', await adminCookie())
      .send({ url: 'mitienda.com' });

    expect(res.body.mode).toBe('manual');
    expect(res.body.reason).toBe('plain_permalinks');
  });

  it('rejects a nonsense URL', async () => {
    const res = await request(app())
      .post('/api/setup/woocommerce/authorize')
      .set('Cookie', await adminCookie())
      .send({ url: 'ftp://x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_store_url' });
  });

  it('requires an administrator', async () => {
    const res = await request(app()).post('/api/setup/woocommerce/authorize').send({ url: 'mitienda.com' });
    expect(res.status).toBe(401);
  });
});
