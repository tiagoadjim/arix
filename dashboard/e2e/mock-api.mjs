import { createServer } from 'node:http';
import { SignJWT } from 'jose';

const HOST = '127.0.0.1';
const PORT = 3101;
const AUTH_SECRET = 'e2e-auth-secret-at-least-32-characters';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

const schedule = [null, null, null, null, null, null, null];

function setting(key, group, value, type = 'string', secret = false) {
  return {
    key,
    group,
    type,
    label: key,
    value: secret ? null : value,
    set: secret ? Boolean(value) : true,
    source: 'db',
    readOnly: false,
    secret,
  };
}

function groupedSettings() {
  return {
    llm: [
      setting('llm.provider', 'llm', 'openai', 'enum'),
      setting('llm.api_key', 'llm', '', 'string', true),
      setting('llm.model', 'llm', 'gpt-4.1-mini'),
      setting('llm.base_url', 'llm', ''),
      setting('llm.reasoning_split', 'llm', false, 'boolean'),
      setting('llm.thinking_disabled', 'llm', false, 'boolean'),
      setting('llm.vision_fallback', 'llm', 'ask_details', 'enum'),
    ],
    wc: [
      setting('wc.url', 'wc', 'https://shop.example.com'),
      setting('wc.consumer_key', 'wc', '', 'string', true),
      setting('wc.consumer_secret', 'wc', '', 'string', true),
      setting('wc.front_url', 'wc', 'https://shop.example.com'),
      setting('wc.currency', 'wc', 'USD'),
      setting('wc.status_after_payment', 'wc', 'processing'),
      setting('wc.status_after_dispatch', 'wc', ''),
      setting('wc.product_link_template', 'wc', '{base}/product/{slug}'),
    ],
    payment: [
      setting('payment.tolerance', 'payment', 1, 'number'),
      setting('payment.auto_confirm', 'payment', false, 'boolean'),
    ],
    setup: [
      setting('setup.completed', 'setup', false, 'boolean'),
      setting('setup.step', 'setup', 0, 'number'),
    ],
    business: [
      setting('business.name', 'business', 'Demo Store'),
      setting('business.timezone', 'business', 'America/Argentina/Buenos_Aires'),
      setting('business.hours', 'business', schedule, 'json'),
    ],
    agent: [
      setting('agent.name', 'agent', 'Arix'),
      setting('agent.language', 'agent', 'en', 'enum'),
      setting('agent.disclose_bot', 'agent', true, 'boolean'),
    ],
    info: [
      setting('info.payment', 'info', ''),
      setting('info.shipping', 'info', ''),
      setting('info.general', 'info', ''),
    ],
    dispatch: [setting('dispatch.template', 'dispatch', '')],
    compliance: [setting('compliance.rules', 'compliance', '')],
  };
}

function conversation() {
  return {
    id: CONVERSATION_ID,
    account_id: 'default',
    wa_jid: '5491112345678@s.whatsapp.net',
    phone: '5491112345678',
    customer_name: 'Ada Customer',
    customer_email: 'ada@example.com',
    mode: 'bot',
    assigned_to: null,
    status: 'open',
    escalation_reason: null,
    unread_count: 2,
    last_message_at: '2026-07-10T12:00:00.000Z',
    last_message_preview: 'Do you have this in stock?',
    created_at: '2026-07-10T11:55:00.000Z',
    updated_at: '2026-07-10T12:00:00.000Z',
  };
}

function message() {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    conversation_id: CONVERSATION_ID,
    account_id: 'default',
    direction: 'in',
    sender: 'customer',
    wa_message_id: 'wamid.e2e',
    msg_type: 'text',
    body: 'Do you have this in stock?',
    media_url: null,
    media_mime: null,
    send_status: null,
    sent_by: null,
    error: null,
    client_id: null,
    created_at: '2026-07-10T12:00:00.000Z',
  };
}

function freshState(overrides = {}) {
  return {
    needsSetup: false,
    setupCompleted: true,
    adminEmail: 'admin@example.com',
    adminPassword: 'password123',
    loginRole: 'admin',
    conversations: [conversation()],
    messages: [message()],
    settings: groupedSettings(),
    lastSettingsUpdate: [],
    setupStep: 0,
    wooAuthMode: 'manual',
    wooAuthStatus: 'delivered',
    scanTicks: 0,
    ...overrides,
  };
}

let state = freshState();
const streams = new Set();

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function sessionCookie(role = 'admin') {
  const token = await new SignJWT({ role, sv: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('33333333-3333-4333-8333-333333333333')
    .setIssuer('arix-server')
    .setAudience('arix-dashboard')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(AUTH_SECRET));
  return `arix_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;
}

function updateSettings(updates) {
  state.lastSettingsUpdate = updates;
  for (const update of updates) {
    for (const entries of Object.values(state.settings)) {
      const entry = entries.find((candidate) => candidate.key === update.key);
      if (!entry) continue;
      if (entry.secret) entry.set = Boolean(String(update.value ?? '').trim());
      else entry.value = update.value;
    }
  }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/__e2e/health') return json(res, 200, { ok: true });
  if (pathname === '/__e2e/reset' && method === 'POST') {
    state = freshState(await readJson(req));
    return json(res, 200, { ok: true });
  }
  if (pathname === '/__e2e/state') return json(res, 200, state);

  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(': e2e stream connected\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }

  if (pathname === '/api/setup/status' && method === 'GET') {
    return json(res, 200, {
      needsSetup: state.needsSetup,
      setupCompleted: state.setupCompleted,
      step: state.setupStep,
      whatsapp: { connected: false, hasQr: true },
    });
  }

  if (pathname === '/api/setup/test/llm' && method === 'POST') {
    return json(res, 200, { ok: true, model: 'gpt-4.1-mini', vision: true });
  }

  if (pathname === '/api/setup/test/woocommerce' && method === 'POST') {
    return json(res, 200, { ok: true, sampleProductName: 'Demo Product' });
  }

  // ---- one-click store connection ----
  // `wooAuthMode` drives which branch the wizard renders. 'manual' is the
  // default because it is the branch a local install always takes, and the one
  // a shop owner is most likely to see.
  if (pathname === '/api/setup/woocommerce/authorize' && method === 'POST') {
    const body = await readJson(req);
    const storeBase = /^https?:\/\//.test(body.url ?? '') ? body.url.replace(/\/$/, '') : `https://${body.url ?? ''}`;
    const createKeyUrl = `${storeBase}/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys&create-key=1`;
    const probe = { reachable: true, wordpress: true, woocommerce: true, prettyPermalinks: true, name: 'Demo Store' };
    if (state.wooAuthMode === 'oauth') {
      return json(res, 200, {
        mode: 'oauth',
        storeBase,
        probe,
        createKeyUrl,
        requestId: '44444444-4444-4444-8444-444444444444',
        authorizeUrl: `${storeBase}/wc-auth/v1/authorize`,
        expiresInSeconds: 600,
      });
    }
    return json(res, 200, { mode: 'manual', reason: 'no_public_https', storeBase, probe, createKeyUrl });
  }

  if (pathname.startsWith('/api/setup/woocommerce/authorize/') && pathname.endsWith('/status') && method === 'GET') {
    return json(res, 200, { status: state.wooAuthStatus ?? 'delivered' });
  }

  if (pathname.startsWith('/api/setup/woocommerce/authorize/') && pathname.endsWith('/claim') && method === 'POST') {
    return json(res, 200, { ok: true, storeBase: 'https://shop.example.com', sampleProductName: 'Demo Product' });
  }

  // ---- site scan ----
  if (pathname === '/api/setup/site-scan' && method === 'POST') {
    state.scanTicks = 0;
    return json(res, 202, { id: '55555555-5555-4555-8555-555555555555' });
  }

  if (pathname.startsWith('/api/setup/site-scan/') && method === 'GET') {
    // One crawling tick, then the result — enough for the UI to render both
    // states without making the test wait on a real timer.
    state.scanTicks = (state.scanTicks ?? 0) + 1;
    if (state.scanTicks < 2) {
      return json(res, 200, {
        id: '55555555-5555-4555-8555-555555555555',
        state: 'crawling',
        root: 'https://shop.example.com',
        progress: { pagesFound: 4, pagesFetched: 1, maxPages: 25, currentUrl: 'https://shop.example.com/shipping' },
        result: null,
        error: null,
      });
    }
    return json(res, 200, {
      id: '55555555-5555-4555-8555-555555555555',
      state: 'done',
      root: 'https://shop.example.com',
      progress: { pagesFound: 4, pagesFetched: 4, maxPages: 25, currentUrl: null },
      result: {
        agentTone: 'Friendly and direct.',
        pagesRead: ['https://shop.example.com/', 'https://shop.example.com/shipping'],
        fields: [
          {
            key: 'info.shipping',
            value: 'We ship nationwide in 3 to 5 business days.',
            sources: ['https://shop.example.com/shipping'],
            confidence: 0.9,
            warnings: [],
          },
          {
            key: 'info.payment',
            value: 'Pay by bank transfer to account 000111222333444.',
            sources: ['https://shop.example.com/shipping'],
            confidence: 0.4,
            warnings: ['ungrounded_details'],
          },
        ],
      },
      error: null,
    });
  }

  if (pathname.startsWith('/api/setup/site-scan/') && method === 'DELETE') {
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/setup/admin' && method === 'POST') {
    if (req.headers['x-setup-token'] !== 'e2e-setup-token-at-least-32-characters-long') {
      return json(res, 401, { error: 'invalid_setup_token' });
    }
    const body = await readJson(req);
    state.adminEmail = body.email;
    state.adminPassword = body.password;
    state.needsSetup = false;
    state.setupCompleted = false;
    return json(
      res,
      201,
      { id: '33333333-3333-4333-8333-333333333333', email: body.email, name: body.name, role: 'admin' },
      { 'set-cookie': await sessionCookie() },
    );
  }

  if (pathname === '/api/setup/complete' && method === 'POST') {
    state.setupCompleted = true;
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    if (body.email !== state.adminEmail || body.password !== state.adminPassword) {
      return json(res, 401, { error: 'invalid_credentials' });
    }
    return json(
      res,
      200,
      {
        id: '33333333-3333-4333-8333-333333333333',
        email: body.email,
        name: 'Admin',
        role: state.loginRole,
      },
      { 'set-cookie': await sessionCookie(state.loginRole) },
    );
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    return json(res, 200, { ok: true }, { 'set-cookie': 'arix_session=; Path=/; HttpOnly; Max-Age=0' });
  }

  if (pathname === '/api/me' && method === 'GET') {
    return json(res, 200, {
      id: '33333333-3333-4333-8333-333333333333',
      email: state.adminEmail,
      name: 'Admin',
      role: state.loginRole,
      sessionVersion: 0,
    });
  }

  if (pathname === '/api/conversations' && method === 'GET') {
    return json(res, 200, { conversations: state.conversations, nextCursor: null });
  }

  const conversationMatch = /^\/api\/conversations\/([^/]+)$/.exec(pathname);
  if (conversationMatch && method === 'GET') {
    const item = state.conversations.find((candidate) => candidate.id === conversationMatch[1]);
    if (!item) return json(res, 404, { error: 'conversation_not_found' });
    return json(res, 200, { conversation: item, messages: state.messages, receipts: [] });
  }

  const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
  if (messagesMatch && method === 'GET') return json(res, 200, { messages: [], hasMore: false });
  if (messagesMatch && method === 'POST') {
    const body = await readJson(req);
    const outgoing = {
      ...message(),
      id: '44444444-4444-4444-8444-444444444444',
      direction: 'out',
      sender: 'human',
      body: body.body,
      send_status: 'sent',
      client_id: body.clientId,
      created_at: new Date().toISOString(),
    };
    state.messages.push(outgoing);
    return json(res, 201, outgoing);
  }

  const modeMatch = /^\/api\/conversations\/([^/]+)\/mode$/.exec(pathname);
  if (modeMatch && method === 'POST') {
    const body = await readJson(req);
    const item = state.conversations.find((candidate) => candidate.id === modeMatch[1]);
    if (!item) return json(res, 404, { error: 'conversation_not_found' });
    item.mode = body.mode;
    return json(res, 200, item);
  }

  if (/^\/api\/conversations\/[^/]+\/read$/.test(pathname) && method === 'POST') {
    return json(res, 200, { ok: true });
  }
  if (/^\/api\/conversations\/[^/]+\/orders$/.test(pathname) && method === 'GET') {
    return json(res, 200, { orders: [] });
  }

  if (pathname === '/api/settings' && method === 'GET') return json(res, 200, state.settings);
  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJson(req);
    const updates = Array.isArray(body.updates) ? body.updates : [body];
    updateSettings(updates);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/analytics/usage' && method === 'GET') {
    return json(res, 200, {
      rows: [
        {
          day: '2026-07-10',
          provider: 'openai',
          model: 'gpt-4.1-mini',
          requests: 3,
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          estimated_cost_usd: 0.01,
        },
      ],
    });
  }
  if (pathname === '/api/audit' && method === 'GET') {
    return json(res, 200, {
      events: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          account_id: 'default',
          actor_id: '33333333-3333-4333-8333-333333333333',
          action: 'settings.updated',
          target_type: 'settings',
          target_id: null,
          request_id: 'e2e-request',
          ip_hash: null,
          metadata: {},
          created_at: '2026-07-10T12:30:00.000Z',
        },
      ],
    });
  }
  if (pathname === '/api/metrics' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('arix_http_requests_total 42\n');
  }

  if (pathname === '/api/staff' && method === 'GET') {
    return json(res, 200, [
      { id: '33333333-3333-4333-8333-333333333333', email: state.adminEmail, name: 'Admin', role: 'admin' },
    ]);
  }
  if (pathname === '/api/whatsapp/status' && method === 'GET') {
    return json(res, 200, { connected: false, hasQr: true });
  }
  if (pathname === '/api/qr' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('e2e-qr');
  }

  return json(res, 404, { error: 'not_found', path: pathname });
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'mock_internal_error' });
    else res.end();
  });
});

server.listen(PORT, HOST, () => console.log(`Arix E2E mock API listening on http://${HOST}:${PORT}`));

function shutdown() {
  for (const stream of streams) stream.end();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
