import { lookup as lookupCallback } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

const ALLOWED_HOSTS = new Set(
  (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP DNS lookup timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return null;
  }
  return parts as [number, number, number, number];
}

/** Deny anything that is not ordinary globally-routable unicast. This is
 * intentionally conservative: MCP must never reach local services, metadata,
 * test networks, multicast or unspecified addresses. */
export function isPrivateOrReservedIp(address: string): boolean {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  normalized = normalized.replace(/^0:0:0:0:0:ffff:/, '::ffff:');
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const mappedV4 = mappedHex
    ? [
        Number.parseInt(mappedHex[1]!, 16) >> 8,
        Number.parseInt(mappedHex[1]!, 16) & 0xff,
        Number.parseInt(mappedHex[2]!, 16) >> 8,
        Number.parseInt(mappedHex[2]!, 16) & 0xff,
      ].join('.')
    : normalized.startsWith('::ffff:')
      ? normalized.slice(7)
      : normalized;
  const v4 = parseIpv4(mappedV4);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff')
    );
  }
  return true;
}

type ConnectorLookup = (
  hostname: string,
  options: { family?: number | 'IPv4' | 'IPv6'; hints?: number },
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

const safeLookup: ConnectorLookup = (hostname, options, callback) => {
  const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
  lookupCallback(hostname, { family, hints: options.hints, all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 4);
      return;
    }
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
      callback(new Error('MCP host resolves to a private or reserved address'), '', 4);
      return;
    }
    const selected = addresses[0]!;
    // The connector receives this exact checked address, preventing a second
    // DNS lookup (and therefore DNS rebinding) between policy and connection.
    callback(null, selected.address, selected.family);
  });
};

const mcpDispatcher = new Agent({
  connect: { lookup: safeLookup, timeout: 10_000 },
  headersTimeout: 15_000,
  bodyTimeout: 15_000,
  maxResponseSize: 1_000_000,
  connections: 10,
});

export async function assertSafeMcpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid MCP URL');
  }
  if (url.protocol !== 'https:') throw new Error('MCP URL must use HTTPS');
  if (url.username || url.password) throw new Error('MCP URL must not contain credentials');
  if (url.search || url.hash) throw new Error('MCP URL must not contain query parameters or fragments');

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('local MCP hosts are not allowed');
  }
  if (ALLOWED_HOSTS.size > 0 && !ALLOWED_HOSTS.has(hostname)) {
    throw new Error('MCP host is not in MCP_ALLOWED_HOSTS');
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await withTimeout(lookup(hostname, { all: true, verbatim: true }), 3_000);
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error('MCP host resolves to a private or reserved address');
  }
  return url;
}

/** Fetch wrapper used by the MCP transport. It revalidates every request and
 * refuses redirects so a public endpoint cannot bounce requests into a
 * private network. */
export async function secureMcpFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const raw = input instanceof Request ? input.url : input.toString();
  await assertSafeMcpUrl(raw);
  const fetchInit = {
    ...init,
    redirect: 'manual',
    dispatcher: mcpDispatcher,
  } as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>;
  const response = (await undiciFetch(input as never, fetchInit)) as unknown as Response;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new Error('MCP HTTP redirects are not allowed');
  }
  return response;
}

export async function closeMcpNetwork(): Promise<void> {
  await mcpDispatcher.close();
}
