import { NextRequest } from 'next/server';

const HOP_BY_HOP = [
  'connection',
  'content-length',
  'content-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const MAX_REQUEST_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

async function readBodyLimited(request: NextRequest): Promise<Uint8Array | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return undefined;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new RequestBodyTooLargeError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) throw new RequestBodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function upstreamBase(): URL {
  const raw = process.env.SERVER_API_URL || 'http://localhost:3001';
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SERVER_API_URL must use HTTP(S)');
  }
  return url;
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  try {
    const { path } = await context.params;
    const encodedPath = path.map(encodeURIComponent).join('/');
    const target = new URL(`/api/${encodedPath}`, upstreamBase());
    target.search = request.nextUrl.search;

    // Forward only headers the API needs. In particular, never forward a
    // browser-supplied X-Forwarded-For: the internal API deliberately uses the
    // dashboard container address unless a trusted ingress is configured.
    const headers = new Headers();
    for (const name of [
      'accept',
      'accept-language',
      'content-type',
      'cookie',
      'origin',
      'user-agent',
      'x-request-id',
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // Only the first-admin bootstrap endpoint receives this secret header;
    // it is deliberately not exposed through the dashboard environment or
    // forwarded to unrelated API handlers.
    if (path.length === 2 && path[0] === 'setup' && path[1] === 'admin') {
      const setupToken = request.headers.get('x-setup-token');
      if (setupToken) headers.set('x-setup-token', setupToken);
    }
    headers.set('x-forwarded-host', request.headers.get('host') || request.nextUrl.host);
    headers.set('x-forwarded-proto', request.nextUrl.protocol.replace(':', ''));

    const body = await readBodyLimited(request);
    // EventSource is intentionally long-lived. Every ordinary API request gets
    // a hard upstream deadline so a wedged server cannot consume all Next
    // workers indefinitely after the client remains connected.
    const isEventStream = path.length === 1 && path[0] === 'events';
    const timeoutSignal = isEventStream ? null : AbortSignal.timeout(30_000);
    const signal = timeoutSignal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : request.signal;
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: body ? Uint8Array.from(body).buffer : undefined,
      cache: 'no-store',
      redirect: 'manual',
      signal,
    });
    const responseHeaders = new Headers(response.headers);
    for (const name of HOP_BY_HOP) responseHeaders.delete(name);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: 'payload_too_large' }, { status: 413 });
    }
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return Response.json({ error: 'api_timeout' }, { status: 504 });
    }
    console.error('API proxy failed', error instanceof Error ? error.name : typeof error);
    return Response.json({ error: 'api_unavailable' }, { status: 502 });
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
