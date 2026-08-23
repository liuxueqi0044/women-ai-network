import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import type {
  AccountRepository,
  AuditRepository,
  MfaMethod,
  MfaRepository,
  PasswordCredentialRepository,
} from '@wai/db';
import { APP_CONFIG } from '../../tokens.js';
import {
  AUTH_PROVIDER,
  CLOCK,
  RANDOM_SOURCE,
  RATE_LIMITER,
  TOKEN_DIGESTER,
  type AuthProvider,
  type Clock,
  type RandomSource,
  type RateLimiter,
  type TokenDigester,
} from '../ports.js';
import {
  ACCOUNT_REPOSITORY,
  AUDIT_REPOSITORY,
  MFA_REPOSITORY,
  PASSWORD_CREDENTIAL_REPOSITORY,
} from '../repositories.js';
import { AccountStateService } from './account-state.service.js';
import { DeviceService } from './device.service.js';
import { rateLimited } from './registration.service.js';
import { SessionService, type IssuedSession } from './session.service.js';

/** Task book §7/§8: challenge lifetime and attempt budget are fixed. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

export interface IssuedMfaChallenge {
  /** Opaque challenge token — travels ONLY in the challenge cookie. */
  challengeToken: string;
  expiresAtMs: number;
  maxAttempts: number;
}

export type LoginOutcome =
  | { kind: 'session'; session: IssuedSession; deviceToken: string }
  | {
      kind: 'mfa_challenge';
      challenge: IssuedMfaChallenge;
      /** R1-06A: the device the password step bound the challenge to. */
      deviceToken: string;
    };

/** Stable internal reason codes for security events — never public. */
export const LOGIN_REASONS = {
  unknownEmail: 'INVALID_CREDENTIALS_UNKNOWN_EMAIL',
  badPassword: 'INVALID_CREDENTIALS_BAD_PASSWORD',
  missingCredential: 'INVALID_CREDENTIALS_MISSING_CREDENTIAL',
} as const;

/**
 * Password login (task book §7). Every failure path returns the SAME public
 * 401 INVALID_CREDENTIALS — unknown email, wrong password, denied account
 * state and missing credentials are only distinguishable in internal security
 * events (distinct reason codes). Non-existent accounts and denied states pay
 * the same dummy Argon2 verify as a real password check, so response timing
 * cannot tell them apart.
 */
@Injectable()
export class LoginService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(PASSWORD_CREDENTIAL_REPOSITORY)
    private readonly passwords: PasswordCredentialRepository,
    @Inject(MFA_REPOSITORY) private readonly mfa: MfaRepository,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM_SOURCE) private readonly random: RandomSource,
    // Explicit @Inject: vitest's esbuild transform cannot emit
    // design:paramtypes, so class-typed params must declare their token.
    @Inject(AccountStateService) private readonly accountState: AccountStateService,
    @Inject(SessionService) private readonly sessionService: SessionService,
    @Inject(DeviceService) private readonly deviceService: DeviceService,
  ) {}

  async login(input: {
    email: string;
    password: string;
    ipHmac: string;
    /** Raw client IP for device persistence — truncated to a prefix inside DeviceService. */
    ip: string;
    deviceToken: string | null;
    userAgent: string | null;
  }): Promise<LoginOutcome> {
    const emailDigest = this.digester.digest('email', input.email);
    const nowMs = this.clock.now();

    const denied = await this.rateLimiter.consume(
      `login:email:${emailDigest}`,
      this.config.iam.rateLimit.loginEmailMax,
      this.config.iam.rateLimit.emailWindowSeconds,
    );
    if (!denied.allowed) {
      throw rateLimited(denied.retryAfterSeconds);
    }

    const account = await this.accounts.findByEmailDigest(emailDigest);
    if (account === null) {
      await this.auth.dummyVerify(input.password);
      await this.audit.appendSecurityEvent({
        eventType: 'login.invalid_credentials',
        severity: 'warning',
        reason: LOGIN_REASONS.unknownEmail,
        ipHmac: input.ipHmac,
        now: new Date(nowMs),
      });
      throw invalidCredentials();
    }

    if (!this.accountState.canAuthenticate(account.state)) {
      // Denied states pay the same verification cost as a real check.
      await this.auth.dummyVerify(input.password);
      await this.audit.appendSecurityEvent({
        eventType: 'login.invalid_credentials',
        accountId: account.id,
        severity: 'warning',
        reason: this.accountState.deniedLoginReason(account.state),
        ipHmac: input.ipHmac,
        now: new Date(nowMs),
      });
      throw invalidCredentials();
    }

    const credential = await this.passwords.findByAccountId(account.id);
    if (credential === null) {
      await this.auth.dummyVerify(input.password);
      await this.audit.appendSecurityEvent({
        eventType: 'login.invalid_credentials',
        accountId: account.id,
        severity: 'critical',
        reason: LOGIN_REASONS.missingCredential,
        ipHmac: input.ipHmac,
        now: new Date(nowMs),
      });
      throw invalidCredentials();
    }

    const valid = await this.auth.verifyPassword(credential.hash, input.password);
    if (!valid) {
      await this.audit.appendSecurityEvent({
        eventType: 'login.invalid_credentials',
        accountId: account.id,
        severity: 'warning',
        reason: LOGIN_REASONS.badPassword,
        ipHmac: input.ipHmac,
        now: new Date(nowMs),
      });
      throw invalidCredentials();
    }

    const enabledFactors = await this.mfa.listFactorsByAccount(account.id);
    if (enabledFactors.length > 0) {
      // R1-06A: the challenge binds to the device that passed the password
      // step — completing it requires presenting that SAME device, so a
      // stolen challenge cookie can't be redeemed from a different browser.
      const device = await this.deviceService.touchForLogin({
        accountId: account.id,
        deviceToken: input.deviceToken,
        userAgent: input.userAgent,
        ip: input.ip,
        nowMs,
      });
      // Recovery is only a valid method while unused codes actually exist;
      // with all codes spent, the challenge accepts TOTP only.
      const unusedRecoveryCodes = await this.mfa.countUnusedRecoveryCodesByAccount(account.id);
      const methodSet: MfaMethod[] = unusedRecoveryCodes > 0 ? ['totp', 'recovery'] : ['totp'];
      const challengeToken = this.random.bytes(32).toString('base64url');
      const challenge = await this.mfa.insertChallenge({
        id: this.random.uuid(),
        accountId: account.id,
        digest: this.digester.digest('challenge', challengeToken),
        expiresAt: new Date(nowMs + MFA_CHALLENGE_TTL_MS),
        maxAttempts: MFA_CHALLENGE_MAX_ATTEMPTS,
        deviceId: device.device.id,
        methodSet,
        now: new Date(nowMs),
      });
      await this.audit.appendSecurityEvent({
        eventType: 'mfa.challenge_issued',
        accountId: account.id,
        severity: 'info',
        reason: 'MFA_CHALLENGE_ISSUED',
        ipHmac: input.ipHmac,
        now: new Date(nowMs),
      });
      return {
        kind: 'mfa_challenge',
        challenge: {
          challengeToken,
          expiresAtMs: challenge.expiresAt.getTime(),
          maxAttempts: challenge.maxAttempts,
        },
        deviceToken: device.deviceToken,
      };
    }

    // Task book §9: a successful login creates/refreshes the device record.
    const device = await this.deviceService.touchForLogin({
      accountId: account.id,
      deviceToken: input.deviceToken,
      userAgent: input.userAgent,
      ip: input.ip,
      nowMs,
    });
    const session = await this.sessionService.issueSession({
      accountId: account.id,
      authLevel: 'aal1',
      deviceId: device.device.id,
      ipHmac: input.ipHmac,
      nowMs,
      auditEvent: { eventType: 'login.success', reason: 'LOGIN_SUCCESS' },
    });
    return { kind: 'session', session, deviceToken: device.deviceToken };
  }
}

/** Uniform 401 for EVERY anonymous login failure — one stable public code. */
export function invalidCredentials(): HttpException {
  return new HttpException(
    { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
    401,
  );
}
