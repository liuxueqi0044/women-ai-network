import { aesGcmDecrypt, aesGcmEncrypt } from '@wai/db';
import type { EncryptedSecret, SecretCipher } from '../ports.js';

/**
 * AES-256-GCM via the shared @wai/db crypto primitives. Key material comes
 * from config (IAM_PII_KEYS / IAM_PII_KEY_ID) and stays out of every log.
 */
export class NodeSecretCipher implements SecretCipher {
  constructor(private readonly keys: ReadonlyMap<string, Buffer>) {}

  encrypt(keyId: string, plaintext: string): EncryptedSecret {
    const key = this.requireKey(keyId);
    const encrypted = aesGcmEncrypt(key, plaintext);
    return { keyId, nonce: encrypted.nonce, ciphertext: encrypted.ciphertext };
  }

  decrypt(encrypted: EncryptedSecret): string {
    const key = this.requireKey(encrypted.keyId);
    return aesGcmDecrypt(key, { nonce: encrypted.nonce, ciphertext: encrypted.ciphertext });
  }

  private requireKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (key === undefined) {
      throw new Error(`unknown PII key id: ${keyId}`);
    }
    return key;
  }
}
