import { describe, expect, it, vi } from 'vitest';
import {
  isPrivateOrReservedIp,
  parseRemoteUrl,
  readTextLimited,
  safeFetch,
  UnsafeRemoteUrlError,
} from '../src/net/safe-fetch';

describe('remote URL policy', () => {
  it.each([
    '0.0.0.0',
    '10.12.34.56',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '100::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '2001:db8::1',
    '2001::1',
    '2002::1',
    '64:ff9b::7f00:1',
  ])('rejects non-public address %s', (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888'])(
    'accepts a public address such as %s',
    (address) => {
      expect(isPrivateOrReservedIp(address)).toBe(false);
    },
  );

  it('requires HTTPS by default and rejects credentials or non-HTTP schemes', () => {
    expect(() => parseRemoteUrl('http://93.184.216.34/path')).toThrow(UnsafeRemoteUrlError);
    expect(() => parseRemoteUrl('https://user:password@93.184.216.34/path')).toThrow(
      UnsafeRemoteUrlError,
    );
    expect(() => parseRemoteUrl('file:///etc/passwd')).toThrow(UnsafeRemoteUrlError);
    expect(parseRemoteUrl('https://93.184.216.34/path').href).toBe('https://93.184.216.34/path');
  });
});

describe('safeFetch', () => {
  it('blocks a direct private destination before invoking fetch', async () => {
    const transport = vi.fn();

    await expect(safeFetch('https://127.0.0.1/admin', {}, { transport })).rejects.toBeInstanceOf(
      UnsafeRemoteUrlError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('validates every redirect and blocks a public-to-private redirect', async () => {
    const transport = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }),
    );

    await expect(safeFetch('https://93.184.216.34/start', {}, { transport })).rejects.toBeInstanceOf(
      UnsafeRemoteUrlError,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('removes credentials on a cross-origin redirect while preserving ordinary headers', async () => {
    const seen: Request[] = [];
    const transport = vi.fn(async (request: Request) => {
      seen.push(request);
      if (seen.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/next' } });
      }
      return new Response('ok', { status: 200 });
    });
    const response = await safeFetch(
      'https://1.1.1.1/start',
      {
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=secret',
          'x-trace': 'keep-me',
        },
      },
      { transport },
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.headers.get('authorization')).toBeNull();
    expect(seen[1]!.headers.get('cookie')).toBeNull();
    expect(seen[1]!.headers.get('x-trace')).toBe('keep-me');
  });

  it('never replays a write request after a redirect', async () => {
    const transport = vi.fn(async () =>
      new Response(null, { status: 307, headers: { location: 'https://8.8.8.8/write' } }),
    );

    await expect(
      safeFetch(
        'https://1.1.1.1/write',
        { method: 'POST', body: '{"secret":true}' },
        { transport },
      ),
    ).rejects.toThrow('Redirects for credentialed write requests are disabled');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('enforces the configured redirect bound', async () => {
    const transport = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/again' } }),
    );

    await expect(safeFetch('https://1.1.1.1/start', {}, { maxRedirects: 0, transport })).rejects.toThrow(
      'Too many redirects',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects a declared oversized final response before a caller reads it', async () => {
    const transport = vi.fn(async () =>
      new Response('small', { status: 200, headers: { 'content-length': '1000' } }),
    );

    await expect(
      safeFetch('https://1.1.1.1/data', {}, { maxResponseBytes: 10, transport }),
    ).rejects.toThrow('remote response exceeds 10 bytes');
  });

  it('cuts off a chunked final response while it is being consumed', async () => {
    const transport = vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('12345'));
          controller.enqueue(new TextEncoder().encode('67890'));
          controller.close();
        },
      })),
    );

    const response = await safeFetch(
      'https://1.1.1.1/data',
      {},
      { maxResponseBytes: 9, transport },
    );
    await expect(response.text()).rejects.toThrow('remote response exceeds 9 bytes');
  });
});

describe('readTextLimited', () => {
  it('rejects a declared oversized response without reading it', async () => {
    const response = new Response('small body', { headers: { 'content-length': '1000' } });
    await expect(readTextLimited(response, 10)).rejects.toThrow('remote response exceeds 10 bytes');
  });

  it('enforces the byte limit for chunked responses with no content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12345'));
        controller.enqueue(new TextEncoder().encode('67890'));
        controller.close();
      },
    });
    const response = new Response(stream);

    await expect(readTextLimited(response, 9)).rejects.toThrow('remote response exceeds 9 bytes');
  });

  it('returns a response exactly at the byte limit', async () => {
    const response = new Response('ábc'); // 4 UTF-8 bytes
    await expect(readTextLimited(response, 4)).resolves.toBe('ábc');
  });
});
