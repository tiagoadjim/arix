import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * Encrypts secrets stored in the `settings` table (llm.api_key, wc.consumer_key,
 * wc.consumer_secret) so a DB dump/backup doesn't leak plaintext credentials.
 *
 * Algorithm: AES-256-GCM. The key is derived via HKDF-SHA256 from
 * `AUTH_JWT_SECRET` (never stored) with a fixed salt/info, so no separate
 * encryption key needs to be provisioned or rotated independently.
 *
 * IMPORTANT: rotating AUTH_JWT_SECRET invalidates every secret encrypted under
 * the old key — decryptSecret() will throw for them. There is no migration
 * path for this (by design: the key is never persisted anywhere). Operators
 * who rotate AUTH_JWT_SECRET must re-enter LLM/WooCommerce credentials in the
 * dashboard afterward.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit, the recommended nonce size for GCM
const KEY_BYTES = 32; // AES-256
const HKDF_SALT = 'arix-settings';
const HKDF_INFO = 'settings-encryption-v1';
const ENVELOPE_PREFIX = 'enc:v1:';

/** Raised when a stored secret can't be decrypted: malformed envelope, a
 * tampered ciphertext/tag, or AUTH_JWT_SECRET was rotated since encryption. */
export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

// Cache the derived key against the exact secret it was derived from, so a
// runtime AUTH_JWT_SECRET change (e.g. in a test) transparently busts it —
// no separate invalidation hook needed.
let keyCache: { forSecret: string; key: Buffer } | null = null;

function derivedKey(): Buffer {
  const secret = config.AUTH_JWT_SECRET;
  if (keyCache && keyCache.forSecret === secret) return keyCache.key;
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(HKDF_SALT, 'utf8'),
      Buffer.from(HKDF_INFO, 'utf8'),
      KEY_BYTES,
    ),
  );
  keyCache = { forSecret: secret, key };
  return key;
}

/** True if `value` is in the `enc:v1:` encrypted-secret envelope format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt a secret for storage. Format:
 * `enc:v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>`.
 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, derivedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

/**
 * Decrypt a value produced by encryptSecret(). Values that don't carry the
 * `enc:v1:` prefix pass through unchanged — a secret hand-edited into the DB
 * as plaintext is tolerated, not rejected. Throws SecretDecryptionError when
 * the envelope is malformed or the GCM tag check fails (tampered ciphertext,
 * or the wrong key because AUTH_JWT_SECRET was rotated).
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;

  const parts = stored.slice(ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new SecretDecryptionError('malformed enc:v1 envelope (expected iv:tag:ciphertext)');
  }
  const [ivPart, tagPart, ctPart] = parts as [string, string, string];

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivPart, 'base64url');
    tag = Buffer.from(tagPart, 'base64url');
    ciphertext = Buffer.from(ctPart, 'base64url');
  } catch {
    throw new SecretDecryptionError('malformed enc:v1 envelope (invalid base64url segment)');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, derivedKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new SecretDecryptionError(
      'failed to decrypt secret — tampered ciphertext/tag, or AUTH_JWT_SECRET was rotated since it was encrypted',
    );
  }
}
