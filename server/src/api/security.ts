import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function positiveInteger(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
}

/** Compare a submitted credential without leaking a useful prefix/length
 * signal through the comparison itself. Hashing both values first gives
 * timingSafeEqual two fixed-size buffers even when the input lengths differ. */
export function constantTimeSecretEqual(expected: string, candidate: unknown): boolean {
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const candidateDigest = createHash('sha256')
    .update(typeof candidate === 'string' ? candidate : '', 'utf8')
    .digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

export function clientIp(req: Request): string {
  // Express only derives req.ip from X-Forwarded-For when createApiServer has
  // explicitly enabled the one-hop TRUST_PROXY setting. Never parse the
  // attacker-controlled header ourselves.
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function hashIp(req: Request): string {
  return createHash('sha256')
    .update(`${config.AUTH_JWT_SECRET}:${clientIp(req)}`)
    .digest('hex')
    .slice(0, 24);
}

export class BoundedRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly capacity = 10_000,
  ) {}

  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const existing = this.entries.get(key);
    if (!existing || existing.resetAt <= now) {
      this.entries.delete(key);
      this.ensureCapacity(now);
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    // Refresh insertion order so capacity eviction removes the coldest key.
    this.entries.delete(key);
    this.entries.set(key, existing);
    return {
      allowed: existing.count <= this.max,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }

  private ensureCapacity(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

export const requestSecurityMiddleware: RequestHandler = (req, res, next) => {
  const supplied = req.header('x-request-id');
  const requestId = supplied && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : randomUUID();
  (req as Request & { requestId?: string }).requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Same-origin protection for cookie-authenticated unsafe methods. Requests
 * without Origin (CLI/internal server traffic) remain supported. */
export const sameOriginGuard: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.header('origin');
  if (!origin) {
    next();
    return;
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    res.status(403).json({ error: 'invalid_origin' });
    return;
  }
  const originHost = parsedOrigin.host.toLowerCase();
  const originProtocol = parsedOrigin.protocol.toLowerCase();
  const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  const forwardedProtocol = req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const host = req.header('host')?.toLowerCase();
  const protocolMatches = !forwardedProtocol || originProtocol === `${forwardedProtocol}:`;
  if (!protocolMatches || (originHost !== forwardedHost && originHost !== host)) {
    res.status(403).json({ error: 'invalid_origin' });
    return;
  }
  next();
};
