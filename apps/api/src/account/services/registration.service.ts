import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import type { AccountRepository, AuditRepository } from '@wai/db';
import { APP_CONFIG } from '../../tokens.js';
import {
  AUTH_PROVIDER,
  CLOCK,
  RANDOM_SOURCE,
  RATE_LIMITER,
  SECRET_CIPHER,
  TOKEN_DIGESTER,
  type AuthProvider,
  type Clock,
  type RandomSource,
  type RateLimiter,
  type SecretCipher,
  type TokenDigester,
} from '../ports.js';
import { ACCOUNT_REPOSITORY, AUDIT_REPOSITORY } from '../repositories.js';

export interface RegistrationResult {
  account_id: string;
  state: 'enabled';
}

/**
 * Registration (task book §7). The public response is UNIFORM for a fresh
 * account and a duplicate: both get 201 + a UUID, but only a fresh account
 * gets its real id — a duplicate gets a fresh random UUID so the response can
 * never be used to enumerate existing accounts.
 *
 * Timing discipline: the password is hashed BEFORE the existence check, so
 * fresh and duplicate registrations pay the same cost. A concurrent duplicate
 * races to the unique index on email_digest; the 23505 violation (whole
 * transaction rolled back) maps to the same uniform response.
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM_SOURCE) private readonly random: RandomSource,
  ) {}

  async register(input: {
    email: string;
    password: string;
    ipHmac: string;
    /** R1-06C: the FND request id — stamped on the account's initial transition. */
    requestId: string;
  }): Promise<RegistrationResult> {
    const emailDigest = this.digester.digest('email', input.email);
    const denied = await this.rateLimiter.consume(
      `register:email:${emailDigest}`,
      this.config.iam.rateLimit.registrationEmailMax,
      this.config.iam.rateLimit.emailWindowSeconds,
    );
    if (!denied.allowed) {
      throw rateLimited(denied.retryAfterSeconds);
    }

    const hash = await this.auth.hashPassword(input.password);
    const encrypted = this.cipher.encrypt(this.config.iam.piiKeyId, input.email);
    const now = new Date(this.clock.now());
    const { ipHmac } = input;

    const existing = await this.accounts.findByEmailDigest(emailDigest);
    if (existing !== null) {
      await this.audit.appendSecurityEvent({
        eventType: 'registration.duplicate',
        severity: 'warning',
        reason: 'REGISTRATION_DUPLICATE_EMAIL',
        ipHmac,
        now,
      });
      // Uniform response with a FRESH random id — never the real one.
      return { account_id: this.random.uuid(), state: 'enabled' };
    }

    try {
      const account = await this.accounts.insertWithPassword(
        {
          id: this.random.uuid(),
          emailDigest,
          emailCiphertext: encrypted.ciphertext,
          emailNonce: encrypted.nonce,
          emailKeyId: encrypted.keyId,
          requestId: input.requestId,
          now,
        },
        hash,
        now,
      );
      await this.audit.appendSecurityEvent({
        eventType: 'registration.created',
        accountId: account.id,
        severity: 'info',
        reason: 'REGISTRATION_CREATED',
        ipHmac,
        now,
      });
      return { account_id: account.id, state: 'enabled' };
    } catch (error) {
      // Concurrent duplicate registration: the unique index on email_digest
      // won — same uniform response as the sequential duplicate path.
      if (isUniqueViolation(error)) {
        return { account_id: this.random.uuid(), state: 'enabled' };
      }
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

/** Stable 429 envelope — the services never leak window internals. */
export function rateLimited(_retryAfterSeconds: number | undefined): HttpException {
  return new HttpException(
    { code: 'RATE_LIMITED', message: 'Too many requests; try again later' },
    429,
  );
}
