import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { config } from '../config';

export class UnsafeRemoteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRemoteUrlError';
  }
}

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function ipv6ToBigInt(address: string): bigint | null {
  let normalized = (address.toLowerCase().split('%')[0] ?? '').replace(/^\[|\]$/g, '');
  const embeddedV4 = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedV4) {
    const parts = ipv4Parts(embeddedV4);
    if (!parts) return null;
    const [a, b, c, d] = parts as [number, number, number, number];
    normalized = normalized.replace(
      embeddedV4,
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`,
    );
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inV6Prefix(value: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

/** Reject non-public destinations commonly useful for SSRF (loopback, LAN,
 * link-local/cloud metadata, carrier-grade NAT, multicast and unspecified). */
export function isPrivateOrReservedIp(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b, c] = v4 as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  if (isIP(address) !== 6) return true;
  const value = ipv6ToBigInt(address);
  if (value === null || value === 0n || value === 1n) return true;
  const at = (raw: string) => ipv6ToBigInt(raw)!;
  if (inV6Prefix(value, at('::'), 96)) return true; // deprecated IPv4-compatible / reserved
  if (inV6Prefix(value, at('fc00::'), 7)) return true; // unique-local
  if (inV6Prefix(value, at('fe80::'), 10) || inV6Prefix(value, at('fec0::'), 10)) return true;
  if (inV6Prefix(value, at('ff00::'), 8)) return true; // multicast
  if (inV6Prefix(value, at('2001:db8::'), 32)) return true; // documentation
  if (inV6Prefix(value, at('2001::'), 32)) return true; // Teredo tunnelling
  if (inV6Prefix(value, at('100::'), 64)) return true; // discard-only
  if (inV6Prefix(value, at('2001:2::'), 48)) return true; // benchmarking
  if (inV6Prefix(value, at('2001:10::'), 28) || inV6Prefix(value, at('2001:20::'), 28)) return true; // ORCHID
  if (inV6Prefix(value, at('2002::'), 16)) return true; // 6to4 tunnelling
  if (inV6Prefix(value, at('64:ff9b::'), 96)) return true; // well-known NAT64
  if (inV6Prefix(value, at('::ffff:0:0'), 96)) {
    const low = Number(value & 0xffff_ffffn);
    return isPrivateOrReservedIp(
      `${(low >>> 24) & 255}.${(low >>> 16) & 255}.${(low >>> 8) & 255}.${low & 255}`,
    );
  }
  return false;
}

export function parseRemoteUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw) : new URL(raw);
  } catch {
    throw new UnsafeRemoteUrlError('Invalid remote URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeRemoteUrlError('Only HTTP(S) remote URLs are allowed.');
  }
  if (url.username || url.password) {
    throw new UnsafeRemoteUrlError('Credentials must not be embedded in a remote URL.');
  }
  if (url.protocol !== 'https:' && !config.ALLOW_INSECURE_HTTP) {
    throw new UnsafeRemoteUrlError('HTTPS is required unless ALLOW_INSECURE_HTTP=true.');
  }
  return url;
}

export interface ValidatedRemoteAddress {
  url: URL;
  address: string;
  family: 4 | 6;
}

interface ResolvedRemoteUrl {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

async function resolveSafeRemoteUrl(raw: string | URL): Promise<ResolvedRemoteUrl> {
  const url = parseRemoteUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    if (!config.ALLOW_PRIVATE_NETWORKS) throw new UnsafeRemoteUrlError('Local network destinations are disabled.');
  }

  let addresses: Array<{ address: string; family: 4 | 6 }>;
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = (await lookup(hostname, { all: true, verbatim: true })).flatMap((entry) =>
        entry.family === 4 || entry.family === 6
          ? [{ address: entry.address, family: entry.family }]
          : [],
      );
    } catch {
      throw new UnsafeRemoteUrlError('Remote hostname could not be resolved.');
    }
  }
  if (addresses.length === 0) throw new UnsafeRemoteUrlError('Remote hostname resolved to no addresses.');
  if (!config.ALLOW_PRIVATE_NETWORKS && addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new UnsafeRemoteUrlError('Private or reserved network destinations are disabled.');
  }
  const unique = addresses.filter(
    (entry, index) => addresses.findIndex((candidate) => candidate.address === entry.address) === index,
  );
  return { url, addresses: unique };
}

export async function assertSafeRemoteUrl(raw: string | URL): Promise<URL> {
  return (await resolveSafeRemoteUrl(raw)).url;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  /** Hard ceiling for the final response body, including chunked responses. */
  maxResponseBytes?: number;
  /** Test seam for simulating a remote hop. Production callers must leave it unset. */
  transport?: SafeFetchTransport;
}

export type SafeFetchTransport = (
  request: Request,
  remote: ValidatedRemoteAddress,
) => Promise<Response>;

const PRECONNECT_ERROR_CODES = new Set([
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
]);

function canTryAnotherAddress(method: string, error: unknown): boolean {
  if (method === 'GET' || method === 'HEAD') return true;
  const code = (error as { code?: unknown } | null)?.code;
  // Never replay a write after an ambiguous reset/timeout. Only failures that
  // establish the connection could not be made are safe to try elsewhere.
  return typeof code === 'string' && PRECONNECT_ERROR_CODES.has(code);
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  if (message.rawHeaders.length > 0) {
    for (let i = 0; i < message.rawHeaders.length; i += 2) {
      const name = message.rawHeaders[i];
      const value = message.rawHeaders[i + 1];
      if (name && value !== undefined) headers.append(name, value);
    }
    return headers;
  }
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.append(name, value);
  }
  return headers;
}

/**
 * Connect directly to the already-validated address. The original hostname is
 * retained in Host and TLS SNI, so certificate/virtual-host checks work while
 * DNS can never be resolved a second time between policy validation and the
 * socket connection (the classic DNS-rebinding TOCTOU).
 */
const pinnedNodeTransport: SafeFetchTransport = async (request, remote) => {
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  // Never let a caller route the validated connection to a different virtual
  // host. URL.host preserves an explicit non-default port when present.
  headers.host = remote.url.host;
  if (body && !request.headers.has('content-length')) headers['content-length'] = String(body.byteLength);

  const originalHostname = remote.url.hostname.replace(/^\[|\]$/g, '');
  const options: RequestOptions = {
    protocol: remote.url.protocol,
    hostname: remote.address,
    family: remote.family,
    port: remote.url.port || undefined,
    path: `${remote.url.pathname}${remote.url.search}`,
    method: request.method,
    headers,
    // A fresh socket per hop keeps connection pooling from ever crossing
    // validated destinations or virtual hosts.
    agent: false,
  };
  if (remote.url.protocol === 'https:' && isIP(originalHostname) === 0) {
    // https.request forwards this to tls.connect for both SNI and hostname
    // verification, even though the TCP hostname above is the pinned IP.
    Object.assign(options, { servername: originalHostname });
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const makeRequest = remote.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = makeRequest(options, (incoming) => {
      const status = incoming.statusCode ?? 502;
      if (status < 200 || status > 599) {
        incoming.destroy();
        if (!settled) {
          settled = true;
          reject(new Error(`remote service returned unsupported HTTP status ${status}`));
        }
        return;
      }
      const noBody = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
      if (noBody) incoming.resume();
      const stream = noBody
        ? null
        : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
      const response = new Response(stream, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders(incoming),
      });
      settled = true;
      resolve(response);
    });

    outgoing.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    const abort = () => {
      const reason = request.signal.reason instanceof Error
        ? request.signal.reason
        : new DOMException('The operation was aborted', 'AbortError');
      outgoing.destroy(reason);
      if (!settled) {
        settled = true;
        reject(reason);
      }
    };
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener('abort', abort, { once: true });
    outgoing.once('close', () => request.signal.removeEventListener('abort', abort));
    outgoing.end(body ?? undefined);
  });
};

async function boundResponseBody(response: Response, maxBytes: number): Promise<Response> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`remote response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        if (!next.value) return;
        total += next.value.byteLength;
        if (total > maxBytes) {
          const error = new Error(`remote response exceeds ${maxBytes} bytes`);
          await reader.cancel(error).catch(() => {});
          reader.releaseLock();
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        try {
          reader.releaseLock();
        } catch {
          // The source may already have released/errored the reader.
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // Already released by the pull path.
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Fetch with destination validation before every redirect hop. Cross-origin
 * redirects never inherit Authorization/Cookie headers. Unsafe-method
 * redirects are rejected rather than replaying a credentialed request. */
export async function safeFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 3, 5));
  const maxResponseBytes = Math.max(1, options.maxResponseBytes ?? 10 * 1024 * 1024);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  let request = new Request(input, { ...init, signal });
  const transport = options.transport ?? pinnedNodeTransport;

  for (let hop = 0; ; hop += 1) {
    const resolved = await resolveSafeRemoteUrl(request.url);
    let response: Response | null = null;
    let lastTransportError: unknown;
    // DNS commonly returns both IPv6 and IPv4. Pin and validate every address,
    // then fall back deterministically on connect/TLS failure without another
    // lookup. Passing a clone keeps request bodies replayable across addresses
    // while the original request remains untouched.
    for (const address of resolved.addresses) {
      try {
        response = await transport(request.clone(), { url: resolved.url, ...address });
        break;
      } catch (err) {
        lastTransportError = err;
        if (signal.aborted) throw err;
        if (!canTryAnotherAddress(request.method, err)) throw err;
      }
    }
    if (!response) throw lastTransportError ?? new Error('remote service could not be reached');
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return boundResponseBody(response, maxResponseBytes);
    }
    if (hop >= maxRedirects) {
      await response.body?.cancel().catch(() => {});
      throw new UnsafeRemoteUrlError('Too many redirects from remote service.');
    }
    const location = response.headers.get('location');
    if (!location) return response;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      await response.body?.cancel().catch(() => {});
      throw new UnsafeRemoteUrlError('Redirects for credentialed write requests are disabled.');
    }
    const nextUrl = new URL(location, request.url);
    const headers = new Headers(request.headers);
    if (nextUrl.origin !== new URL(request.url).origin) {
      headers.delete('authorization');
      headers.delete('cookie');
    }
    await response.body?.cancel().catch(() => {});
    request = new Request(nextUrl, { method: request.method, headers, signal });
  }
}

/** Read an HTTP response without allowing an untrusted server to allocate an
 * unbounded string in this process. */
export async function readTextLimited(response: Response, maxBytes = 5 * 1024 * 1024): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`remote response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`remote response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (err) {
    // Cancel the pinned socket-backed stream when the byte ceiling is crossed
    // (or decoding otherwise fails); releasing the reader alone would leave a
    // hostile server free to keep streaming into an abandoned connection.
    await reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
