import { describe, expect, it } from 'vitest';
import {
  BoundedRateLimiter,
  boundedString,
  constantTimeSecretEqual,
  isUuid,
  positiveInteger,
} from '../src/api/security';

describe('BoundedRateLimiter', () => {
  it('allows at most the configured number of attempts within a window', () => {
    const limiter = new BoundedRateLimiter(2, 10_000, 100);

    expect(limiter.consume('account', 1_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume('account', 1_001).allowed).toBe(true);
    expect(limiter.consume('account', 1_002)).toEqual({ allowed: false, retryAfterSeconds: 10 });
  });

  it('starts a clean window after expiration', () => {
    const limiter = new BoundedRateLimiter(1, 1_000, 100);
    limiter.consume('account', 10_000);
    expect(limiter.consume('account', 10_999).allowed).toBe(false);

    expect(limiter.consume('account', 11_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('never grows beyond capacity and evicts the coldest key', () => {
    const limiter = new BoundedRateLimiter(1, 10_000, 2);
    limiter.consume('a', 1);
    limiter.consume('b', 1);
    expect(limiter.size()).toBe(2);

    // Refresh a, making b the least recently used key, then add c.
    expect(limiter.consume('a', 2).allowed).toBe(false);
    limiter.consume('c', 2);
    expect(limiter.size()).toBe(2);

    // b was evicted, so it receives a fresh first attempt instead of being
    // rejected as the second attempt in its original window.
    expect(limiter.consume('b', 3).allowed).toBe(true);
    expect(limiter.size()).toBe(2);
  });

  it('purges expired entries while making room and supports explicit reset', () => {
    const limiter = new BoundedRateLimiter(1, 100, 3);
    limiter.consume('expired-a', 0);
    limiter.consume('expired-b', 0);
    limiter.consume('live', 50);

    limiter.consume('new', 100);
    expect(limiter.size()).toBe(2);
    limiter.reset('live');
    expect(limiter.size()).toBe(1);
  });
});

describe('API input primitives', () => {
  it('compares secrets through fixed-size digests, including unequal-length inputs', () => {
    const secret = 'a-setup-secret-with-at-least-32-characters';
    expect(constantTimeSecretEqual(secret, secret)).toBe(true);
    expect(constantTimeSecretEqual(secret, `${secret}x`)).toBe(false);
    expect(constantTimeSecretEqual(secret, secret.slice(0, -1))).toBe(false);
    expect(constantTimeSecretEqual(secret, undefined)).toBe(false);
  });

  it('accepts canonical UUIDs and rejects arbitrary identifiers', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('../etc/passwd')).toBe(false);
    expect(isUuid(123)).toBe(false);
  });

  it('accepts only positive safe integers', () => {
    expect(positiveInteger('42')).toBe(42);
    expect(positiveInteger('0')).toBeNull();
    expect(positiveInteger('-1')).toBeNull();
    expect(positiveInteger('1.5')).toBeNull();
    expect(positiveInteger(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it('trims bounded strings and rejects oversized or non-string values', () => {
    expect(boundedString('  hello  ', 5)).toBe('hello');
    expect(boundedString('123456', 5)).toBeNull();
    expect(boundedString({ value: 'hello' }, 5)).toBeNull();
  });
});
