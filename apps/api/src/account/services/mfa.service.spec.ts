import { describe, expect, it, vi } from 'vitest';
import { TOTP } from 'otpauth';
import { loadEnv, type AppConfig } from '@wai/config';
import { FactorSlotTakenError, parsePepper, type Db } from '@wai/db';
import {
  DeterministicRandomSource,
  FakeRateLimiter,
  FixedClock,
  MockAuthProvider,
} from '@wai/testkit';
import { NodeTokenDigester } from '../infra/node-token-digester.js';
import { AccountStateService } from './account-state.service.js';
import { DeviceService } from './device.service.js';
import {
  expectHttpException,
  FakeAccountRepository,
  FakeAuditRepository,
  FakeDeviceRepository,
  FakeMfaRepository,
  FakePasswordCredentialRepository,
  FakeSecretCipher,
  FakeSessionRepository,
  makeAccountRow,
  makeDeviceRow,
  makeMfaChallengeRow,
  makeMfaFactorRow,
  makeRecoveryCodeRow,
  makeSessionRow,
} from './spec-helpers.js';
import { MfaService } from './mfa.service.js';
import { SessionService } from './session.service.js';

const CODE_FORMAT = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const AT_MS = 1_000_000;
const DEFAULT_CHALLENGE_DEVICE_TOKEN = 'D'.repeat(43);

/** The code MockAuthProvider.verifyTotp accepts at `atMs` (its ±1 window). */
function totpCode(secret: string, atMs: number): string {
  const atSeconds = Math.floor(atMs / 1000);
  return new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 }).generate({
    timestamp: atSeconds * 1000,
  });
}

/**
 * CP5 unit spec for MfaService (task book §8). Fixed clock at 1_000_000 makes
 * the TOTP window boundaries exact (±1 step), the 5-attempt challenge budget
 * deterministic, and every strength change observable in the session fakes:
 * enable → other sessions revoked + current rotated to aal2, disable → aal1.
 * Replay/denied outcomes are thrown AFTER the transaction commits, so the
 * factor change + audit events survive the client-facing 401.
 */
function setup(): {
  config: AppConfig;
  accounts: FakeAccountRepository;
  passwords: FakePasswordCredentialRepository;
  mfa: FakeMfaRepository;
  audit: FakeAuditRepository;
  sessions: FakeSessionRepository;
  devices: FakeDeviceRepository;
  digester: NodeTokenDigester;
  clock: FixedClock;
  auth: MockAuthProvider;
  rateLimiter: FakeRateLimiter;
  service: MfaService;
} {
  const config = loadEnv({ NODE_ENV: 'test', LOG_PRETTY: 'false' });
  const clock = new FixedClock(AT_MS);
  const digester = new NodeTokenDigester(parsePepper(config.iam.secretPepper));
  const accounts = new FakeAccountRepository();
  const passwords = new FakePasswordCredentialRepository();
  const mfa = new FakeMfaRepository();
  const audit = new FakeAuditRepository();
  const sessions = new FakeSessionRepository();
  const devices = new FakeDeviceRepository();
  const auth = new MockAuthProvider();
  const rateLimiter = new FakeRateLimiter(clock);
  const db = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Db;
  const accountState = new AccountStateService();
  const sessionService = new SessionService(
    config,
    sessions,
    accounts,
    audit,
    db,
    digester,
    clock,
    new DeterministicRandomSource(),
    accountState,
  );
  const deviceService = new DeviceService(
    devices,
    sessions,
    audit,
    db,
    digester,
    new DeterministicRandomSource(),
    clock,
  );
  const service = new MfaService(
    config,
    accounts,
    passwords,
    mfa,
    devices,
    audit,
    auth,
    new FakeSecretCipher(),
    digester,
    rateLimiter,
    clock,
    new DeterministicRandomSource(),
    db,
    accountState,
    sessionService,
    deviceService,
  );
  return {
    config,
    accounts,
    passwords,
    mfa,
    audit,
    sessions,
    devices,
    digester,
    clock,
    auth,
    rateLimiter,
    service,
  };
}

async function seedAccount(
  s: ReturnType<typeof setup>,
  accountId = 'account-1',
  email = 'alice@example.com',
  password = 'password-1',
): Promise<void> {
  s.accounts.seed(makeAccountRow({ id: accountId, emailCiphertext: `enc:${email}` }));
  await s.passwords.upsert(accountId, await s.auth.hashPassword(password), new Date(AT_MS));
}

function seedSession(
  s: ReturnType<typeof setup>,
  token: string,
  accountId = 'account-1',
  overrides: Partial<Parameters<typeof makeSessionRow>[0]> = {},
): void {
  s.sessions.seed(
    makeSessionRow({
      id: overrides.id ?? `session-${token}`,
      accountId,
      tokenDigest: s.digester.digest('session', token),
      ...overrides,
    }),
  );
}

function seedChallenge(
  s: ReturnType<typeof setup>,
  token: string,
  accountId = 'account-1',
  overrides: Partial<Parameters<typeof makeMfaChallengeRow>[0]> = {},
): void {
  const hasExplicitDevice = Object.prototype.hasOwnProperty.call(overrides, 'deviceId');
  const deviceId = hasExplicitDevice ? (overrides.deviceId ?? null) : 'device-challenge-default';
  if (deviceId !== null && !s.devices.rows.has(deviceId)) {
    seedDevice(s, DEFAULT_CHALLENGE_DEVICE_TOKEN, deviceId);
  }
  const row = makeMfaChallengeRow({
    id: overrides.id ?? `challenge-${token}`,
    accountId,
    digest: s.digester.digest('challenge', token),
    deviceId,
    ...overrides,
  });
  s.mfa.challenges.set(row.id, row);
  s.mfa.byChallengeDigest.set(row.digest, row);
}

/** Seed a device row whose digest matches the given cookie token. */
function seedDevice(s: ReturnType<typeof setup>, token: string, id = `device-${token}`): string {
  s.devices.seed(
    makeDeviceRow({
      id,
      accountId: 'account-1',
      deviceDigest: s.digester.digest('device', token),
    }),
  );
  return id;
}

/** startEnrollment + recover the plaintext secret the fake stored. */
async function enroll(
  s: ReturnType<typeof setup>,
  accountId = 'account-1',
  password = 'password-1',
): Promise<{ factorId: string; secret: string }> {
  const result = await s.service.startEnrollment({ accountId, password, ipHmac: 'ip-a' });
  const insert = s.mfa.factorInserts.at(-1);
  if (insert === undefined) {
    throw new Error('no factor inserted');
  }
  return { factorId: result.factorId, secret: insert.secretCiphertext.slice(4) };
}

function expectCodeFormat(codes: string[]): void {
  expect(codes).toHaveLength(10);
  for (const code of codes) {
    expect(code).toMatch(CODE_FORMAT);
  }
  expect(new Set(codes).size).toBe(10);
}

describe('MfaService', () => {
  describe('startEnrollment', () => {
    it('stores a PENDING encrypted factor and returns the otpauth URI exactly once', async () => {
      const s = setup();
      await seedAccount(s);

      const result = await s.service.startEnrollment({
        accountId: 'account-1',
        password: 'password-1',
        ipHmac: 'ip-a',
      });

      const factor = s.mfa.factors.get(result.factorId);
      expect(factor?.state).toBe('pending');
      expect(factor?.secretCiphertext).toMatch(/^enc:/);
      expect(result.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
      expect(decodeURIComponent(result.otpauthUri)).toContain('alice@example.com');
      expect(result.otpauthUri).toContain('account=account-1');
      expect(s.audit.events.some((e) => e.eventType === 'mfa.enrollment_started')).toBe(true);
    });

    it('rejects when an enabled factor already exists', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ state: 'enabled' }));

      try {
        await s.service.startEnrollment({
          accountId: 'account-1',
          password: 'password-1',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 409, 'MFA_ALREADY_ENABLED');
      }
      expect(s.mfa.factorInserts).toHaveLength(0);
    });

    it('rejects a second start while a PENDING enrollment occupies the slot (R1-04)', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ state: 'pending' }));

      try {
        await s.service.startEnrollment({
          accountId: 'account-1',
          password: 'password-1',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 409, 'MFA_ENROLLMENT_IN_PROGRESS');
      }
      expect(s.mfa.factorInserts).toHaveLength(0);
    });

    it('maps a unique-slot race to 409 without ever leaking the pg error (R1-04)', async () => {
      const s = setup();
      await seedAccount(s);
      // Simulate the partial unique index firing between check and insert.
      const activeReads = vi.spyOn(s.mfa, 'listActiveFactorsByAccountTx');
      vi.spyOn(s.mfa, 'insertFactorTx').mockRejectedValueOnce(new FactorSlotTakenError());

      try {
        await s.service.startEnrollment({
          accountId: 'account-1',
          password: 'password-1',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 409, 'MFA_ENROLLMENT_IN_PROGRESS');
      }
      // PostgreSQL aborts a transaction after 23505. A second query in the
      // catch block would itself fail with "current transaction is aborted".
      expect(activeReads).toHaveBeenCalledTimes(1);
    });

    it('allows re-enrollment after the factor is disabled (R1-04)', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(
        makeMfaFactorRow({
          id: 'factor-1',
          state: 'enabled',
          secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
        }),
      );
      seedSession(s, 'current-token', 'account-1', { authLevel: 'aal2' });
      await s.service.disableTotp({
        token: 'current-token',
        accountId: 'account-1',
        password: 'password-1',
        totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
        recoveryCode: undefined,
        ipHmac: 'ip-a',
      });

      const result = await s.service.startEnrollment({
        accountId: 'account-1',
        password: 'password-1',
        ipHmac: 'ip-a',
      });

      expect(s.mfa.factors.get(result.factorId)?.state).toBe('pending');
      expect(s.mfa.factors.get('factor-1')?.state).toBe('disabled');
    });

    it('rejects a wrong password without creating a factor', async () => {
      const s = setup();
      await seedAccount(s);

      try {
        await s.service.startEnrollment({
          accountId: 'account-1',
          password: 'wrong',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'INVALID_PASSWORD');
      }
      expect(s.mfa.factorInserts).toHaveLength(0);
      expect(
        s.audit.events.some((e) => e.eventType === 'account.password_verification_failed'),
      ).toBe(true);
    });

    it('rejects when no password credential exists', async () => {
      const s = setup();
      s.accounts.seed(makeAccountRow({}));

      try {
        await s.service.startEnrollment({
          accountId: 'account-1',
          password: 'password-1',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'INVALID_PASSWORD');
      }
    });
  });

  describe('confirmEnrollment', () => {
    it('enables the factor, mints 10 digests and rotates the session to aal2, revoking others', async () => {
      const s = setup();
      await seedAccount(s);
      const { factorId } = await enroll(s);
      const secret = s.mfa.factors.get(factorId)?.secretCiphertext.slice(4) as string;
      seedSession(s, 'current-token', 'account-1', { authLevel: 'aal1' });
      seedSession(s, 'other-token', 'account-1', { id: 'session-other', authLevel: 'aal1' });

      const result = await s.service.confirmEnrollment({
        token: 'current-token',
        accountId: 'account-1',
        totpCode: totpCode(secret, AT_MS),
        ipHmac: 'ip-a',
      });

      expect(s.mfa.factors.get(factorId)?.state).toBe('enabled');
      expectCodeFormat(result.recoveryCodes);
      expect(result.recoveryCodes).toEqual(result.recoveryCodes.map((c) => c.toUpperCase()));
      expect(s.mfa.recoveryCodes).toHaveLength(10);
      for (const code of result.recoveryCodes) {
        expect(
          s.mfa.recoveryCodes.some((row) => row.codeDigest === s.digester.digest('recovery', code)),
        ).toBe(true);
      }
      expect(result.rotated.authLevel).toBe('aal2');
      expect(result.rotated.generation).toBe(2);
      expect(result.rotated.token).not.toBe('current-token');
      expect(s.sessions.rows.get('session-current-token')?.state).toBe('rotated');
      expect(s.sessions.rows.get('session-other')?.state).toBe('revoked');
      expect(s.sessions.rows.get('session-other')?.revokedReason).toBe('mfa_strength_change');
      expect(s.audit.events.some((e) => e.eventType === 'mfa.enabled')).toBe(true);
      expect(
        s.audit.events.some(
          (e) => e.eventType === 'session.rotated' && e.reason === 'SESSION_ROTATED_MFA_CHANGE',
        ),
      ).toBe(true);
    });

    it('rejects a wrong TOTP code and leaves the factor pending', async () => {
      const s = setup();
      await seedAccount(s);
      const { factorId } = await enroll(s);
      seedSession(s, 'current-token', 'account-1');

      try {
        await s.service.confirmEnrollment({
          token: 'current-token',
          accountId: 'account-1',
          totpCode: '000000',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
      expect(s.mfa.factors.get(factorId)?.state).toBe('pending');
      expect(s.audit.events.some((e) => e.eventType === 'mfa.enrollment_failed')).toBe(true);
    });

    it('accepts a code from the previous 30s window at the boundary', async () => {
      const s = setup();
      await seedAccount(s);
      const { factorId } = await enroll(s);
      const secret = s.mfa.factors.get(factorId)?.secretCiphertext.slice(4) as string;
      seedSession(s, 'current-token', 'account-1');

      const result = await s.service.confirmEnrollment({
        token: 'current-token',
        accountId: 'account-1',
        totpCode: totpCode(secret, AT_MS - 30_000),
        ipHmac: 'ip-a',
      });

      expect(s.mfa.factors.get(factorId)?.state).toBe('enabled');
      expect(result.rotated.authLevel).toBe('aal2');
    });

    it('rejects a code two windows away', async () => {
      const s = setup();
      await seedAccount(s);
      const { factorId } = await enroll(s);
      const secret = s.mfa.factors.get(factorId)?.secretCiphertext.slice(4) as string;
      seedSession(s, 'current-token', 'account-1');

      try {
        await s.service.confirmEnrollment({
          token: 'current-token',
          accountId: 'account-1',
          totpCode: totpCode(secret, AT_MS - 60_000),
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
    });

    it('404 when there is no pending factor', async () => {
      const s = setup();
      await seedAccount(s);
      seedSession(s, 'current-token', 'account-1');

      try {
        await s.service.confirmEnrollment({
          token: 'current-token',
          accountId: 'account-1',
          totpCode: '123456',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 404, 'NOT_FOUND');
      }
    });

    it('409 when the pending→enabled gate loses under concurrency', async () => {
      const s = setup();
      await seedAccount(s);
      const { factorId } = await enroll(s);
      const secret = s.mfa.factors.get(factorId)?.secretCiphertext.slice(4) as string;
      seedSession(s, 'current-token', 'account-1');
      vi.spyOn(s.mfa, 'setFactorEnabledTx').mockResolvedValueOnce(null);

      try {
        await s.service.confirmEnrollment({
          token: 'current-token',
          accountId: 'account-1',
          totpCode: totpCode(secret, AT_MS),
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 409, 'MFA_ALREADY_ENABLED');
      }
      expect(s.mfa.factors.get(factorId)?.state).toBe('pending');
      expect(s.mfa.recoveryCodes).toHaveLength(0);
    });

    it('replay of a rotated session still commits the enrollment but answers SESSION_REPLAY_DETECTED', async () => {
      const s = setup();
      await seedAccount(s);
      const { factorId } = await enroll(s);
      const secret = s.mfa.factors.get(factorId)?.secretCiphertext.slice(4) as string;
      seedSession(s, 'current-token', 'account-1', { state: 'rotated' });

      try {
        await s.service.confirmEnrollment({
          token: 'current-token',
          accountId: 'account-1',
          totpCode: totpCode(secret, AT_MS),
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'SESSION_REPLAY_DETECTED');
      }
      // The factor change COMMITTED (thrown only after the tx) — safety
      // events survive the client-facing 401.
      expect(s.mfa.factors.get(factorId)?.state).toBe('enabled');
      expect(s.mfa.recoveryCodes).toHaveLength(10);
      expect(s.audit.events.some((e) => e.eventType === 'session.replay_detected')).toBe(true);
    });
  });

  describe('regenerateRecoveryCodes', () => {
    it('requires password re-verification', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ state: 'enabled' }));

      try {
        await s.service.regenerateRecoveryCodes({
          accountId: 'account-1',
          password: 'wrong',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'INVALID_PASSWORD');
      }
    });

    it('404 when no enabled factor exists', async () => {
      const s = setup();
      await seedAccount(s);

      try {
        await s.service.regenerateRecoveryCodes({
          accountId: 'account-1',
          password: 'password-1',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 404, 'NOT_FOUND');
      }
    });

    it('mints 10 fresh codes and kills every UNUSED old code; used codes remain', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ id: 'factor-1', state: 'enabled' }));
      s.mfa.recoveryCodes.push(
        makeRecoveryCodeRow({ id: 'old-unused', codeDigest: 'old-unused-digest' }),
      );
      s.mfa.recoveryCodes.push(
        makeRecoveryCodeRow({
          id: 'old-used',
          codeDigest: 'old-used-digest',
          usedAt: new Date(AT_MS),
        }),
      );

      const codes = await s.service.regenerateRecoveryCodes({
        accountId: 'account-1',
        password: 'password-1',
        ipHmac: 'ip-a',
      });

      expectCodeFormat(codes);
      expect(s.mfa.recoveryCodes.some((row) => row.id === 'old-unused')).toBe(false);
      expect(s.mfa.recoveryCodes.some((row) => row.id === 'old-used')).toBe(true);
      expect(s.mfa.recoveryCodes).toHaveLength(11);
      expect(s.audit.events.some((e) => e.eventType === 'mfa.recovery_codes_regenerated')).toBe(
        true,
      );
    });
  });

  describe('disableTotp', () => {
    it('requires password re-verification', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ state: 'enabled' }));

      try {
        await s.service.disableTotp({
          token: 'current-token',
          accountId: 'account-1',
          password: 'wrong',
          totpCode: '123456',
          recoveryCode: undefined,
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'INVALID_PASSWORD');
      }
    });

    it('404 when no enabled factor exists', async () => {
      const s = setup();
      await seedAccount(s);
      seedSession(s, 'current-token', 'account-1');

      try {
        await s.service.disableTotp({
          token: 'current-token',
          accountId: 'account-1',
          password: 'password-1',
          totpCode: '123456',
          recoveryCode: undefined,
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 404, 'NOT_FOUND');
      }
    });

    it('rejects a wrong TOTP code', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ state: 'enabled' }));
      seedSession(s, 'current-token', 'account-1');

      try {
        await s.service.disableTotp({
          token: 'current-token',
          accountId: 'account-1',
          password: 'password-1',
          totpCode: '000000',
          recoveryCode: undefined,
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
      expect(s.mfa.factors.get('factor-1')?.state).toBe('enabled');
      expect(s.audit.events.some((e) => e.eventType === 'mfa.disable_failed')).toBe(true);
    });

    it('rejects a wrong recovery code', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ state: 'enabled' }));
      seedSession(s, 'current-token', 'account-1');

      try {
        await s.service.disableTotp({
          token: 'current-token',
          accountId: 'account-1',
          password: 'password-1',
          totpCode: undefined,
          recoveryCode: 'AAAA-AAAA-AAAA-AAAA',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'RECOVERY_CODE_INVALID');
      }
    });

    it('rejects a recovery code from another account', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ state: 'enabled' }));
      s.mfa.recoveryCodes.push(
        makeRecoveryCodeRow({
          id: 'other-code',
          accountId: 'account-other',
          codeDigest: 'other-digest',
        }),
      );
      seedSession(s, 'current-token', 'account-1');

      try {
        await s.service.disableTotp({
          token: 'current-token',
          accountId: 'account-1',
          password: 'password-1',
          totpCode: undefined,
          recoveryCode: 'XXXX-XXXX-XXXX-XXXX',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'RECOVERY_CODE_INVALID');
      }
    });

    it('disables with a valid TOTP: factor disabled, unused codes deleted, session rotated to aal1, others revoked', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(
        makeMfaFactorRow({
          id: 'factor-1',
          state: 'enabled',
          secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
        }),
      );
      s.mfa.recoveryCodes.push(makeRecoveryCodeRow({ id: 'unused', codeDigest: 'unused-digest' }));
      seedSession(s, 'current-token', 'account-1', { authLevel: 'aal2' });
      seedSession(s, 'other-token', 'account-1', { id: 'session-other', authLevel: 'aal2' });

      const rotated = await s.service.disableTotp({
        token: 'current-token',
        accountId: 'account-1',
        password: 'password-1',
        totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
        recoveryCode: undefined,
        ipHmac: 'ip-a',
      });

      expect(s.mfa.factors.get('factor-1')?.state).toBe('disabled');
      expect(s.mfa.recoveryCodes.some((row) => row.id === 'unused')).toBe(false);
      expect(rotated.authLevel).toBe('aal1');
      expect(s.sessions.rows.get('session-other')?.state).toBe('revoked');
      expect(s.audit.events.some((e) => e.eventType === 'mfa.disabled')).toBe(true);
    });

    it('disables with a valid recovery code and consumes it', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ id: 'factor-1', state: 'enabled' }));
      const codeDigest = s.digester.digest('recovery', 'ABCD-2345-ABCD-2345');
      s.mfa.recoveryCodes.push(makeRecoveryCodeRow({ id: 'code-1', codeDigest }));
      seedSession(s, 'current-token', 'account-1', { authLevel: 'aal2' });

      const rotated = await s.service.disableTotp({
        token: 'current-token',
        accountId: 'account-1',
        password: 'password-1',
        totpCode: undefined,
        recoveryCode: 'abcd-2345-abcd-2345', // lowercase input normalizes
        ipHmac: 'ip-a',
      });

      expect(s.mfa.factors.get('factor-1')?.state).toBe('disabled');
      expect(s.mfa.recoveryCodes.find((row) => row.id === 'code-1')?.usedAt).not.toBeNull();
      expect(rotated.authLevel).toBe('aal1');
    });

    it('a spent recovery code loses the race (concurrent disable)', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(makeMfaFactorRow({ id: 'factor-1', state: 'enabled' }));
      const codeDigest = s.digester.digest('recovery', 'ABCD-2345-ABCD-2345');
      s.mfa.recoveryCodes.push(makeRecoveryCodeRow({ id: 'code-1', codeDigest }));
      seedSession(s, 'current-token', 'account-1', { authLevel: 'aal2' });
      vi.spyOn(s.mfa, 'consumeRecoveryCode').mockResolvedValueOnce(false);

      try {
        await s.service.disableTotp({
          token: 'current-token',
          accountId: 'account-1',
          password: 'password-1',
          totpCode: undefined,
          recoveryCode: 'ABCD-2345-ABCD-2345',
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'RECOVERY_CODE_INVALID');
      }
      expect(s.mfa.factors.get('factor-1')?.state).toBe('enabled');
      expect(s.sessions.rows.get('session-current-token')?.state).toBe('active');
    });

    it('replay of a rotated session still commits the disable but answers SESSION_REPLAY_DETECTED', async () => {
      const s = setup();
      await seedAccount(s);
      s.mfa.seedFactor(
        makeMfaFactorRow({
          id: 'factor-1',
          state: 'enabled',
          secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
        }),
      );
      seedSession(s, 'current-token', 'account-1', { state: 'rotated' });

      try {
        await s.service.disableTotp({
          token: 'current-token',
          accountId: 'account-1',
          password: 'password-1',
          totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
          recoveryCode: undefined,
          ipHmac: 'ip-a',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'SESSION_REPLAY_DETECTED');
      }
      expect(s.mfa.factors.get('factor-1')?.state).toBe('disabled');
      expect(s.audit.events.some((e) => e.eventType === 'session.replay_detected')).toBe(true);
    });
  });

  describe('completeMfaLogin', () => {
    it('rejects an unknown challenge token', async () => {
      const s = setup();
      await seedAccount(s);

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'nope',
          totpCode: '123456',
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
    });

    it('rejects a consumed challenge (replay)', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1', { state: 'consumed' });

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: '123456',
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
    });

    it('rejects an expired challenge', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1', { state: 'expired' });

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: '123456',
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_CHALLENGE_EXPIRED');
      }
    });

    it('burns the challenge and answers INVALID_CREDENTIALS when the account is suspended mid-challenge', async () => {
      const s = setup();
      await seedAccount(s, 'account-1', 'alice@example.com', 'password-1');
      seedChallenge(s, 'challenge-token', 'account-1');
      const account = s.accounts.accounts.get('account-1');
      if (account === undefined) {
        throw new Error('no account');
      }
      s.accounts.accounts.set('account-1', { ...account, state: 'suspended' });

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: '123456',
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'INVALID_CREDENTIALS');
      }
      expect(s.mfa.challenges.get('challenge-challenge-token')?.state).toBe('consumed');
      expect(
        s.audit.events.some(
          (e) =>
            e.eventType === 'login.invalid_credentials' &&
            e.reason === 'ACCOUNT_STATE_DENIED_SUSPENDED',
        ),
      ).toBe(true);
    });

    it('rate limit exceeded answers 429 RATE_LIMITED', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1');
      vi.spyOn(s.rateLimiter, 'consume').mockResolvedValueOnce({
        allowed: false,
        retryAfterSeconds: 42,
      });

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: '123456',
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 429, 'RATE_LIMITED');
      }
      expect(s.mfa.challenges.get('challenge-challenge-token')?.state).toBe('pending');
    });

    it('counts wrong codes; the 5th miss expires the challenge and the 6th answers MFA_CHALLENGE_EXPIRED', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1');
      const id = s.mfa.challenges.get('challenge-challenge-token')?.id as string;

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          await s.service.completeMfaLogin({
            challengeToken: 'challenge-token',
            totpCode: '000000',
            recoveryCode: undefined,
            deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
            userAgent: null,
            ipHmac: 'ip-a',
            ip: '1.2.3.4',
          });
          expect.unreachable('must throw');
        } catch (error) {
          // R1-05: the miss that burns the last budget attempt answers
          // MFA_CHALLENGE_EXPIRED — the challenge is dead and the client
          // clears the cookie; earlier misses keep MFA_INVALID.
          expectHttpException(error, 401, attempt < 5 ? 'MFA_INVALID' : 'MFA_CHALLENGE_EXPIRED');
        }
        expect(s.mfa.challenges.get(id)?.attemptCount).toBe(attempt);
      }
      expect(s.mfa.challenges.get(id)?.state).toBe('expired');

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: '000000',
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_CHALLENGE_EXPIRED');
      }
      expect(s.mfa.challenges.get(id)?.attemptCount).toBe(5); // terminal never increments
    });

    it('answers MFA_CHALLENGE_EXPIRED when a miss races a challenge that went terminal (R1-05)', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1');

      // The challenge was pending when this request read it, but a concurrent
      // completion consumed it before the miss could be recorded — the
      // repository answers 'terminal' and nothing is counted.
      vi.spyOn(s.mfa, 'recordChallengeAttempt').mockResolvedValueOnce('terminal');

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: '000000',
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_CHALLENGE_EXPIRED');
      }
    });

    it('rejects a wrong recovery code', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1');

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: undefined,
          recoveryCode: 'AAAA-AAAA-AAAA-AAAA',
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'RECOVERY_CODE_INVALID');
      }
    });

    it('rejects a recovery code that belongs to another account', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1');
      s.mfa.seedFactor(makeMfaFactorRow({ id: 'factor-1', state: 'enabled' }));
      s.mfa.recoveryCodes.push(
        makeRecoveryCodeRow({
          id: 'other-code',
          factorId: 'factor-other',
          accountId: 'account-other',
          codeDigest: s.digester.digest('recovery', 'ABCD-2345-ABCD-2345'),
        }),
      );

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: undefined,
          recoveryCode: 'ABCD-2345-ABCD-2345',
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'RECOVERY_CODE_INVALID');
      }
    });

    it('succeeds with a TOTP code: challenge consumed, AAL2 session issued, device touched', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1');
      s.mfa.seedFactor(
        makeMfaFactorRow({
          id: 'factor-1',
          state: 'enabled',
          secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
        }),
      );

      const result = await s.service.completeMfaLogin({
        challengeToken: 'challenge-token',
        totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
        recoveryCode: undefined,
        deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ipHmac: 'ip-a',
        ip: '1.2.3.4',
      });

      expect(s.mfa.challenges.get('challenge-challenge-token')?.state).toBe('consumed');
      expect(result.session.authLevel).toBe('aal2');
      expect(result.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(s.sessions.rows.get(result.session.sessionId)?.authLevel).toBe('aal2');
      expect(s.audit.events.some((e) => e.eventType === 'mfa.login_success')).toBe(true);
      expect(result.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const device = s.devices.rows.get(result.session.deviceId as string);
      expect(device?.accountId).toBe('account-1');
      expect(device?.label).toBe('Chrome on Windows');
      // R1-06B: the device persists the keyed HMAC of the /24 prefix only.
      expect(device?.ipHmac).toBe(s.digester.digest('device-ip', '1.2.3.0/24'));
      expect(device?.uaDigest).toBe(
        s.digester.digest(
          'ua',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ),
      );
    });

    it('R1-06A: completes only when the presented device is the one the challenge bound to', async () => {
      const s = setup();
      await seedAccount(s);
      const deviceId = seedDevice(s, 'bound-cookie', 'device-bound');
      seedChallenge(s, 'challenge-token', 'account-1', { deviceId });
      s.mfa.seedFactor(
        makeMfaFactorRow({
          id: 'factor-1',
          state: 'enabled',
          secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
        }),
      );

      const result = await s.service.completeMfaLogin({
        challengeToken: 'challenge-token',
        totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
        recoveryCode: undefined,
        deviceToken: 'bound-cookie',
        userAgent: null,
        ipHmac: 'ip-a',
        ip: '1.2.3.4',
      });

      expect(result.session.authLevel).toBe('aal2');
      expect(result.session.deviceId).toBe(deviceId);
      expect(s.mfa.challenges.get('challenge-challenge-token')?.state).toBe('consumed');
    });

    it('R1-06A: a challenge cannot be completed from a different device', async () => {
      const s = setup();
      await seedAccount(s);
      seedDevice(s, 'bound-cookie', 'device-bound');
      seedChallenge(s, 'challenge-token', 'account-1', { deviceId: 'device-bound' });
      seedDevice(s, 'other-cookie', 'device-other');

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: '123456',
          recoveryCode: undefined,
          deviceToken: 'other-cookie',
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
      // A stolen challenge without the bound device cannot consume the
      // victim's code-attempt budget; endpoint rate limiting still applies.
      expect(s.mfa.challenges.get('challenge-challenge-token')?.attemptCount).toBe(0);
      expect(
        s.audit.events.some(
          (e) => e.eventType === 'mfa.challenge_failed' && e.reason === 'MFA_DEVICE_MISMATCH',
        ),
      ).toBe(true);
    });

    it('R1-06A: a bound challenge cannot be redeemed without any device cookie', async () => {
      const s = setup();
      await seedAccount(s);
      seedDevice(s, 'bound-cookie', 'device-bound');
      seedChallenge(s, 'challenge-token', 'account-1', { deviceId: 'device-bound' });

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: '123456',
          recoveryCode: undefined,
          deviceToken: null,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
      expect(s.mfa.challenges.get('challenge-challenge-token')?.attemptCount).toBe(0);
    });

    it('fails closed when a pending challenge has no device binding', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'legacy-challenge-token', 'account-1', { deviceId: null });
      s.mfa.seedFactor(
        makeMfaFactorRow({
          id: 'factor-1',
          state: 'enabled',
          secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
        }),
      );

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'legacy-challenge-token',
          totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('an unbound pending challenge must never authorize');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
      expect(s.mfa.challenges.get('challenge-legacy-challenge-token')?.state).toBe('pending');
      expect(s.mfa.challenges.get('challenge-legacy-challenge-token')?.attemptCount).toBe(0);
    });

    it('R1-06A: a TOTP-only challenge rejects recovery codes without consuming them', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1', { methodSet: ['totp'] });
      s.mfa.seedFactor(makeMfaFactorRow({ id: 'factor-1', state: 'enabled' }));
      const codeDigest = s.digester.digest('recovery', 'ABCD-2345-ABCD-2345');
      s.mfa.recoveryCodes.push(
        makeRecoveryCodeRow({ id: 'code-1', factorId: 'factor-1', codeDigest }),
      );

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: undefined,
          recoveryCode: 'ABCD-2345-ABCD-2345',
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'RECOVERY_CODE_INVALID');
      }
      // The code was never consumed — the METHOD was rejected, not the code.
      expect(s.mfa.recoveryCodes.find((row) => row.id === 'code-1')?.usedAt).toBeNull();
      expect(s.mfa.challenges.get('challenge-challenge-token')?.attemptCount).toBe(1);
    });

    it('R1-06A: a recovery-only challenge rejects TOTP codes', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1', { methodSet: ['recovery'] });
      s.mfa.seedFactor(
        makeMfaFactorRow({
          id: 'factor-1',
          state: 'enabled',
          secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
        }),
      );

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
    });

    it('succeeds with a recovery code and consumes it', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1');
      s.mfa.seedFactor(makeMfaFactorRow({ id: 'factor-1', state: 'enabled' }));
      const codeDigest = s.digester.digest('recovery', 'ABCD-2345-ABCD-2345');
      s.mfa.recoveryCodes.push(
        makeRecoveryCodeRow({ id: 'code-1', factorId: 'factor-1', codeDigest }),
      );

      const result = await s.service.completeMfaLogin({
        challengeToken: 'challenge-token',
        totpCode: undefined,
        recoveryCode: 'abcd-2345-abcd-2345',
        deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
        userAgent: null,
        ipHmac: 'ip-a',
        ip: '1.2.3.4',
      });

      expect(result.session.authLevel).toBe('aal2');
      expect(s.mfa.challenges.get('challenge-challenge-token')?.state).toBe('consumed');
      expect(s.mfa.recoveryCodes.find((row) => row.id === 'code-1')?.usedAt).not.toBeNull();
    });

    it('rejects a replay of the challenge cookie after a successful login', async () => {
      const s = setup();
      await seedAccount(s);
      seedChallenge(s, 'challenge-token', 'account-1');
      s.mfa.seedFactor(
        makeMfaFactorRow({
          id: 'factor-1',
          state: 'enabled',
          secretCiphertext: 'enc:BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
        }),
      );

      await s.service.completeMfaLogin({
        challengeToken: 'challenge-token',
        totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
        recoveryCode: undefined,
        deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
        userAgent: null,
        ipHmac: 'ip-a',
        ip: '1.2.3.4',
      });

      try {
        await s.service.completeMfaLogin({
          challengeToken: 'challenge-token',
          totpCode: totpCode('BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O', AT_MS),
          recoveryCode: undefined,
          deviceToken: DEFAULT_CHALLENGE_DEVICE_TOKEN,
          userAgent: null,
          ipHmac: 'ip-a',
          ip: '1.2.3.4',
        });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 401, 'MFA_INVALID');
      }
      expect(s.sessions.rows.size).toBe(1); // only the first completion issued a session
    });
  });
});
