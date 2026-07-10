import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

const { undiciFetch } = vi.hoisted(() => ({ undiciFetch: vi.fn() }));
vi.mock('undici', () => ({
  Agent: vi.fn().mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  fetch: undiciFetch,
}));

import {
  assertSafeMcpUrl,
  isPrivateOrReservedIp,
  secureMcpFetch,
} from '../src/mcp/network';

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  undiciFetch.mockReset();
});

describe('MCP network policy', () => {
  it('blocks private, loopback, link-local and metadata addresses', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('fd00::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
  });

  it('requires public HTTPS without URL credentials or query secrets', async () => {
    await expect(assertSafeMcpUrl('http://8.8.8.8/mcp')).rejects.toThrow(/HTTPS/);
    await expect(assertSafeMcpUrl('https://user:pass@8.8.8.8/mcp')).rejects.toThrow(/credentials/);
    await expect(assertSafeMcpUrl('https://8.8.8.8/mcp?token=secret')).rejects.toThrow(/query/);
    await expect(assertSafeMcpUrl('https://127.0.0.1/mcp')).rejects.toThrow(/private/);
    await expect(assertSafeMcpUrl('https://8.8.8.8/mcp')).resolves.toBeInstanceOf(URL);
  });

  it('refuses HTTP redirects', async () => {
    undiciFetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } }),
    );
    await expect(secureMcpFetch('https://8.8.8.8/mcp')).rejects.toThrow(/redirect/);
  });
});
