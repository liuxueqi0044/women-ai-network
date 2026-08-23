import { describe, expect, it } from 'vitest';
import { createBirthdayCipher } from './eligibility-secret-cipher.js';

const KEYS_JSON = JSON.stringify({
  '2026-01': 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  '2025-06': 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=',
});

describe('createBirthdayCipher', () => {
  it('encrypts to randomized ciphertext with an active key id', () => {
    const cipher = createBirthdayCipher(KEYS_JSON, '2026-01');
    const first = cipher.encrypt('2010-03-14');
    const second = cipher.encrypt('2010-03-14');
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.keyId).toBe('2026-01');
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(cipher.activeKeyId()).toBe('2026-01');
  });

  it('round-trips the exact birth date', () => {
    const cipher = createBirthdayCipher(KEYS_JSON, '2026-01');
    const encrypted = cipher.encrypt('2010-03-14');
    expect(cipher.decrypt(encrypted)).toBe('2010-03-14');
  });

  it('same date produces the same digest (idempotency), different dates differ', () => {
    const cipher = createBirthdayCipher(KEYS_JSON, '2026-01');
    expect(cipher.encrypt('2010-03-14').digest).toBe(cipher.encrypt('2010-03-14').digest);
    expect(cipher.encrypt('2010-03-14').digest).not.toBe(cipher.encrypt('2010-03-15').digest);
  });

  it('decrypts legacy ciphertext encrypted under a rotated key id', () => {
    const cipher = createBirthdayCipher(KEYS_JSON, '2026-01');
    const legacy = createBirthdayCipher(KEYS_JSON, '2025-06').encrypt('2005-12-31');
    expect(cipher.decrypt(legacy)).toBe('2005-12-31');
    expect(legacy.keyId).toBe('2025-06');
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const cipher = createBirthdayCipher(KEYS_JSON, '2026-01');
    const encrypted = cipher.encrypt('2010-03-14');
    const flipped = encrypted.ciphertext.endsWith('A')
      ? `${encrypted.ciphertext.slice(0, -1)}B`
      : `${encrypted.ciphertext.slice(0, -1)}A`;
    expect(() => cipher.decrypt({ ...encrypted, ciphertext: flipped })).toThrow();
  });

  it('fails closed when the active key id is missing from the keyring', () => {
    expect(() => createBirthdayCipher(KEYS_JSON, '2027-01')).toThrow(/not present/);
  });

  it('fails closed on a malformed keyring', () => {
    expect(() => createBirthdayCipher('not-json', '2026-01')).toThrow();
  });
});
