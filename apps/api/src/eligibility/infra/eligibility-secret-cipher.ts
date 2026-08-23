import { aesGcmDecrypt, aesGcmEncrypt, hmacDigest, parsePiiKeys } from '@wai/db';

/**
 * ELG-01 birthday protection: the exact birth date only exists as
 * AES-256-GCM ciphertext (randomized nonce) plus a keyed HMAC digest for
 * idempotent same-date detection — never in plaintext anywhere. Reuses the
 * IAM PII keyring (IAM_PII_KEYS / IAM_PII_KEY_ID) so key rotation and
 * operational patterns stay shared. A distinct HMAC context ('birthday')
 * guarantees a birthday digest can never equal an email/session digest.
 */

export const BIRTHDAY_HMAC_CONTEXT = 'birthday';

export interface EncryptedBirthday {
  digest: string;
  ciphertext: string;
  nonce: string;
  keyId: string;
}

export interface BirthdayCipher {
  encrypt(birthDate: string): EncryptedBirthday;
  decrypt(encrypted: { ciphertext: string; nonce: string; keyId: string }): string;
  /** Whether this ciphertext was produced by the configured key id. */
  activeKeyId(): string;
}

export function createBirthdayCipher(piiKeysRaw: string, activeKeyId: string): BirthdayCipher {
  const keys = parsePiiKeys(piiKeysRaw);
  const key = keys.get(activeKeyId);
  if (key === undefined) {
    throw new Error(`IAM_PII_KEY_ID '${activeKeyId}' is not present in IAM_PII_KEYS`);
  }

  return {
    encrypt(birthDate: string): EncryptedBirthday {
      const encrypted = aesGcmEncrypt(key, birthDate);
      return {
        digest: hmacDigest(key, BIRTHDAY_HMAC_CONTEXT, birthDate),
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keyId: activeKeyId,
      };
    },
    decrypt(encrypted: { ciphertext: string; nonce: string; keyId: string }): string {
      const decryptKey = keys.get(encrypted.keyId);
      if (decryptKey === undefined) {
        throw new Error(`age evidence references unknown key id '${encrypted.keyId}'`);
      }
      return aesGcmDecrypt(decryptKey, {
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
      });
    },
    activeKeyId(): string {
      return activeKeyId;
    },
  };
}
