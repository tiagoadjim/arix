import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, login } from '../src/lib/api';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('dashboard API client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses same-origin credentials and forwards cancellation signals', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [], nextCursor: null }));
    const controller = new AbortController();

    await expect(api.conversations(controller.signal)).resolves.toEqual({ conversations: [], nextCursor: null });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations?limit=100',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        signal: controller.signal,
      }),
    );
  });

  it('encodes the opaque conversation cursor when loading an older inbox page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [], nextCursor: null }));

    await api.conversations(undefined, 'cursor/with+reserved=characters', 50);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/conversations?limit=50&cursor=cursor%2Fwith%2Breserved%3Dcharacters',
    );
  });

  it('turns every non-2xx JSON response into a status-aware ApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));

    const error = await api.settingsGrouped().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('falls back to a stable HTTP code when an error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream unavailable', { status: 502 }));

    await expect(api.qr()).rejects.toMatchObject({
      name: 'ApiError',
      code: 'http_502',
      status: 502,
    });
  });

  it('keeps login 401 handling local instead of firing the protected-session logout flow', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_credentials' }, 401));

    await expect(login('staff@example.com', 'wrong')).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the setup token only in its dedicated header, not in the JSON body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'staff-1', email: 'admin@example.com', name: 'Admin' }));
    const setupToken = 'bootstrap-secret-that-must-not-enter-the-json-body';

    await api.setupAdmin({
      setupToken,
      name: 'Admin',
      email: 'admin@example.com',
      password: 'longenough',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get('x-setup-token')).toBe(setupToken);
    expect(String(init?.body)).not.toContain(setupToken);
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Admin',
      email: 'admin@example.com',
      password: 'longenough',
    });
  });

  it('keeps an invalid setup-token 401 inside the wizard instead of starting a session-expired redirect', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_setup_token' }, 401));

    await expect(
      api.setupAdmin({
        setupToken: 'wrong-token',
        name: 'Admin',
        email: 'admin@example.com',
        password: 'longenough',
      }),
    ).rejects.toMatchObject({ code: 'invalid_setup_token', status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('builds one-direction cursor queries and rejects ambiguous pagination', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [], hasMore: false }));

    await api.messages('conversation/id', { before: '2026-07-10T12:00:00.000Z', limit: 50 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/conversations/conversation/id/messages?before=2026-07-10T12%3A00%3A00.000Z&limit=50',
    );
    expect(() => api.messages('c1', { before: 'old', after: 'new' })).toThrow(/either after or before/i);
  });
});
