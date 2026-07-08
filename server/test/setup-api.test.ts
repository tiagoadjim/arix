import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock at the repo boundary (same style as confirm-payment.test.ts / settings-runtime.test.ts)
// so no real Postgres connection is attempted.
const { countStaff, createFirstAdmin, getStaffById, getSettings, upsertSetting } = vi.hoisted(() => ({
  countStaff: vi.fn(),
  createFirstAdmin: vi.fn(),
  getStaffById: vi.fn(),
  getSettings: vi.fn(),
  upsertSetting: vi.fn(),
}));
vi.mock('../src/db/repo', () => ({ countStaff, createFirstAdmin, getStaffById, getSettings, upsertSetting }));

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
import { encryptSecret } from '../src/config/secret';
import type { WhatsAppGateway } from '../src/whatsapp/socket';

const STAFF = { id: 'staff-1', email: 'admin@example.com', password_hash: 'x', name: 'Admin' };

async function authCookie(): Promise<string> {
  const token = await signSession(STAFF);
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
  getStaffById.mockReset().mockResolvedValue(STAFF);
  getSettings.mockReset().mockResolvedValue({});
  upsertSetting.mockReset().mockResolvedValue(undefined);
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
  it('creates the first admin, sets the session cookie, and returns the staff DTO', async () => {
    createFirstAdmin.mockResolvedValue(STAFF);
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
      .send({ name: 'Admin', email: 'admin@example.com', password: 'longenough' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: STAFF.id, email: STAFF.email, name: STAFF.name });
    expect(res.headers['set-cookie']?.[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
  });

  it('returns 409 when staff already exists (createFirstAdmin lost the race / already done)', async () => {
    createFirstAdmin.mockResolvedValue(null);
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
      .send({ name: 'Admin', email: 'admin2@example.com', password: 'longenough' });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid email with 400 and never calls createFirstAdmin', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
      .send({ email: 'not-an-email', password: 'longenough' });
    expect(res.status).toBe(400);
    expect(createFirstAdmin).not.toHaveBeenCalled();
  });

  it('rejects a password shorter than 8 characters with 400', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .post('/api/setup/admin')
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
        .send({ email: 'admin4@example.com', password: 'longenough' });
    }
    expect(last!.status).toBe(429);
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        expect(String(url)).toContain('/wp-json/wc/v3/products');
        return { ok: true, status: 200, json: async () => [{ name: 'Sample Vape' }] };
      }),
    );
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
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createApiServer({ gateway: fakeGateway() });
    await request(app)
      .post('/api/setup/test/woocommerce')
      .set('Cookie', await authCookie())
      .send({ url: 'https://shop.example.com', consumerKey: 'ck_x', consumerSecret: 'cs_x' });
    const call = fetchMock.mock.calls[0] as [unknown, { headers: Record<string, string> }];
    expect(call[1].headers.Authorization).toBe(`Basic ${Buffer.from('ck_x:cs_x').toString('base64')}`);
  });

  it('returns ok:false with a safe error when the store rejects the credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
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

  it('restarts anyway when already connected and force=true is passed', async () => {
    const gateway = fakeGateway({ connected: true });
    const app = createApiServer({ gateway });
    const res = await request(app)
      .post('/api/whatsapp/restart')
      .set('Cookie', await authCookie())
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(gateway.restart).toHaveBeenCalledTimes(1);
  });

  it('restarts the gateway when not connected', async () => {
    const gateway = fakeGateway({ connected: false });
    const app = createApiServer({ gateway });
    const res = await request(app).post('/api/whatsapp/restart').set('Cookie', await authCookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(gateway.restart).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/settings', () => {
  it('requires authentication', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
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
    expect(upsertSetting).toHaveBeenCalledWith('info.payment', 'Transfer only');
  });

  it('accepts the new batch {updates: [...]} body and writes every key', async () => {
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
    expect(upsertSetting).toHaveBeenCalledWith('business.name', 'Acme');
    expect(upsertSetting).toHaveBeenCalledWith('agent.language', 'en');
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
      const call = upsertSetting.mock.calls.find((c) => c[0] === 'llm.api_key');
      expect(call?.[1]).toMatch(/^enc:v1:/);
      expect(call?.[1]).not.toContain('sk-new-key');
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
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it('rejects an env-locked key with 400 (wc.url is seeded by WC_URL in this test env)', async () => {
    const app = createApiServer({ gateway: fakeGateway() });
    const res = await request(app)
      .put('/api/settings')
      .set('Cookie', await authCookie())
      .send({ key: 'wc.url', value: 'https://evil.example.com' });
    expect(res.status).toBe(400);
    expect(res.body.keys).toContain('wc.url');
    expect(upsertSetting).not.toHaveBeenCalled();
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
    expect(upsertSetting).not.toHaveBeenCalled();
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
