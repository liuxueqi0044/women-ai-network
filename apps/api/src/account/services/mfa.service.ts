import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import {
  type AccountRepository,
  type AuditRepository,
  type Db,
  type DeviceRepository,
  FactorSlotTakenError,
  type MfaRepository,
  type PasswordCredentialRepository,
} from '@wai/db';
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
import {
  ACCOUNT_REPOSITORY,
  AUDIT_REPOSITORY,
  DEVICE_REPOSITORY,
  IAM_DB,
  MFA_REPOSITORY,
  PASSWORD_CREDENTIAL_REPOSITORY,
} from '../repositories.js';
import { AccountStateService } from './account-state.service.js';
import { DeviceService } from './device.service.js';
import { invalidCredentials } from './login.service.js';
import { rateLimited } from './registration.service.js';
import {
  SessionService,
  accountStateDenied,
  replayDetected,
  sessionRequired,
  type IssuedSession,
  type RotateOutcome,
  type RotatedSession,
} from './session.service.js';

/** Task book §8: exactly 10 one-time recovery codes per issuance. */
export const RECOVERY_CODE_COUNT = 10;
/**
 * Unambiguous alphabet (no 0/1/I/L/O): 2-9, A-H, J-N, P-Z — 32 symbols, so a
 * byte modulo 32 is unbiased.
 */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * MFA (task book §8). TOTP only. Enrollment stores a PENDING encrypted
 * secret and shows the otpauth URI exactly once; the first correct TOTP code
 * flips the factor to `enabled` and issues the 10 one-time recovery codes
 * (shown once, stored as keyed digests). Every strength change (enable /
 * disable) revokes the account's OTHER sessions and rotates the CURRENT one
 * to the new auth level in a single transaction. MFA login completes a
 * single-use 5-minute challenge (5 attempts) into an AAL2 session.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(PASSWORD_CREDENTIAL_REPOSITORY)
    private readonly passwords: PasswordCredentialRepository,
    @Inject(MFA_REPOSITORY) private readonly mfa: MfaRepository,
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM_SOURCE) private readonly random: RandomSource,
    @Inject(IAM_DB) private readonly db: Db,
    // Explicit @Inject: vitest's esbuild transform cannot emit
    // design:paramtypes, so class-typed params must declare their token.
    @Inject(AccountStateService) private readonly accountState: AccountStateService,
    @Inject(SessionService) private readonly sessionService: SessionService,
    @Inject(DeviceService) private readonly deviceService: DeviceService,
  ) {}

  /**
   * Enrollment start: requires password re-verification on an active AAL1
   * session. Stores a PENDING encrypted secret; the otpauth URI is returned
   * exactly once. R1-04: pending AND enabled occupy the unique factor slot —
   * the account row is locked, the slot is checked inside the same
   * transaction, and the partial unique index is the race backstop (a
   * violation maps to a stable 409, never a 500).
   */
  async startEnrollment(input: {
    accountId: string;
    password: string;
    ipHmac: string;
  }): Promise<{ factorId: string; otpauthUri: string }> {
    const nowMs = this.clock.now();
    const now = new Date(nowMs);
    await this.verifyPassword(input.accountId, input.password, now, input.ipHmac);

    const secret = this.auth.generateTotpSecret();
    const encrypted = this.cipher.encrypt(this.config.iam.piiKeyId, secret);
    const { account, factor } = await this.db.transaction(async (tx) => {
      // The account row lock serializes concurrent starts for the same
      // account; the unique index below is the backstop if it is missed.
      // EVERY read/write in this block runs on the tx connection — a pool
      // connection here would deadlock against this transaction's own lock
      // (the insert's FK check waits for the FOR UPDATE it holds itself).
      const locked = await this.accounts.findByIdForUpdate(tx, input.accountId);
      if (locked === null) {
        throw sessionRequired();
      }
      const active = await this.mfa.listActiveFactorsByAccountTx(tx, input.accountId);
      if (active.some((row) => row.state === 'enabled')) {
        throw mfaAlreadyEnabled();
      }
      if (active.some((row) => row.state === 'pending')) {
        throw mfaEnrollmentInProgress();
      }
      let inserted: Awaited<ReturnType<MfaRepository['insertFactorTx']>>;
      try {
        inserted = await this.mfa.insertFactorTx(tx, {
          id: this.random.uuid(),
          accountId: input.accountId,
          secretCiphertext: encrypted.ciphertext,
          secretNonce: encrypted.nonce,
          secretKeyId: encrypted.keyId,
          now,
        });
      } catch (error) {
        if (error instanceof FactorSlotTakenError) {
          // PostgreSQL marks the transaction aborted after 23505, so a re-read
          // here would itself fail. The pre-check already maps existing enabled
          // factors; the unique-index backstop maps to the stable generic slot
          // conflict and the transaction then rolls back.
          throw mfaEnrollmentInProgress();
        }
        throw error;
      }
      return { account: locked, factor: inserted };
    });

    const email = this.cipher.decrypt({
      keyId: account.emailKeyId,
      nonce: account.emailNonce,
      ciphertext: account.emailCiphertext,
    });
    const otpauthUri = this.auth.createTotpUri(secret, account.id, email);

    await this.audit.appendSecurityEvent({
      eventType: 'mfa.enrollment_started',
      accountId: input.accountId,
      severity: 'info',
      reason: 'MFA_ENROLLMENT_STARTED',
      ipHmac: input.ipHmac,
      now,
    });
    return { factorId: factor.id, otpauthUri };
  }

  /**
   * Confirm: the first correct TOTP code enables the pending factor, mints
   * the recovery codes and — in ONE transaction — revokes the account's
   * other sessions and rotates the current session to AAL2 (task book §8).
   */
  async confirmEnrollment(input: {
    token: string;
    accountId: string;
    totpCode: string;
    ipHmac: string;
  }): Promise<{ recoveryCodes: string[]; rotated: RotatedSession }> {
    const nowMs = this.clock.now();
    const now = new Date(nowMs);
    const factor = await this.mfa.findPendingByAccount(input.accountId);
    if (factor === null) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'No pending enrollment' }, 404);
    }
    const secret = this.cipher.decrypt({
      keyId: factor.secretKeyId,
      nonce: factor.secretNonce,
      ciphertext: factor.secretCiphertext,
    });
    if (!this.auth.verifyTotp(secret, input.totpCode, Math.floor(nowMs / 1000))) {
      await this.audit.appendSecurityEvent({
        eventType: 'mfa.enrollment_failed',
        accountId: input.accountId,
        severity: 'warning',
        reason: 'MFA_INVALID',
        ipHmac: input.ipHmac,
        now,
      });
      throw mfaInvalid();
    }

    const recoveryCodes = generateRecoveryCodes(this.random, RECOVERY_CODE_COUNT);
    const outcome = await this.db.transaction(async (tx) => {
      // Gate: pending → enabled. A concurrent confirm loses here.
      const enabled = await this.mfa.setFactorEnabledTx(tx, factor.id, now);
      if (enabled === null) {
        throw mfaAlreadyEnabled();
      }
      await this.mfa.insertRecoveryCodesTx(
        tx,
        factor.id,
        input.accountId,
        recoveryCodes.map((code) => ({
          id: this.random.uuid(),
          digest: this.digester.digest('recovery', code),
        })),
        now,
      );
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'mfa.enabled',
        accountId: input.accountId,
        severity: 'info',
        reason: 'MFA_ENABLED',
        ipHmac: input.ipHmac,
        now,
      });
      return this.sessionService.rotateInTx(tx, {
        token: input.token,
        ipHmac: input.ipHmac,
        authLevel: 'aal2',
        revokeOthers: true,
      });
    });
    throwOutcome(outcome);
    return { recoveryCodes, rotated: outcome.session };
  }

  /** Regenerate: password re-verification, then ALL unused codes die and 10 fresh ones are minted. */
  async regenerateRecoveryCodes(input: {
    accountId: string;
    password: string;
    ipHmac: string;
  }): Promise<string[]> {
    const nowMs = this.clock.now();
    const now = new Date(nowMs);
    await this.verifyPassword(input.accountId, input.password, now, input.ipHmac);

    const factor = (await this.mfa.listFactorsByAccount(input.accountId))[0];
    if (factor === undefined) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'No enabled MFA factor' }, 404);
    }

    const codes = generateRecoveryCodes(this.random, RECOVERY_CODE_COUNT);
    await this.db.transaction(async (tx) => {
      await this.mfa.deleteUnusedByFactorTx(tx, factor.id);
      await this.mfa.insertRecoveryCodesTx(
        tx,
        factor.id,
        input.accountId,
        codes.map((code) => ({
          id: this.random.uuid(),
          digest: this.digester.digest('recovery', code),
        })),
        now,
      );
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'mfa.recovery_codes_regenerated',
        accountId: input.accountId,
        severity: 'info',
        reason: 'MFA_RECOVERY_CODES_REGENERATED',
        ipHmac: input.ipHmac,
        now,
      });
    });
    return codes;
  }

  /**
   * Disable: password PLUS a fresh TOTP code or an unused recovery code,
   * then the factor flips to `disabled`, its unused codes die, the account's
   * other sessions are revoked and the current session rotates to AAL1.
   */
  async disableTotp(input: {
    token: string;
    accountId: string;
    password: string;
    totpCode: string | undefined;
    recoveryCode: string | undefined;
    ipHmac: string;
  }): Promise<RotatedSession> {
    const nowMs = this.clock.now();
    const now = new Date(nowMs);
    await this.verifyPassword(input.accountId, input.password, now, input.ipHmac);

    const factor = (await this.mfa.listFactorsByAccount(input.accountId))[0];
    if (factor === undefined) {
      throw new HttpException({ code: 'NOT_FOUND', message: 'No enabled MFA factor' }, 404);
    }

    let secondFactorOk: boolean;
    let secondFactorReason: 'MFA_INVALID' | 'RECOVERY_CODE_INVALID';
    if (input.totpCode !== undefined) {
      const secret = this.cipher.decrypt({
        keyId: factor.secretKeyId,
        nonce: factor.secretNonce,
        ciphertext: factor.secretCiphertext,
      });
      secondFactorOk = this.auth.verifyTotp(secret, input.totpCode, Math.floor(nowMs / 1000));
      secondFactorReason = 'MFA_INVALID';
    } else {
      const code = normalizeRecoveryCode(input.recoveryCode ?? '');
      const row = await this.mfa.findUnusedRecoveryCode(this.digester.digest('recovery', code));
      secondFactorOk =
        row !== null && row.accountId === input.accountId && row.factorId === factor.id;
      secondFactorReason = 'RECOVERY_CODE_INVALID';
    }
    if (!secondFactorOk) {
      await this.audit.appendSecurityEvent({
        eventType: 'mfa.disable_failed',
        accountId: input.accountId,
        severity: 'warning',
        reason: secondFactorReason,
        ipHmac: input.ipHmac,
        now,
      });
      throw secondFactorReason === 'MFA_INVALID' ? mfaInvalid() : recoveryCodeInvalid();
    }

    const outcome = await this.db.transaction(async (tx) => {
      // The recovery code is consumed inside the same tx — one code can only
      // complete one disable, even under concurrency (the loser sees
      // rowCount 0 and fails before any write happened in this tx).
      if (input.recoveryCode !== undefined) {
        const consumed = await this.mfa.consumeRecoveryCode(
          tx,
          this.digester.digest('recovery', normalizeRecoveryCode(input.recoveryCode)),
          now,
        );
        if (!consumed) {
          throw recoveryCodeInvalid();
        }
      }
      await this.mfa.setFactorDisabledTx(tx, factor.id, now);
      await this.mfa.deleteUnusedByFactorTx(tx, factor.id);
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'mfa.disabled',
        accountId: input.accountId,
        severity: 'info',
        reason: 'MFA_DISABLED',
        ipHmac: input.ipHmac,
        now,
      });
      return this.sessionService.rotateInTx(tx, {
        token: input.token,
        ipHmac: input.ipHmac,
        authLevel: 'aal1',
        revokeOthers: true,
      });
    });
    throwOutcome(outcome);
    return outcome.session;
  }

  /**
   * MFA login completion (POST /v1/account/sessions/mfa): consumes the
   * single-use challenge cookie, verifies the TOTP/recovery code and issues
   * an AAL2 session. Wrong codes count against the 5-attempt budget; an
   * expired or already-consumed challenge can never complete.
   */
  async completeMfaLogin(input: {
    challengeToken: string;
    totpCode: string | undefined;
    recoveryCode: string | undefined;
    deviceToken: string | null;
    userAgent: string | null;
    ipHmac: string;
    /** Raw client IP for device persistence — truncated to a prefix inside DeviceService. */
    ip: string;
  }): Promise<{ session: IssuedSession; deviceToken: string }> {
    const nowMs = this.clock.now();
    const now = new Date(nowMs);
    const challenge = await this.mfa.findChallengeByDigest(
      this.digester.digest('challenge', input.challengeToken),
    );
    if (challenge === null || challenge.state === 'consumed' || challenge.state === 'revoked') {
      // Unknown or already-used challenge token — uniformly invalid.
      throw mfaInvalid();
    }
    if (challenge.state === 'expired' || challenge.expiresAt.getTime() <= nowMs) {
      throw mfaChallengeExpired();
    }

    const account = await this.accounts.findById(challenge.accountId);
    if (account === null || !this.accountState.canAuthenticate(account.state)) {
      // A mid-challenge state denial burns the challenge (no retry) and
      // answers the same uniform code as every other anonymous failure.
      await this.mfa.consumeChallenge(this.db, challenge.id, now);
      await this.audit.appendSecurityEvent({
        eventType: 'login.invalid_credentials',
        accountId: challenge.accountId,
        severity: 'warning',
        reason:
          account === null
            ? 'INVALID_CREDENTIALS_UNKNOWN_EMAIL'
            : this.accountState.deniedLoginReason(account.state),
        ipHmac: input.ipHmac,
        now,
      });
      throw invalidCredentials();
    }

    const denied = await this.rateLimiter.consume(
      `mfa:email:${account.emailDigest}`,
      this.config.iam.rateLimit.loginEmailMax,
      this.config.iam.rateLimit.emailWindowSeconds,
    );
    if (!denied.allowed) {
      throw rateLimited(denied.retryAfterSeconds);
    }

    // R1-06A/R2-04: every pending challenge is bound to the password-step
    // device. NULL is historical/corrupt and fails closed. A mismatch is
    // audited but does not burn the victim's code-attempt budget.
    let deviceMatches = false;
    if (challenge.deviceId !== null && input.deviceToken !== null) {
      const presented = await this.devices.findByAccountAndDigest(
        account.id,
        this.digester.digest('device', input.deviceToken),
      );
      deviceMatches = presented !== null && presented.id === challenge.deviceId;
    }
    if (!deviceMatches) {
      await this.audit.appendSecurityEvent({
        eventType: 'mfa.challenge_failed',
        accountId: account.id,
        severity: 'warning',
        reason: 'MFA_DEVICE_MISMATCH',
        ipHmac: input.ipHmac,
        now,
      });
      throw mfaInvalid();
    }

    let codeValid: boolean;
    let failureReason: 'MFA_INVALID' | 'RECOVERY_CODE_INVALID';
    if (input.totpCode !== undefined) {
      // R1-06A: the challenge only accepts the methods listed at issuance.
      if (!challenge.methodSet.includes('totp')) {
        codeValid = false;
        failureReason = 'MFA_INVALID';
      } else {
        const factor = (await this.mfa.listFactorsByAccount(account.id))[0];
        codeValid =
          factor !== undefined &&
          this.auth.verifyTotp(
            this.cipher.decrypt({
              keyId: factor.secretKeyId,
              nonce: factor.secretNonce,
              ciphertext: factor.secretCiphertext,
            }),
            input.totpCode,
            Math.floor(nowMs / 1000),
          );
        failureReason = 'MFA_INVALID';
      }
    } else {
      if (!challenge.methodSet.includes('recovery')) {
        codeValid = false;
        failureReason = 'RECOVERY_CODE_INVALID';
      } else {
        const code = normalizeRecoveryCode(input.recoveryCode ?? '');
        const row = await this.mfa.findUnusedRecoveryCode(this.digester.digest('recovery', code));
        const factor =
          row === null ? null : await this.mfa.findFactorById(account.id, row.factorId);
        codeValid =
          row !== null &&
          row.accountId === account.id &&
          factor !== null &&
          factor.state === 'enabled';
        failureReason = 'RECOVERY_CODE_INVALID';
      }
    }
    if (!codeValid) {
      // R1-05: atomic capped accounting — only a pending challenge with
      // budget left increments; the miss that exhausts the budget flips the
      // challenge to expired and is answered as EXPIRED (client clears the
      // cookie), and a concurrently consumed/exhausted challenge never
      // counts. No path can exceed max_attempts or answer 500.
      const outcome = await this.mfa.recordChallengeAttempt(
        this.db,
        challenge.id,
        challenge.maxAttempts,
      );
      await this.audit.appendSecurityEvent({
        eventType: 'mfa.challenge_failed',
        accountId: account.id,
        severity: 'warning',
        reason: failureReason,
        ipHmac: input.ipHmac,
        now,
      });
      if (outcome !== 'recorded') {
        throw mfaChallengeExpired();
      }
      throw failureReason === 'RECOVERY_CODE_INVALID' ? recoveryCodeInvalid() : mfaInvalid();
    }

    // Single-shot gate: exactly one concurrent completion consumes the
    // challenge; a replay of the cookie afterwards always fails.
    const consumed = await this.mfa.consumeChallenge(this.db, challenge.id, now);
    if (!consumed) {
      throw mfaInvalid();
    }

    // Recovery codes are one-time credentials: a spent code (raced between the
    // check above and this UPDATE ... WHERE used_at IS NULL) cannot complete a
    // login. The challenge is already burned by then — a spent-code attempt
    // never issues a session.
    if (input.recoveryCode !== undefined) {
      const codeConsumed = await this.mfa.consumeRecoveryCode(
        this.db,
        this.digester.digest('recovery', normalizeRecoveryCode(input.recoveryCode)),
        now,
      );
      if (!codeConsumed) {
        throw recoveryCodeInvalid();
      }
    }

    const device = await this.deviceService.touchForLogin({
      accountId: account.id,
      deviceToken: input.deviceToken,
      userAgent: input.userAgent,
      ip: input.ip,
      nowMs,
    });
    const session = await this.sessionService.issueSession({
      accountId: account.id,
      authLevel: 'aal2',
      deviceId: device.device.id,
      ipHmac: input.ipHmac,
      nowMs,
      auditEvent: { eventType: 'mfa.login_success', reason: 'MFA_LOGIN_SUCCESS' },
    });
    return { session, deviceToken: device.deviceToken };
  }

  /** Password re-verification for MFA management — authenticated failure → INVALID_PASSWORD. */
  private async verifyPassword(
    accountId: string,
    password: string,
    now: Date,
    ipHmac: string,
  ): Promise<void> {
    const credential = await this.passwords.findByAccountId(accountId);
    if (credential === null) {
      await this.audit.appendSecurityEvent({
        eventType: 'account.password_verification_failed',
        accountId,
        severity: 'critical',
        reason: 'INVALID_PASSWORD_MISSING_CREDENTIAL',
        ipHmac,
        now,
      });
      throw invalidPassword();
    }
    const valid = await this.auth.verifyPassword(credential.hash, password);
    if (!valid) {
      await this.audit.appendSecurityEvent({
        eventType: 'account.password_verification_failed',
        accountId,
        severity: 'warning',
        reason: 'INVALID_PASSWORD',
        ipHmac,
        now,
      });
      throw invalidPassword();
    }
  }
}

/** XXXX-XXXX-XXXX-XXXX codes from the unambiguous 32-symbol alphabet. */
export function generateRecoveryCodes(random: RandomSource, count: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = random.bytes(16);
    let code = '';
    for (const byte of bytes) {
      code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length] as string;
    }
    codes.push(
      `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`,
    );
  }
  return codes;
}

/** Canonical uppercase form — digests are computed over this. */
function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase();
}

function throwOutcome(
  outcome: RotateOutcome,
): asserts outcome is { kind: 'rotated'; session: RotatedSession } {
  if (outcome.kind === 'replay') {
    throw replayDetected();
  }
  if (outcome.kind === 'denied') {
    throw accountStateDenied();
  }
}

/** Wrong TOTP code, or the challenge attempts are exhausted. */
export function mfaInvalid(): HttpException {
  return new HttpException({ code: 'MFA_INVALID', message: 'Invalid MFA code' }, 401);
}

/** The MFA challenge expired before completion. */
export function mfaChallengeExpired(): HttpException {
  return new HttpException(
    { code: 'MFA_CHALLENGE_EXPIRED', message: 'MFA challenge expired' },
    401,
  );
}

/** Wrong, already-used or stale recovery code. */
export function recoveryCodeInvalid(): HttpException {
  return new HttpException(
    { code: 'RECOVERY_CODE_INVALID', message: 'Invalid recovery code' },
    401,
  );
}

/** Password re-verification failed on an MFA management action. */
export function invalidPassword(): HttpException {
  return new HttpException({ code: 'INVALID_PASSWORD', message: 'Invalid password' }, 401);
}

/** An enabled TOTP factor already exists. */
export function mfaAlreadyEnabled(): HttpException {
  return new HttpException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled' }, 409);
}

/** A PENDING enrollment already occupies the slot — confirm or abandon it first. */
export function mfaEnrollmentInProgress(): HttpException {
  return new HttpException(
    { code: 'MFA_ENROLLMENT_IN_PROGRESS', message: 'MFA enrollment already in progress' },
    409,
  );
}
