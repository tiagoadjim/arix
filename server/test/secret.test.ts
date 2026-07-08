import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isEncrypted, SecretDecryptionError } from '../src/config/secret';
import { config } from '../src/config';

describe('encryptSecret / decryptSecret round-trip', () => {
  it('round-trips a plaintext secret', () => {
    const enc = encryptSecret('sk-super-secret-123');
    expect(enc).not.toBe('sk-super-secret-123');
    expect(decryptSecret(enc)).toBe('sk-super-secret-123');
  });

  it('round-trips an empty string', () => {
    const enc = encryptSecret('');
    expect(decryptSecret(enc)).toBe('');
  });

  it('produces a fresh enc:v1: envelope (iv:tag:ciphertext) each time, even for the same input', () => {
    const a = encryptSecret('same-input');
    const b = encryptSecret('same-input');
    expect(a).not.toBe(b); // random IV per call
    expect(decryptSecret(a)).toBe('same-input');
    expect(decryptSecret(b)).toBe('same-input');
  });
});

describe('isEncrypted', () => {
  it('detects the enc:v1: format', () => {
    expect(isEncrypted('enc:v1:a:b:c')).toBe(true);
  });

  it('rejects plaintext-looking values', () => {
    expect(isEncrypted('sk-plaintext-key')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted('enc:v2:a:b:c')).toBe(false); // only v1 is recognized today
  });
});

describe('decryptSecret — plaintext passthrough', () => {
  it('returns non-enc: values unchanged (manual DB edits are tolerated)', () => {
    expect(decryptSecret('sk-hand-entered-in-psql')).toBe('sk-hand-entered-in-psql');
    expect(decryptSecret('')).toBe('');
  });
});

/**
 * Flip one base64url character NOT at the very end of the string. The last
 * character of a non-padded base64url group can carry "don't care" trailing
 * bits, so altering only that character can decode to the SAME bytes —
 * flipping a middle character always changes real byte content.
 */
function flipMiddleChar(s: string): string {
  const i = Math.floor(s.length / 2);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const replacement = s[i] === alphabet[0] ? alphabet[1] : alphabet[0];
  return s.slice(0, i) + replacement + s.slice(i + 1);
}

describe('decryptSecret — tampering is rejected', () => {
  it('throws a typed error when the ciphertext is altered', () => {
    const enc = encryptSecret('sk-super-secret-123');
    const [, , iv, tag, ct] = enc.split(':');
    const tampered = `enc:v1:${iv}:${tag}:${flipMiddleChar(ct!)}`;
    expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it('throws a typed error when the auth tag is altered', () => {
    const enc = encryptSecret('sk-super-secret-123');
    const [, , iv, tag, ct] = enc.split(':');
    const tampered = `enc:v1:${iv}:${flipMiddleChar(tag!)}:${ct}`;
    expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it('throws a typed error on a malformed envelope (wrong segment count)', () => {
    expect(() => decryptSecret('enc:v1:onlyonesegment')).toThrow(SecretDecryptionError);
  });

  it('throws a typed error on invalid base64url segments', () => {
    expect(() => decryptSecret('enc:v1:not base64!:not base64!:not base64!')).toThrow(
      SecretDecryptionError,
    );
  });
});

describe('HKDF key derivation from AUTH_JWT_SECRET', () => {
  it('is stable for the same secret (round-trip keeps working across calls)', () => {
    const a = encryptSecret('stable-key-check');
    const b = encryptSecret('stable-key-check');
    expect(decryptSecret(a)).toBe('stable-key-check');
    expect(decryptSecret(b)).toBe('stable-key-check');
  });

  it('derives a different key when AUTH_JWT_SECRET changes (rotation invalidates old secrets)', () => {
    const enc = encryptSecret('rotate-me');
    const original = config.AUTH_JWT_SECRET;
    (config as { AUTH_JWT_SECRET: string }).AUTH_JWT_SECRET = 'a-completely-different-secret-value';
    try {
      expect(() => decryptSecret(enc)).toThrow(SecretDecryptionError);
    } finally {
      (config as { AUTH_JWT_SECRET: string }).AUTH_JWT_SECRET = original;
    }
    // Restored — encryption/decryption works normally again with the original secret.
    expect(decryptSecret(enc)).toBe('rotate-me');
  });
});
