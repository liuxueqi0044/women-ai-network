import type { InjectionToken } from '@nestjs/common';

/**
 * IAM-01 ports (task book §3). Application services depend on these
 * interfaces only — never on vendor SDKs — so the real implementations
 * (Argon2id + OTPAuth, node:crypto, Valkey) can be swapped for
 * deterministic fakes in tests without touching business code.
 */

/** Password hashing + TOTP. Production: Argon2id + OTPAuth; tests: deterministic mock. */
export interface AuthProvider {
  /** Stable name used in logs/tests, e.g. 'argon2-otpauth' or 'mock'. */
  readonly name: string;
  /** Returns an opaque PHC-style hash string. */
  hashPassword(password: string): Promise<string>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
  /**
   * Same-cost verify for accounts that do not exist — prevents a timing
   * oracle on anonymous login. Resolves for any input; never reveals
   * whether the input was correct.
   */
  dummyVerify(password: string): Promise<void>;
  /** Fresh TOTP secret (base32). */
  generateTotpSecret(): string;
  /** otpauth:// URI embedding the secret — shown exactly once. */
  createTotpUri(secret: string, accountId: string, email: string): string;
  /**
   * RFC 6238 check with ±1 window against the given Unix seconds — the
   * caller supplies time (its Clock port), keeping the provider pure and
   * the window behavior testable with a fixed clock.
   */
  verifyTotp(secret: string, code: string, atSeconds: number): boolean;
}

/** AES-256-GCM encryption keyed by key_id (rotation-ready). */
export interface SecretCipher {
  encrypt(keyId: string, plaintext: string): EncryptedSecret;
  decrypt(encrypted: EncryptedSecret): string;
}

export interface EncryptedSecret {
  keyId: string;
  /** base64 nonce (12 bytes) */
  nonce: string;
  /** base64 tag+ct */
  ciphertext: string;
}

/** Keyed HMAC-SHA-256 digests — tokens/codes are never stored raw. */
export interface TokenDigester {
  digest(context: DigestContext, value: string): string;
}

export type DigestContext =
  | 'session'
  | 'device'
  | 'challenge'
  | 'recovery'
  | 'email'
  /** Full client IP is never stored/logged — only its keyed HMAC. */
  | 'ip'
  /** R1-06B: device persistence digests the IP PREFIX (/24, /64), not the full address. */
  | 'device-ip'
  /** Raw User-Agent is never stored/logged — only its keyed HMAC. */
  | 'ua';

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets — only meaningful when denied. */
  retryAfterSeconds?: number;
}

/** Sliding/fixed-window rate limiter. Production: Valkey; tests: deterministic fake. */
export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

/** Server time — the ONLY time source for expiry checks. */
export interface Clock {
  /** Unix milliseconds (Date.now() equivalent). */
  now(): number;
}

/** CSPRNG-backed randomness. Tests inject a deterministic sequence. */
export interface RandomSource {
  bytes(length: number): Buffer;
  /** RFC 4122 v4 UUID string. */
  uuid(): string;
}

export const AUTH_PROVIDER: InjectionToken<AuthProvider> = Symbol('AUTH_PROVIDER');
export const SECRET_CIPHER: InjectionToken<SecretCipher> = Symbol('SECRET_CIPHER');
export const TOKEN_DIGESTER: InjectionToken<TokenDigester> = Symbol('TOKEN_DIGESTER');
export const RATE_LIMITER: InjectionToken<RateLimiter> = Symbol('RATE_LIMITER');
export const CLOCK: InjectionToken<Clock> = Symbol('CLOCK');
export const RANDOM_SOURCE: InjectionToken<RandomSource> = Symbol('RANDOM_SOURCE');
