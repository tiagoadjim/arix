import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * Versioned AES-256-GCM envelopes for application secrets.
 *
 * v1 was derived directly from AUTH_JWT_SECRET. v2 uses the independent
 * SETTINGS_ENCRYPTION_KEY and embeds a non-secret key id so a previous key can
 * remain in a decryption keyring during rotation. Existing v1/plaintext rows
 * remain readable and are lazily migrated by rotateStoredSecrets().
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const HKDF_SALT = 'arix-settings';
const V1_INFO = 'settings-encryption-v1';
const V2_INFO = 'settings-encryption-v2';
const V1_PREFIX = 'enc:v1:';
const V2_PREFIX = 'enc:v2:';
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

interface KeyMaterial {
  id: string;
  key: Buffer;
  source: string;
}

let keyringCache: { fingerprint: string; active: KeyMaterial; all: KeyMaterial[] } | null = null;

function derive(secret: string, info: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(HKDF_SALT, 'utf8'),
      Buffer.from(info, 'utf8'),
      KEY_BYTES,
    ),
  );
}

function keyId(secret: string): string {
  return createHash('sha256').update(`arix:${secret}`).digest('base64url').slice(0, 12);
}

function configuredSecrets(): { active: string; previous: string[]; explicit: boolean } {
  const explicit = config.SETTINGS_ENCRYPTION_KEY?.trim();
  const previous = (config.SETTINGS_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((value) => value.trim())
    // A deployment may previously have used the supported JWT fallback,
    // whose historical minimum is 16 chars. Previous keys are decrypt-only;
    // the active independent key still requires 32+ in config.ts.
    .filter((value) => value.length >= 16);
  return {
    active: explicit || config.AUTH_JWT_SECRET,
    previous,
    explicit: Boolean(explicit),
  };
}

function keyring(): { active: KeyMaterial; all: KeyMaterial[] } {
  const configured = configuredSecrets();
  const fingerprint = JSON.stringify(configured);
  if (keyringCache?.fingerprint === fingerprint) return keyringCache;
  const secrets = [configured.active, ...configured.previous];
  const all = secrets.map((secret, index) => ({
    id: keyId(secret),
    key: derive(secret, V2_INFO),
    source: index === 0 ? (configured.explicit ? 'settings' : 'jwt-fallback') : 'previous',
  }));
  keyringCache = { fingerprint, active: all[0]!, all };
  return keyringCache;
}

function decodeSegment(value: string, label: string): Buffer {
  if (!value || !B64URL_RE.test(value)) {
    throw new SecretDecryptionError(`malformed encrypted envelope (invalid ${label})`);
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    throw new SecretDecryptionError(`malformed encrypted envelope (invalid ${label})`);
  }
}

function encryptWith(key: Buffer, partsPrefix: string, plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${partsPrefix}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptWith(key: Buffer, ivPart: string, tagPart: string, ctPart: string): string {
  const iv = decodeSegment(ivPart, 'iv');
  const tag = decodeSegment(tagPart, 'tag');
  const ciphertext = ctPart === '' ? Buffer.alloc(0) : decodeSegment(ctPart, 'ciphertext');
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new SecretDecryptionError('malformed encrypted envelope (invalid iv/tag length)');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptionError('failed to decrypt secret — ciphertext/key mismatch or tampering');
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX);
}

/** New writes always use the active v2 key. */
export function encryptSecret(plain: string): string {
  const active = keyring().active;
  return encryptWith(active.key, `${V2_PREFIX}${active.id}:`, plain);
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;

  if (stored.startsWith(V1_PREFIX)) {
    const parts = stored.slice(V1_PREFIX.length).split(':');
    if (parts.length !== 3) throw new SecretDecryptionError('malformed enc:v1 envelope');
    const [iv, tag, ciphertext] = parts as [string, string, string];
    return decryptWith(derive(config.AUTH_JWT_SECRET, V1_INFO), iv, tag, ciphertext);
  }

  const parts = stored.slice(V2_PREFIX.length).split(':');
  if (parts.length !== 4) throw new SecretDecryptionError('malformed enc:v2 envelope');
  const [id, iv, tag, ciphertext] = parts as [string, string, string, string];
  const material = keyring().all.find((candidate) => candidate.id === id);
  if (!material) throw new SecretDecryptionError(`no configured encryption key matches key id ${id}`);
  return decryptWith(material.key, iv, tag, ciphertext);
}

/** True for plaintext, legacy v1, or v2 encrypted under a non-active key. */
export function needsReencryption(stored: string): boolean {
  const activePrefix = `${V2_PREFIX}${keyring().active.id}:`;
  return !stored.startsWith(activePrefix);
}

export function usingIndependentEncryptionKey(): boolean {
  return keyring().active.source === 'settings';
}
