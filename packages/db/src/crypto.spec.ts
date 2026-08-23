import { describe, expect, it } from 'vitest';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hmacDigest,
  parsePepper,
  parsePiiKeys,
  safeEqual,
} from './crypto.js';

const KEY = Buffer.from('k'.repeat(32), 'utf8');
const OTHER_KEY = Buffer.from('o'.repeat(32), 'utf8');

describe('hmacDigest', () => {
  it('is deterministic for the same key/context/value', () => {
    expect(hmacDigest(KEY, 'session', 'abc')).toBe(hmacDigest(KEY, 'session', 'abc'));
  });

  it('separates contexts and keys (prefix domain separation)', () => {
    expect(hmacDigest(KEY, 'session', 'abc')).not.toBe(hmacDigest(KEY, 'device', 'abc'));
    expect(hmacDigest(KEY, 'session', 'abc')).not.toBe(hmacDigest(OTHER_KEY, 'session', 'abc'));
    expect(hmacDigest(KEY, 'session', 'abc')).not.toBe(hmacDigest(KEY, 'session', 'abd'));
  });

  it('emits a 64-char hex digest', () => {
    expect(hmacDigest(KEY, 'email', 'x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('aesGcmEncrypt/Decrypt', () => {
  it('round-trips plaintext', () => {
    const enc = aesGcmEncrypt(KEY, 'member@example.invalid');
    expect(aesGcmDecrypt(KEY, enc)).toBe('member@example.invalid');
  });

  it('uses a fresh random nonce per encryption (no ciphertext equality)', () => {
    const first = aesGcmEncrypt(KEY, 'same text');
    const second = aesGcmEncrypt(KEY, 'same text');
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(aesGcmDecrypt(KEY, first)).toBe(aesGcmDecrypt(KEY, second));
  });

  it('never embeds plaintext in ciphertext', () => {
    const enc = aesGcmEncrypt(KEY, 'member@example.invalid');
    expect(enc.ciphertext).not.toContain('member@example.invalid');
    expect(Buffer.from(enc.ciphertext, 'base64').toString('utf8')).not.toContain('member@');
  });

  it('fails on tampered ciphertext or nonce (auth tag)', () => {
    const enc = aesGcmEncrypt(KEY, 'secret payload');
    expect(() =>
      aesGcmDecrypt(KEY, { ...enc, ciphertext: `${enc.ciphertext.slice(0, -4)}AAAA` }),
    ).toThrow();
    expect(() =>
      aesGcmDecrypt(KEY, { ...enc, nonce: Buffer.from('x'.repeat(12)).toString('base64') }),
    ).toThrow();
  });

  it('fails to decrypt with a different key', () => {
    const enc = aesGcmEncrypt(KEY, 'secret payload');
    expect(() => aesGcmDecrypt(OTHER_KEY, enc)).toThrow();
  });
});

describe('config parsing', () => {
  const DEV_KEY = Buffer.alloc(32, 7).toString('base64');

  it('parsePiiKeys accepts a valid map and rejects malformed ones', () => {
    const keys = parsePiiKeys(JSON.stringify({ dev: DEV_KEY }));
    expect(keys.get('dev')?.length).toBe(32);
    expect(() => parsePiiKeys('{}')).toThrow();
    expect(() =>
      parsePiiKeys(JSON.stringify({ dev: Buffer.alloc(16).toString('base64') })),
    ).toThrow();
    expect(() => parsePiiKeys('not json')).toThrow();
  });

  it('parsePepper enforces 32+ bytes', () => {
    expect(parsePepper('x'.repeat(32)).length).toBe(32);
    expect(() => parsePepper('too short')).toThrow();
  });
});

describe('safeEqual', () => {
  it('compares equal strings and rejects unequal ones', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc123', 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
