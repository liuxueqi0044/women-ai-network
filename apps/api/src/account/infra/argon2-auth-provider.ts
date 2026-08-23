import { hash, verify } from '@node-rs/argon2';
import { Secret, TOTP } from 'otpauth';
import type { AuthProvider } from '../ports.js';

// Algorithm.Argon2id — the NAPI const enum is not importable under
// isolatedModules; the numeric value is part of the locked @node-rs/argon2
// contract (Argon2d=0, Argon2i=1, Argon2id=2) and asserted in the hardening
// spec via the `$argon2id$` PHC prefix.
const ARGON2ID_ALGORITHM = 2;

/**
 * Production AuthProvider: Argon2id password hashing (@node-rs/argon2) and
 * RFC 6238 TOTP (otpauth) — both locked versions, orchestrated here, never
 * re-implemented. Passes the same compliance suite as the deterministic
 * mock (packages/testkit).
 */

export interface Argon2Params {
  /** KiB of memory (OWASP baseline: 19 MiB = 19456). */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const OWASP_ARGON2_PARAMS: Argon2Params = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const TOTP_ISSUER = 'Women AI Network';
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

export class Argon2OtpAuthProvider implements AuthProvider {
  readonly name = 'argon2-otpauth';

  private dummyHash: string | undefined;

  constructor(private readonly params: Argon2Params = OWASP_ARGON2_PARAMS) {}

  async hashPassword(password: string): Promise<string> {
    return hash(password, {
      memoryCost: this.params.memoryCost,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
      algorithm: ARGON2ID_ALGORITHM,
    });
  }

  async verifyPassword(hashValue: string, password: string): Promise<boolean> {
    try {
      return await verify(hashValue, password);
    } catch {
      // Malformed stored hash — treat as failure, never as an error path.
      return false;
    }
  }

  async dummyVerify(password: string): Promise<void> {
    // Same-cost verification for accounts that do not exist. The result is
    // deliberately discarded — only the time spent matters.
    const dummy = (this.dummyHash ??= await this.hashPassword('wai-iam-dummy-verify-password'));
    await this.verifyPassword(dummy, password);
  }

  generateTotpSecret(): string {
    return new Secret({ size: 20 }).base32;
  }

  createTotpUri(secret: string, accountId: string, email: string): string {
    const totp = new TOTP({
      issuer: TOTP_ISSUER,
      label: email,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      secret,
    });
    return `${totp.toString()}#account=${accountId}`;
  }

  verifyTotp(secret: string, code: string, atSeconds: number): boolean {
    const totp = new TOTP({
      issuer: TOTP_ISSUER,
      label: 'wai',
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      secret,
    });
    // ±1 window around the caller-supplied timestamp (deterministic tests).
    return totp.validate({ token: code, timestamp: atSeconds * 1000, window: 1 }) !== null;
  }
}
