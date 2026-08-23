import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * IAM PII/secret crypto primitives (node:crypto only — no self-implemented
 * algorithms). This module is the SINGLE implementation of keyed digests and
 * AES-256-GCM for the account module: repositories (email digest +
 * ciphertext storage) and the API port implementations (session/device/
 * challenge/recovery digests) both call it.
 */

/** Keyed HMAC-SHA-256 digest. `context` separates domains (never two values hashed under one prefix). */
export function hmacDigest(key: Buffer, context: string, value: string): string {
  return createHmac('sha256', key).update(`${context}\0${value}`, 'utf8').digest('hex');
}

export interface AesGcmEncrypted {
  /** base64 nonce (12 bytes) */
  nonce: string;
  /** base64 (GCM tag + ciphertext) */
  ciphertext: string;
}

/** AES-256-GCM encrypt with a random 96-bit nonce; 128-bit auth tag. */
export function aesGcmEncrypt(key: Buffer, plaintext: string): AesGcmEncrypted {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([tag, ct]).toString('base64'),
  };
}

/** AES-256-GCM decrypt; throws on any tampering (auth tag mismatch). */
export function aesGcmDecrypt(key: Buffer, encrypted: AesGcmEncrypted): string {
  const nonce = Buffer.from(encrypted.nonce, 'base64');
  const tagAndCt = Buffer.from(encrypted.ciphertext, 'base64');
  const tag = tagAndCt.subarray(0, 16);
  const ct = tagAndCt.subarray(16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Validates a config-supplied key id + base64 32-byte key pair. */
export function parsePiiKeys(raw: string): ReadonlyMap<string, Buffer> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const keys = new Map<string, Buffer>();
  for (const [keyId, value] of Object.entries(parsed)) {
    if (keyId.length === 0 || typeof value !== 'string') {
      throw new Error('IAM_PII_KEYS entries must be { keyId: base64-32-byte-key }');
    }
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) {
      throw new Error(`IAM_PII_KEYS entry '${keyId}' must decode to exactly 32 bytes`);
    }
    keys.set(keyId, key);
  }
  if (keys.size === 0) {
    throw new Error('IAM_PII_KEYS must contain at least one key');
  }
  return keys;
}

export function parsePepper(raw: string): Buffer {
  const pepper = Buffer.from(raw, 'utf8');
  if (pepper.length < 32) {
    throw new Error('IAM_SECRET_PEPPER must be at least 32 bytes');
  }
  return pepper;
}

/** Constant-time string comparison for codes (defense in depth). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
