import { TOTP } from 'otpauth';
import type { describe, expect, it } from 'vitest';
import type { AuthProvider } from './auth-provider.js';

/**
 * AuthProvider compliance suite — the SAME suite runs against the real
 * Argon2+OTPAuth provider and the deterministic mock (IAM-01 CP1/CP3):
 *
 *   import { runAuthProviderCompliance } from '@wai/testkit';
 *   runAuthProviderCompliance(realProvider, { describe, it, expect });
 *   runAuthProviderCompliance(mockProvider, { describe, it, expect });
 *
 * The suite derives reference TOTP codes with the LOCKED `otpauth` library
 * (never a self-implemented algorithm) and passes explicit Unix seconds so
 * the ±1-window behavior is fully deterministic.
 *
 * The test API is INJECTED, never imported: testkit is a CommonJS package
 * consumed by other projects, and `require('vitest')` from its built dist
 * crashes (vitest is ESM-only), so a top-level import would poison every
 * testkit consumer. Type-only imports are erased at build time.
 */

/** The minimal vitest surface the suite needs (supplied by the caller). */
export interface ComplianceTestApi {
  describe: typeof describe;
  it: typeof it;
  expect: typeof expect;
}

const BASE32_SECRET = /^[A-Z2-7]+$/;
const STEP = 30;

function codeFor(secret: string, atSeconds: number): string {
  return new TOTP({ secret, period: STEP, digits: 6, algorithm: 'SHA1' }).generate({
    timestamp: atSeconds * 1000,
  });
}

export function runAuthProviderCompliance(provider: AuthProvider, api: ComplianceTestApi): void {
  const { describe, expect, it } = api;
  describe(`AuthProvider compliance — ${provider.name}`, () => {
    const password = 'correct horse battery staple';
    const wrong = 'wrong password value';

    it('hashes a password and verifies it round-trip', async () => {
      const hash = await provider.hashPassword(password);
      expect(hash.length).toBeGreaterThan(0);
      expect(await provider.verifyPassword(hash, password)).toBe(true);
    });

    it('rejects a wrong password', async () => {
      const hash = await provider.hashPassword(password);
      expect(await provider.verifyPassword(hash, wrong)).toBe(false);
    });

    it('salts: the same password produces distinct hashes', async () => {
      const first = await provider.hashPassword(password);
      const second = await provider.hashPassword(password);
      expect(first).not.toBe(second);
      expect(await provider.verifyPassword(first, password)).toBe(true);
      expect(await provider.verifyPassword(second, password)).toBe(true);
    });

    it('dummyVerify resolves for any input (anti-enumeration path)', async () => {
      await expect(provider.dummyVerify(password)).resolves.toBeUndefined();
      await expect(provider.dummyVerify(wrong)).resolves.toBeUndefined();
      await expect(provider.dummyVerify('')).resolves.toBeUndefined();
    });

    it('generates base32 TOTP secrets of at least 16 bytes', () => {
      const secret = provider.generateTotpSecret();
      expect(secret).toMatch(BASE32_SECRET);
      // Base32: each char carries 5 bits; 32 chars => 160 bits = 20 bytes.
      // A shorter valid secret (26 chars = 16 bytes) would still satisfy
      // the alphabet check; the length bound is deliberately ≥ the OTPAuth
      // default of 20 bytes, so both providers stay aligned.
      expect(secret.length).toBeGreaterThanOrEqual(32);
    });

    it('creates an otpauth URI embedding the secret', () => {
      const secret = provider.generateTotpSecret();
      const uri = provider.createTotpUri(
        secret,
        '3f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c',
        'member@example.invalid',
      );
      expect(uri.startsWith('otpauth://totp/')).toBe(true);
      expect(uri).toContain('secret=');
      expect(uri).toContain(secret);
    });

    it('accepts the code of the current time step', () => {
      const secret = provider.generateTotpSecret();
      const at = 1_800_000_000;
      expect(provider.verifyTotp(secret, codeFor(secret, at), at)).toBe(true);
    });

    it('accepts the ±1 window boundaries', () => {
      const secret = provider.generateTotpSecret();
      const at = 1_800_000_000;
      expect(provider.verifyTotp(secret, codeFor(secret, at - STEP), at)).toBe(true);
      expect(provider.verifyTotp(secret, codeFor(secret, at + STEP), at)).toBe(true);
    });

    it('rejects a wrong code and out-of-window codes', () => {
      const secret = provider.generateTotpSecret();
      const at = 1_800_000_000;
      expect(provider.verifyTotp(secret, '000000', at)).toBe(false);
      expect(provider.verifyTotp(secret, codeFor(secret, at - 2 * STEP), at)).toBe(false);
      expect(provider.verifyTotp(secret, codeFor(secret, at + 2 * STEP), at)).toBe(false);
    });

    it('rejects codes produced under a different secret', () => {
      const secret = provider.generateTotpSecret();
      const other = provider.generateTotpSecret();
      const at = 1_800_000_000;
      expect(provider.verifyTotp(secret, codeFor(other, at), at)).toBe(false);
    });
  });
}
