import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock at the repo boundary (same style as confirm-payment.test.ts / settings-runtime.test.ts)
// so no real Postgres connection is attempted.
const {
  countStaff,
  createFirstAdmin,
  getStaffById,
  getSettings,
  upsertSetting,
  upsertSettings,
  createStaffStrict,
  insertAuditEvent,
  safeFetchMock,
} = vi.hoisted(
  () => ({
    countStaff: vi.fn(),
    createFirstAdmin: vi.fn(),
    getStaffById: vi.fn(),
    getSettings: vi.fn(),
    upsertSetting: vi.fn(),
    upsertSettings: vi.fn(),
    createStaffStrict: vi.fn(),
    insertAuditEvent: vi.fn(),
    safeFetchMock: vi.fn(),
  }),
);
vi.mock('../src/db/repo', () => ({
  countStaff,
  createFirstAdmin,
  getStaffById,
  getSettings,
  upsertSetting,
  upsertSettings,
  createStaffStrict,
  insertAuditEvent,
}));
vi.mock('../src/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/net/safe-fetch')>();
  return { ...actual, safeFetch: safeFetchMock };
});

// Mock the `openai` SDK constructor + create() call (same pattern as llm-client.test.ts)
// so POST /api/setup/test/llm never hits a real network endpoint.
const { create, OpenAIMock } = vi.hoisted(() => {
  const create = vi.fn();
  const OpenAIMock = vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
    __opts: opts,
    chat: { completions: { create } },
  }));
  return { create, OpenAIMock };
});
vi.mock('openai', () => ({ default: OpenAIMock }));

import { createApiServer } from '../src/api/server';
import { signSession, SESSION_COOKIE } from '../src/api/auth';
import { invalidate } from '../src/config/runtime';
import { MAX_LLM_COST_PER_MILLION_USD } from '../src/config/settings-schema';
import { decryptSecret, encryptSecret } from '../src/config/secret';
import type { WhatsAppGateway } from '../src/whatsapp/socket';

const STAFF = {
  id: 'staff-1',
  email: 'admin@example.com',
  password_hash: 'x',
  name: 'Admin',
  role: 'admin' as const,
  session_version: 0,
};
const AGENT_STAFF = {
  id: 'staff-2',
  email: 'agent@example.com',
  password_hash: 'x',
  name: 'Agent',
  role: 'agent' as const,
  session_version: 3,
};
// Must match config.SETUP_TOKEN. setup-env.ts seeds a default via ??=, but CI
// (and any other host) may already set SETUP_TOKEN — use the live env value.
const SETUP_TOKEN = process.env.SETUP_TOKEN!;

async function authCookie(staff: typeof STAFF | typeof AGENT_STAFF = STAFF): Promise<string> {
  const token = await signSession(staff);
  return `${SESSION_COOKIE}=${token}`;
}

function fakeGateway(over: Partial<{ connected: boolean; latestQR: string | null }> = {}) {
  return {
    connected: over.connected ?? false,
    latestQR: over.latestQR ?? null,
    sendText: vi.fn(),
    indicateTyping: vi.fn(),
    restart: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppGateway;
}

/** Temporarily set/unset env vars for the duration of `fn`, then restore — same
 * helper as settings-runtime.test.ts, needed because every secret key in this
 * suite's default test env is env-seeded (setup-env.ts), so exercising the
 * DB/write path for a secret requires unsetting its seed for that one test. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    const next = overrides[k];
    if (next === undefined) delete process.env[k];
    else process.env[k] = next;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      const restore = prev[k];
      if (restore === undefined) delete process.env[k];
      else process.env[k] = restore;
    }
  }
}

beforeEach(() => {
  countStaff.mockReset().mockResolvedValue(0);
  createFirstAdmin.mockReset();
  getStaffById.mockReset().mockImplementation(async (id: string) =>
    id === AGENT_STAFF.id ? AGENT_STAFF : STAFF,
  );
  getSettings.mockReset().mockResolvedValue({});
  upsertSetting.mockReset().mockResolvedValue(undefined);
  upsertSettings.mockReset().mockResolvedValue(undefined);
  createStaffStrict.mockReset();
  insertAuditEvent.mockReset().mockResolvedValue(undefined);
  safeFetchMock.mockReset().mockRejectedValue(new Error('Unexpected remote request in setup API test'));
  create.mockReset();
  OpenAIMock.mockClear();
  invalidate();
});

afterEach(() => {
  invalidate();
  vi.unstubAllGlobals();
});

describe('GET /health', () => {
  it('always returns 200, even when WhatsApp is not connected/paired yet', async () => {
    const app = createApiServer({ gateway: fakeGateway({ connected: false, latestQR: null }) });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', whatsapp: { connected: false, hasQr: false } });
  });

  it('reports whatsapp connection/QR state without ever going non-200', async () => {
    const app = createApiServer({ gateway: fakeGateway({ connected: true, latestQR: 'qr' }) });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', whatsapp: { connected: true, hasQr: true } });
  });

  it('requires no authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/health');
    expect(res.status).not.toBe(401);
  });
});

describe('GET /api/setup/status', () => {
  it('requires no authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/setup/status');
    expect(res.status).not.toBe(401);
  });

  it('reports needsSetup=true when no staff exists', async () => {
    countStaff.mockResolvedValue(0);
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
    expect(res.body.whatsapp).toEqual({ connected: false, hasQr: false });
  });

  it('reports needsSetup=false once at least one staff member exists', async () => {
    countStaff.mockResolvedValue(1);
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/setup/status');
    expect(res.body.needsSetup).toBe(false);
  });

  it('reports setupCompleted from the setup.completed setting', async () => {
    getSettings.mockResolvedValue({ 'setup.completed': 'true' });
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/setup/status');
    expect(res.body.setupCompleted).toBe(true);
  });

  it('reflects the whatsapp connection/QR state', async () => {
    const app = createApiServer({ gateway: fakeGateway({ connected: true, latestQR: null }) });
    const res = await request(app).get('/api/setup/status');
    expect(res.body.whatsapp).toEqual({ connected: true, hasQr: false });
  });
});

describe('POST /api/setup/admin', () => {
  it('rejects a missing or incorrect setup token without echoing it or touching staff state', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const missing = await request(app)
      .post('/api/setup/admin')
      .send({ email: 'admin@example.com', password: 'longenough' });
    const submitted = 'wrong-setup-token-that-must-never-be-echoed';
    const incorrect = await request(app)
      .post('/api/setup/admin')
      .set('X-Setup-Token', submitted)
      .send({ email: 'admin@example.com', password: 'longenough' });

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(missing.body).toEqual({ error: 'invalid_setup_token' });
    expect(incorrect.body).toEqual({ error: 'invalid_setup_token' });
    expect(JSON.stringify(incorrect.body)).not.toContain(submitted);
    expect(countStaff).not.toHaveBeenCalled();
    expect(createFirstAdmin).not.toHaveBeenCalled();
  });

  it('creates the first admin, sets the session cookie, and returns the staff DTO', async () => {
    createFirstAdmin.mockResolvedValue(STAFF);
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
      .set('X-Setup-Token', SETUP_TOKEN)
      .send({ name: 'Admin', email: 'admin@example.com', password: 'longenough' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: STAFF.id, email: STAFF.email, name: STAFF.name, role: 'admin' });
    expect(res.headers['set-cookie']?.[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'staff.bootstrap_admin', targetId: STAFF.id }),
    );
  });

  it('is disabled after any staff account exists, even with the valid setup token', async () => {
    countStaff.mockResolvedValue(1);
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
      .set('X-Setup-Token', SETUP_TOKEN)
      .send({ name: 'Admin', email: 'second@example.com', password: 'longenough' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'setup_already_completed' });
    expect(createFirstAdmin).not.toHaveBeenCalled();
  });

  it('returns 409 when staff already exists (createFirstAdmin lost the race / already done)', async () => {
    createFirstAdmin.mockResolvedValue(null);
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
      .set('X-Setup-Token', SETUP_TOKEN)
      .send({ name: 'Admin', email: 'admin2@example.com', password: 'longenough' });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid email with 400 and never calls createFirstAdmin', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
      .set('X-Setup-Token', SETUP_TOKEN)
      .send({ email: 'not-an-email', password: 'longenough' });
    expect(res.status).toBe(400);
    expect(createFirstAdmin).not.toHaveBeenCalled();
  });

  it('rejects a password shorter than 8 characters with 400', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
      .set('X-Setup-Token', SETUP_TOKEN)
      .send({ email: 'admin3@example.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(createFirstAdmin).not.toHaveBeenCalled();
  });

  // Runs last within this block: the login-throttle map is shared, in-memory,
  // module-level state (by design — same mechanism POST /api/auth/login uses),
  // so this uses a generous attempt count to be robust to a small number of
  // fails already recorded by the tests above rather than depending on exact
  // ordering.
  it('rate-limits after repeated failed/rejected attempts (reuses the login throttle)', async () => {
    createFirstAdmin.mockResolvedValue(null); // every attempt "loses" — worst case for a legit user
    const app = createApiServer({ gateway: fakeGateway() });
    let last;
    for (let i = 0; i < 15; i += 1) {
      last = await request(app)
        .post('/api/setup/admin')
        .set('X-Setup-Token', SETUP_TOKEN)
        .send({ email: 'admin4@example.com', password: 'longenough' });
    }
    expect(last!.status).toBe(429);
  });
});

describe('authenticated sessions and RBAC', () => {
  it('returns the database-backed role and session version from /api/me', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/me').set('Cookie', await authCookie(AGENT_STAFF));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: AGENT_STAFF.id,
      email: AGENT_STAFF.email,
      role: 'agent',
      sessionVersion: 3,
    });
  });

  it('revokes a validly signed cookie when staff.session_version has changed', async () => {
    getStaffById.mockResolvedValueOnce({ ...STAFF, session_version: STAFF.session_version + 1 });
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/me').set('Cookie', await authCookie(STAFF));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(res.headers['set-cookie']?.[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it('does not grant an authenticated agent access to pairing administration', async () => {
    const app = createApiServer({ gateway: fakeGateway({ latestQR: 'qr' }) });
    const res = await request(app)
      .get('/api/whatsapp/status')
      .set('Cookie', await authCookie(AGENT_STAFF));
    expect(res.status).toBe(403);
  });

  it('returns 403 for every administrative surface when the current DB role is agent', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const cookie = await authCookie(AGENT_STAFF);
    const responses = await Promise.all([
      request(app).get('/api/settings').set('Cookie', cookie),
      request(app).put('/api/settings').set('Cookie', cookie).send({ key: 'business.name', value: 'Nope' }),
      request(app).post('/api/staff').set('Cookie', cookie).send({ email: 'x@example.com', password: 'longenough' }),
      request(app).post('/api/whatsapp/restart').set('Cookie', cookie),
      request(app).post('/api/setup/test/llm').set('Cookie', cookie).send({ provider: 'openai', apiKey: 'sk-x' }),
      request(app)
        .post('/api/setup/test/woocommerce')
        .set('Cookie', cookie)
        .send({ url: 'https://shop.example.com', consumerKey: 'ck', consumerSecret: 'cs' }),
      request(app).post('/api/setup/complete').set('Cookie', cookie),
      request(app).get('/api/qr').set('Cookie', cookie),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
    }
    expect(upsertSetting).not.toHaveBeenCalled();
    expect(upsertSettings).not.toHaveBeenCalled();
    expect(createStaffStrict).not.toHaveBeenCalled();
  });
});

describe('POST /api/setup/test/llm', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).post('/api/setup/test/llm').send({ provider: 'openai', apiKey: 'sk-x' });
    expect(res.status).toBe(401);
  });

  it('returns ok + model + vision on a successful ping, without persisting or echoing the key', async () => {
    create.mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'pong' } }] });
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/llm')
      .set('Cookie', await authCookie())
      .send({ provider: 'openai', apiKey: 'sk-test-key-value' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vision).toBe(true);
    expect(res.body.model).toBe('gpt-5.4-mini');
    expect(upsertSetting).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('sk-test-key-value');
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test-key-value', baseURL: 'https://api.openai.com/v1' }),
    );
  });

  it('uses posted model/baseUrl overrides and reports the correct vision capability per provider', async () => {
    create.mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'pong' } }] });
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/llm')
      .set('Cookie', await authCookie())
      .send({ provider: 'deepseek', apiKey: 'sk-x', model: 'custom-model', baseUrl: 'https://custom.example.com/v1' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('custom-model');
    expect(res.body.vision).toBe(false); // deepseek never supports vision
    expect(OpenAIMock).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://custom.example.com/v1' }));
  });

  it('tests the complete persisted LLM configuration and ignores hostile posted routing fields', async () => {
    create.mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'pong' } }] });
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/llm')
      .set('Cookie', await authCookie())
      .send({
        provider: 'openai',
        apiKey: 'attacker-key',
        model: 'attacker-model',
        baseUrl: 'https://attacker.example/v1',
        useStored: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.model).not.toBe('attacker-model');
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'test-key', baseURL: 'https://api.minimax.io/v1' }),
    );
    expect(OpenAIMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'attacker-key', baseURL: 'https://attacker.example/v1' }),
    );
    expect(JSON.stringify(res.body)).not.toContain('test-key');
  });

  it('returns ok:false with a safe error message (never echoing the key) when the provider rejects it', async () => {
    create.mockRejectedValue(Object.assign(new Error('Incorrect API key provided: sk-test-key-value'), { status: 401 }));
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/llm')
      .set('Cookie', await authCookie())
      .send({ provider: 'openai', apiKey: 'sk-test-key-value' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.error).not.toContain('sk-test-key-value');
  });

  it('rejects an unknown provider with 400', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/llm')
      .set('Cookie', await authCookie())
      .send({ provider: 'not-a-real-provider', apiKey: 'sk-x' });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('POST /api/setup/test/woocommerce', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/woocommerce')
      .send({ url: 'https://shop.example.com', consumerKey: 'ck', consumerSecret: 'cs' });
    expect(res.status).toBe(401);
  });

  it('returns ok + sampleProductName on a successful probe, without persisting', async () => {
    safeFetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const sent = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      expect(sent.url).toContain('/wp-json/wc/v3/products');
      return new Response(JSON.stringify([{ name: 'Sample Vape' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/woocommerce')
      .set('Cookie', await authCookie())
      .send({ url: 'https://shop.example.com', consumerKey: 'ck_x', consumerSecret: 'cs_x' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sampleProductName: 'Sample Vape' });
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it('sends Basic auth built from the posted (unpersisted) consumer key/secret', async () => {
    safeFetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    const app = createApiServer({ gateway: fakeGateway() });
    await request(app)
      .post('/api/setup/test/woocommerce')
      .set('Cookie', await authCookie())
      .send({ url: 'https://shop.example.com', consumerKey: 'ck_x', consumerSecret: 'cs_x' });
    const [input, init] = safeFetchMock.mock.calls[0] ?? [];
    const sentRequest = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    expect(sentRequest.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('ck_x:cs_x').toString('base64')}`,
    );
  });

  it('tests the persisted WooCommerce configuration and ignores hostile posted routing fields', async () => {
    safeFetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/woocommerce')
      .set('Cookie', await authCookie())
      .send({
        url: 'https://attacker.example',
        consumerKey: 'attacker-key',
        consumerSecret: 'attacker-secret',
        useStored: true,
      });

    expect(res.status).toBe(200);
    const [input, init] = safeFetchMock.mock.calls[0] ?? [];
    const sentRequest = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    expect(new URL(sentRequest.url).origin).toBe('https://shop.example.com');
    expect(sentRequest.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('ck_test:cs_test').toString('base64')}`,
    );
    expect(JSON.stringify(res.body)).not.toContain('ck_test');
    expect(JSON.stringify(res.body)).not.toContain('cs_test');
  });

  it('returns ok:false with a safe error when the store rejects the credentials', async () => {
    safeFetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/woocommerce')
      .set('Cookie', await authCookie())
      .send({ url: 'https://shop.example.com', consumerKey: 'bad', consumerSecret: 'bad' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects a missing url/consumerKey/consumerSecret with 400', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/test/woocommerce')
      .set('Cookie', await authCookie())
      .send({ url: '', consumerKey: '', consumerSecret: '' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/whatsapp/status', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/whatsapp/status');
    expect(res.status).toBe(401);
  });

  it('reports connected + hasQr from the gateway', async () => {
    const app = createApiServer({ gateway: fakeGateway({ connected: false, latestQR: 'qr-data' }) });
    const res = await request(app).get('/api/whatsapp/status').set('Cookie', await authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, hasQr: true });
  });
});

describe('POST /api/whatsapp/restart', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).post('/api/whatsapp/restart');
    expect(res.status).toBe(401);
  });

  it('returns 409 when already connected and force is not set', async () => {
    const gateway = fakeGateway({ connected: true });
    const app = createApiServer({ gateway });
    const res = await request(app).post('/api/whatsapp/restart').set('Cookie', await authCookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_connected');
    expect(gateway.restart).not.toHaveBeenCalled();
  });

  it('restarts anyway when already connected and force=true is passed — with clearSession (real re-pair)', async () => {
    const gateway = fakeGateway({ connected: true });
    const app = createApiServer({ gateway });
    const res = await request(app)
      .post('/api/whatsapp/restart')
      .set('Cookie', await authCookie())
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(gateway.restart).toHaveBeenCalledTimes(1);
    expect(gateway.restart).toHaveBeenCalledWith({ clearSession: true });
  });

  it('restarts the gateway when not connected — without clearSession (just refreshes the pending QR)', async () => {
    const gateway = fakeGateway({ connected: false });
    const app = createApiServer({ gateway });
    const res = await request(app).post('/api/whatsapp/restart').set('Cookie', await authCookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(gateway.restart).toHaveBeenCalledTimes(1);
    expect(gateway.restart).toHaveBeenCalledWith({});
  });

  it('force-clears persisted auth even when the transport is disconnected', async () => {
    const gateway = fakeGateway({ connected: false });
    const app = createApiServer({ gateway });
    const res = await request(app)
      .post('/api/whatsapp/restart')
      .set('Cookie', await authCookie())
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(gateway.restart).toHaveBeenCalledWith({ clearSession: true });
  });
});

describe('GET /api/settings', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('requires an administrator role', async () => {
    getStaffById.mockResolvedValue(AGENT_STAFF);
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/settings').set('Cookie', await authCookie(AGENT_STAFF));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('never leaks a DB-sourced secret in plaintext, anywhere in the response', async () => {
    await withEnv({ LLM_API_KEY: undefined }, async () => {
      getSettings.mockResolvedValue({ 'llm.api_key': encryptSecret('sk-must-not-leak') });
      invalidate();
      const app = createApiServer({ gateway: fakeGateway() });
      const res = await request(app).get('/api/settings').set('Cookie', await authCookie());
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('sk-must-not-leak');
      const apiKeyDto = res.body.llm.find((d: { key: string }) => d.key === 'llm.api_key');
      expect(apiKeyDto.value).toBeNull();
      expect(apiKeyDto.set).toBe(true);
      expect(apiKeyDto.source).toBe('db');
      expect(apiKeyDto.readOnly).toBe(false);
    });
  });

  it('never leaks an env-sourced secret either, and marks it read-only', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/settings').set('Cookie', await authCookie());
    expect(res.status).toBe(200);
    const apiKeyDto = res.body.llm.find((d: { key: string }) => d.key === 'llm.api_key');
    expect(apiKeyDto.value).toBeNull();
    expect(apiKeyDto.source).toBe('env');
    expect(apiKeyDto.readOnly).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('test-key');
  });

  it('returns a non-secret value grouped under its schema group', async () => {
    getSettings.mockResolvedValue({ 'business.name': 'Acme Vapes' });
    invalidate();
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/settings').set('Cookie', await authCookie());
    const nameDto = res.body.business.find((d: { key: string }) => d.key === 'business.name');
    expect(nameDto).toMatchObject({ value: 'Acme Vapes', source: 'db', readOnly: false, set: true, secret: false });
  });
});

describe('administrative authorization', () => {
  it('blocks regular staff from setup and WhatsApp control endpoints', async () => {
    getStaffById.mockResolvedValue(AGENT_STAFF);
    const app = createApiServer({ gateway: fakeGateway() });
    const cookie = await authCookie(AGENT_STAFF);
    const [qr, status, complete] = await Promise.all([
      request(app).get('/api/qr').set('Cookie', cookie),
      request(app).get('/api/whatsapp/status').set('Cookie', cookie),
      request(app).post('/api/setup/complete').set('Cookie', cookie),
    ]);
    for (const response of [qr, status, complete]) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'forbidden' });
    }
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});

describe('PUT /api/settings', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).put('/api/settings').send({ key: 'business.name', value: 'Acme' });
    expect(res.status).toBe(401);
  });

  it('accepts the legacy single {key, value} body for backward compat with the pre-Phase-7 dashboard', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .put('/api/settings')
      .set('Cookie', await authCookie())
      .send({ key: 'info.payment', value: 'Transfer only' });
    expect(res.status).toBe(200);
    expect(upsertSettings).toHaveBeenCalledOnce();
    expect(upsertSettings).toHaveBeenCalledWith([
      { key: 'info.payment', value: 'Transfer only' },
    ]);
  });

  it('passes the whole validated batch to the transactional repository method exactly once', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .put('/api/settings')
      .set('Cookie', await authCookie())
      .send({
        updates: [
          { key: 'business.name', value: 'Acme' },
          { key: 'agent.language', value: 'en' },
        ],
      });
    expect(res.status).toBe(200);
    expect(upsertSettings).toHaveBeenCalledOnce();
    expect(upsertSettings).toHaveBeenCalledWith([
      { key: 'business.name', value: 'Acme' },
      { key: 'agent.language', value: 'en' },
    ]);
    expect(insertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.updated',
        metadata: { keys: ['business.name', 'agent.language'] },
      }),
    );
  });

  it('encrypts MCP headers at rest', async () => {
    await withEnv({ MCP_SERVERS: undefined }, async () => {
      const app = createApiServer({ gateway: fakeGateway() });
      const value = [
        {
          id: 'remote',
          name: 'Remote',
          enabled: true,
          transport: 'http',
          url: 'https://8.8.8.8/mcp',
          headers: { Authorization: 'Bearer secret-token' },
          allowedTools: [],
        },
      ];
      const res = await request(app)
        .put('/api/settings')
        .set('Cookie', await authCookie())
        .send({ key: 'mcp.servers', value });
      expect(res.status).toBe(200);
      const entries = upsertSettings.mock.calls[0]?.[0] as Array<{ key: string; value: string }>;
      const stored = entries.find((entry) => entry.key === 'mcp.servers')?.value;
      expect(stored).toMatch(/^enc:v2:[A-Za-z0-9_-]{12}:/);
      expect(stored).toBeTypeOf('string');
      if (!stored) throw new Error('mcp.servers was not persisted');
      expect(stored).not.toContain('secret-token');
      expect(decryptSecret(stored)).toContain('secret-token');
    });
  });

  it('rejects stdio MCP and private-network URLs', async () => {
    await withEnv({ MCP_SERVERS: undefined }, async () => {
      const app = createApiServer({ gateway: fakeGateway() });
      const stdio = await request(app)
        .put('/api/settings')
        .set('Cookie', await authCookie())
        .send({
          key: 'mcp.servers',
          value: [{ id: 'local', transport: 'stdio', command: '/bin/sh', args: ['-c', 'id'] }],
        });
      expect(stdio.status).toBe(400);
      expect(stdio.body.error).toBe('invalid_mcp_config');

      const privateUrl = await request(app)
        .put('/api/settings')
        .set('Cookie', await authCookie())
        .send({
          key: 'mcp.servers',
          value: [
            {
              id: 'metadata',
              transport: 'http',
              url: 'https://169.254.169.254/latest',
              allowedTools: [],
            },
          ],
        });
      expect(privateUrl.status).toBe(400);
      expect(privateUrl.body.error).toBe('unsafe_mcp_url');
      expect(upsertSetting).not.toHaveBeenCalledWith('mcp.servers', expect.anything());
    });
  });

  it('encrypts a secret value before storing it (once its env seed is not set)', async () => {
    await withEnv({ LLM_API_KEY: undefined }, async () => {
      invalidate();
      const app = createApiServer({ gateway: fakeGateway() });
      const res = await request(app)
        .put('/api/settings')
        .set('Cookie', await authCookie())
        .send({ key: 'llm.api_key', value: 'sk-new-key' });
      expect(res.status).toBe(200);
      const entries = upsertSettings.mock.calls[0]?.[0] as Array<{ key: string; value: string }>;
      const stored = entries.find((entry) => entry.key === 'llm.api_key')?.value;
      expect(stored).toMatch(/^enc:v2:[A-Za-z0-9_-]{12}:/);
      expect(stored).not.toContain('sk-new-key');
    });
  });

  it('skips a secret key posted with an empty value — keeps the stored value untouched and still returns ok', async () => {
    await withEnv({ LLM_API_KEY: undefined }, async () => {
      invalidate();
      const app = createApiServer({ gateway: fakeGateway() });
      const res = await request(app)
        .put('/api/settings')
        .set('Cookie', await authCookie())
        .send({ key: 'llm.api_key', value: '' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(upsertSettings).toHaveBeenCalledWith([]);
    });
  });

  it('still overwrites a secret key when a non-empty value is posted', async () => {
    await withEnv({ LLM_API_KEY: undefined }, async () => {
      invalidate();
      const app = createApiServer({ gateway: fakeGateway() });
      const res = await request(app)
        .put('/api/settings')
        .set('Cookie', await authCookie())
        .send({ key: 'llm.api_key', value: 'sk-new-key' });
      expect(res.status).toBe(200);
      const entries = upsertSettings.mock.calls[0]?.[0] as Array<{ key: string; value: string }>;
      expect(entries.some((entry) => entry.key === 'llm.api_key')).toBe(true);
    });
  });

  it('rejects an unknown key with 400 and writes nothing', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .put('/api/settings')
      .set('Cookie', await authCookie())
      .send({ key: 'not.a.real.key', value: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.keys).toContain('not.a.real.key');
    expect(upsertSettings).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range numeric setting with 400 and writes nothing', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .put('/api/settings')
      .set('Cookie', await authCookie())
      .send({ key: 'llm.input_cost_per_million', value: MAX_LLM_COST_PER_MILLION_USD + 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_settings_values',
      keys: ['llm.input_cost_per_million'],
    });
    expect(upsertSettings).not.toHaveBeenCalled();
  });

  it('rejects an env-locked key with 400 (wc.url is seeded by WC_URL in this test env)', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .put('/api/settings')
      .set('Cookie', await authCookie())
      .send({ key: 'wc.url', value: 'https://evil.example.com' });
    expect(res.status).toBe(400);
    expect(res.body.keys).toContain('wc.url');
    expect(upsertSettings).not.toHaveBeenCalled();
  });

  it('rejects the WHOLE batch (all-or-nothing) when only one of several keys is invalid', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .put('/api/settings')
      .set('Cookie', await authCookie())
      .send({
        updates: [
          { key: 'business.name', value: 'Acme' },
          { key: 'not.a.real.key', value: 'x' },
        ],
      });
    expect(res.status).toBe(400);
    expect(upsertSettings).not.toHaveBeenCalled();
  });

  it('calls invalidate() so a subsequent read reflects the write (no restart needed)', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    getSettings.mockResolvedValue({});
    await request(app)
      .put('/api/settings')
      .set('Cookie', await authCookie())
      .send({ key: 'business.name', value: 'Acme After Write' });
    getSettings.mockResolvedValue({ 'business.name': 'Acme After Write' });
    const res = await request(app).get('/api/settings').set('Cookie', await authCookie());
    const nameDto = res.body.business.find((d: { key: string }) => d.key === 'business.name');
    expect(nameDto.value).toBe('Acme After Write');
  });
});

describe('POST /api/staff', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/staff')
      .send({ email: 'new@example.com', password: 'longenough' });
    expect(res.status).toBe(401);
  });

  it('creates an agent by default and returns its role in the staff DTO', async () => {
    createStaffStrict.mockResolvedValue({
      id: 'staff-2',
      email: 'new@example.com',
      name: 'New',
      password_hash: 'x',
      role: 'agent',
      session_version: 0,
    });
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/staff')
      .set('Cookie', await authCookie())
      .send({ name: 'New', email: 'new@example.com', password: 'longenough' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'staff-2', email: 'new@example.com', name: 'New', role: 'agent' });
    expect(createStaffStrict).toHaveBeenCalledWith(
      'new@example.com',
      expect.any(String),
      'New',
      'agent',
    );
  });

  it('allows an administrator to create another administrator explicitly', async () => {
    createStaffStrict.mockResolvedValue({
      id: 'staff-3',
      email: 'admin2@example.com',
      name: 'Admin 2',
      password_hash: 'x',
      role: 'admin',
      session_version: 0,
    });
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/staff')
      .set('Cookie', await authCookie())
      .send({ name: 'Admin 2', email: 'admin2@example.com', password: 'longenough', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('admin');
    expect(createStaffStrict).toHaveBeenCalledWith(
      'admin2@example.com',
      expect.any(String),
      'Admin 2',
      'admin',
    );
  });

  it('returns 409 with {error: "staff_exists"} on a duplicate email, and leaves the original row untouched', async () => {
    createStaffStrict.mockResolvedValue(null); // ON CONFLICT DO NOTHING → no row
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/staff')
      .set('Cookie', await authCookie())
      .send({ name: 'Dup', email: 'admin@example.com', password: 'longenough' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'staff_exists' });
  });
});

describe('POST /api/setup/complete', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).post('/api/setup/complete');
    expect(res.status).toBe(401);
  });

  it('marks setup.completed = true and invalidates the cache', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).post('/api/setup/complete').set('Cookie', await authCookie());
    expect(res.status).toBe(200);
    expect(upsertSetting).toHaveBeenCalledWith('setup.completed', 'true');
  });
});

describe('GET /api/qr', () => {
  it('still requires authentication (unchanged from before Phase 6)', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/qr');
    expect(res.status).toBe(401);
  });
});
