import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  needsReencryption,
  usingIndependentEncryptionKey,
  SecretDecryptionError,
} from '../src/config/secret';
import { config } from '../src/config';

type MutableEncryptionConfig = {
  AUTH_JWT_SECRET: string;
  SETTINGS_ENCRYPTION_KEY?: string;
  SETTINGS_ENCRYPTION_KEY_PREVIOUS?: string;
};

function withEncryptionConfig<T>(
  overrides: Partial<MutableEncryptionConfig>,
  fn: () => T,
): T {
  const mutable = config as MutableEncryptionConfig;
  const previous = {
    AUTH_JWT_SECRET: mutable.AUTH_JWT_SECRET,
    SETTINGS_ENCRYPTION_KEY: mutable.SETTINGS_ENCRYPTION_KEY,
    SETTINGS_ENCRYPTION_KEY_PREVIOUS: mutable.SETTINGS_ENCRYPTION_KEY_PREVIOUS,
  };
  Object.assign(mutable, overrides);
  try {
    return fn();
  } finally {
    Object.assign(mutable, previous);
  }
}

/** Produce a real pre-v2 envelope so backward compatibility is exercised
 * independently from the current encryptSecret() implementation. */
function encryptLegacyV1(plain: string, jwtSecret = config.AUTH_JWT_SECRET): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(jwtSecret, 'utf8'),
      Buffer.from('arix-settings', 'utf8'),
      Buffer.from('settings-encryption-v1', 'utf8'),
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

describe('encryptSecret / decryptSecret v2 round-trip', () => {
  it('round-trips a plaintext secret in a key-id-bearing v2 envelope', () => {
    const enc = encryptSecret('sk-super-secret-123');
    expect(enc).toMatch(/^enc:v2:[A-Za-z0-9_-]{12}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(enc).not.toContain('sk-super-secret-123');
    expect(decryptSecret(enc)).toBe('sk-super-secret-123');
    expect(needsReencryption(enc)).toBe(false);
  });

  it('round-trips an empty string', () => {
    const enc = encryptSecret('');
    expect(enc).toMatch(/^enc:v2:/);
    expect(decryptSecret(enc)).toBe('');
  });

  it('uses a fresh IV each time, even for the same input and key', () => {
    const a = encryptSecret('same-input');
    const b = encryptSecret('same-input');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same-input');
    expect(decryptSecret(b)).toBe('same-input');
  });
});

describe('isEncrypted', () => {
  it('recognizes both the legacy v1 and current v2 prefixes', () => {
    expect(isEncrypted('enc:v1:a:b:c')).toBe(true);
    expect(isEncrypted('enc:v2:key:a:b:c')).toBe(true);
  });

  it('rejects plaintext-looking values', () => {
    expect(isEncrypted('sk-plaintext-key')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted('enc:v3:key:a:b:c')).toBe(false);
  });
});

describe('decryptSecret — plaintext and legacy compatibility', () => {
  it('returns non-encrypted values unchanged (manual DB edits are tolerated)', () => {
    expect(decryptSecret('sk-hand-entered-in-psql')).toBe('sk-hand-entered-in-psql');
    expect(decryptSecret('')).toBe('');
    expect(needsReencryption('sk-hand-entered-in-psql')).toBe(true);
  });

  it('decrypts real v1 envelopes derived from AUTH_JWT_SECRET and marks them for migration', () => {
    const legacy = encryptLegacyV1('legacy-secret');
    expect(decryptSecret(legacy)).toBe('legacy-secret');
    expect(needsReencryption(legacy)).toBe(true);
  });

  it('cannot decrypt a v1 envelope after its legacy AUTH_JWT_SECRET is lost', () => {
    const legacy = encryptLegacyV1('legacy-secret');
    withEncryptionConfig(
      { AUTH_JWT_SECRET: 'different-jwt-secret-at-least-32-characters' },
      () => expect(() => decryptSecret(legacy)).toThrow(SecretDecryptionError),
    );
  });
});

/** Flip one base64url character away from the final trailing-bit position. */
function flipMiddleChar(s: string): string {
  const i = Math.floor(s.length / 2);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const replacement = s[i] === alphabet[0] ? alphabet[1] : alphabet[0];
  return s.slice(0, i) + replacement + s.slice(i + 1);
}

describe('decryptSecret — tampering is rejected', () => {
  it('throws a typed error when v2 ciphertext is altered', () => {
    const enc = encryptSecret('sk-super-secret-123');
    const [, , id, iv, tag, ciphertext] = enc.split(':');
    const tampered = `enc:v2:${id}:${iv}:${tag}:${flipMiddleChar(ciphertext!)}`;
    expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it('throws a typed error when the v2 auth tag is altered', () => {
    const enc = encryptSecret('sk-super-secret-123');
    const [, , id, iv, tag, ciphertext] = enc.split(':');
    const tampered = `enc:v2:${id}:${iv}:${flipMiddleChar(tag!)}:${ciphertext}`;
    expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it('throws a typed error on malformed v1 and v2 envelopes', () => {
    expect(() => decryptSecret('enc:v1:onlyonesegment')).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('enc:v2:key:too:few')).toThrow(SecretDecryptionError);
  });

  it('throws a typed error on invalid base64url segments', () => {
    const enc = encryptSecret('value');
    const [, , id, , tag, ciphertext] = enc.split(':');
    expect(() => decryptSecret(`enc:v2:${id}:not base64!:${tag}:${ciphertext}`)).toThrow(
      SecretDecryptionError,
    );
  });
});

describe('independent encryption key and rotation keyring', () => {
  const keyA = 'settings-key-a-0123456789abcdef-0123456789';
  const keyB = 'settings-key-b-0123456789abcdef-0123456789';

  it('keeps v2 settings decryptable when the JWT secret rotates', () => {
    withEncryptionConfig({ SETTINGS_ENCRYPTION_KEY: keyA, SETTINGS_ENCRYPTION_KEY_PREVIOUS: undefined }, () => {
      const encrypted = encryptSecret('independent-from-jwt');
      expect(usingIndependentEncryptionKey()).toBe(true);
      withEncryptionConfig(
        { AUTH_JWT_SECRET: 'rotated-jwt-secret-at-least-32-characters' },
        () => expect(decryptSecret(encrypted)).toBe('independent-from-jwt'),
      );
    });
  });

  it('reads an old v2 envelope through SETTINGS_ENCRYPTION_KEY_PREVIOUS and marks it for re-encryption', () => {
    let oldEnvelope = '';
    withEncryptionConfig({ SETTINGS_ENCRYPTION_KEY: keyA, SETTINGS_ENCRYPTION_KEY_PREVIOUS: undefined }, () => {
      oldEnvelope = encryptSecret('rotate-me');
      expect(needsReencryption(oldEnvelope)).toBe(false);
    });

    withEncryptionConfig({ SETTINGS_ENCRYPTION_KEY: keyB, SETTINGS_ENCRYPTION_KEY_PREVIOUS: keyA }, () => {
      expect(decryptSecret(oldEnvelope)).toBe('rotate-me');
      expect(needsReencryption(oldEnvelope)).toBe(true);
      const currentEnvelope = encryptSecret('rotate-me');
      expect(currentEnvelope).not.toBe(oldEnvelope);
      expect(needsReencryption(currentEnvelope)).toBe(false);
    });
  });

  it('rejects an old v2 envelope once its previous key is removed', () => {
    let oldEnvelope = '';
    withEncryptionConfig({ SETTINGS_ENCRYPTION_KEY: keyA, SETTINGS_ENCRYPTION_KEY_PREVIOUS: undefined }, () => {
      oldEnvelope = encryptSecret('rotate-me');
    });
    withEncryptionConfig({ SETTINGS_ENCRYPTION_KEY: keyB, SETTINGS_ENCRYPTION_KEY_PREVIOUS: undefined }, () => {
      expect(() => decryptSecret(oldEnvelope)).toThrow(SecretDecryptionError);
    });
  });

  it('retains the documented JWT fallback for deployments without an independent key', () => {
    withEncryptionConfig({ SETTINGS_ENCRYPTION_KEY: undefined, SETTINGS_ENCRYPTION_KEY_PREVIOUS: undefined }, () => {
      expect(usingIndependentEncryptionKey()).toBe(false);
      const encrypted = encryptSecret('fallback-secret');
      expect(decryptSecret(encrypted)).toBe('fallback-secret');
    });
  });

  it('can rotate a v2 envelope created by the historical 16-character JWT fallback', () => {
    const shortFallback = '1234567890abcdef';
    let fallbackEnvelope = '';
    withEncryptionConfig(
      {
        AUTH_JWT_SECRET: shortFallback,
        SETTINGS_ENCRYPTION_KEY: undefined,
        SETTINGS_ENCRYPTION_KEY_PREVIOUS: undefined,
      },
      () => {
        fallbackEnvelope = encryptSecret('legacy-fallback-value');
      },
    );
    withEncryptionConfig(
      { SETTINGS_ENCRYPTION_KEY: keyB, SETTINGS_ENCRYPTION_KEY_PREVIOUS: shortFallback },
      () => expect(decryptSecret(fallbackEnvelope)).toBe('legacy-fallback-value'),
    );
  });
});
