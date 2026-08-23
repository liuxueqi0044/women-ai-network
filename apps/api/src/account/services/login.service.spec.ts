import { describe, expect, it } from 'vitest';
import { loadEnv, type AppConfig } from '@wai/config';
import { parsePepper, type AccountState, type Db } from '@wai/db';
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
  FakeSessionRepository,
  makeAccountRow,
  makeRecoveryCodeRow,
  RecordingAuthProvider,
} from './spec-helpers.js';
import {
  LOGIN_REASONS,
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MFA_CHALLENGE_TTL_MS,
  type IssuedMfaChallenge,
  LoginService,
} from './login.service.js';
import { SessionService, type IssuedSession } from './session.service.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 32 CSPRNG bytes to base64url (unpadded) is exactly 43 chars.
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = 'alice@example.com';
const PASSWORD = 'correct horse battery staple';

/**
 * CP3 unit spec for LoginService (task book §7). The core contract: every
 * anonymous failure answers the SAME 401 INVALID_CREDENTIALS while the audit
 * log distinguishes the reason; denied account states and unknown emails pay
 * the dummy verify; sessions carry opaque tokens of which only the keyed
 * digest is stored; MFA-enabled accounts get a challenge, not a session.
 */
function setup(): {
  config: AppConfig;
  accounts: FakeAccountRepository;
  passwords: FakePasswordCredentialRepository;
  sessions: FakeSessionRepository;
  devices: FakeDeviceRepository;
  mfa: FakeMfaRepository;
  audit: FakeAuditRepository;
  auth: RecordingAuthProvider;
  digester: NodeTokenDigester;
  rateLimiter: FakeRateLimiter;
  service: LoginService;
} {
  const config = loadEnv({ NODE_ENV: 'test', LOG_PRETTY: 'false' });
  const clock = new FixedClock(1_000_000);
  const auth = new RecordingAuthProvider(new MockAuthProvider());
  const digester = new NodeTokenDigester(parsePepper(config.iam.secretPepper));
  const accounts = new FakeAccountRepository();
  const passwords = new FakePasswordCredentialRepository();
  const sessions = new FakeSessionRepository();
  const devices = new FakeDeviceRepository();
  const mfa = new FakeMfaRepository();
  const audit = new FakeAuditRepository();
  const rateLimiter = new FakeRateLimiter(clock);
  const random = new DeterministicRandomSource();
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
    random,
    accountState,
  );
  const deviceService = new DeviceService(devices, sessions, audit, db, digester, random, clock);
  const service = new LoginService(
    config,
    accounts,
    passwords,
    mfa,
    audit,
    auth,
    digester,
    rateLimiter,
    clock,
    random,
    accountState,
    sessionService,
    deviceService,
  );
  return {
    config,
    accounts,
    passwords,
    sessions,
    devices,
    mfa,
    audit,
    auth,
    digester,
    rateLimiter,
    service,
  };
}

/** Seeds an enabled account with a valid password credential. Returns the account id. */
async function seedEnabledAccount(
  s: ReturnType<typeof setup>,
  overrides: { state?: AccountState; email?: string } = {},
): Promise<string> {
  const email = overrides.email ?? EMAIL;
  const emailDigest = s.digester.digest('email', email);
  // Deterministic per-email id so a spec can seed several accounts.
  const accountId = `22222222-2222-4222-8222-${emailDigest.slice(0, 12)}`;
  s.accounts.seed(
    makeAccountRow({ id: accountId, emailDigest, state: overrides.state ?? 'enabled' }),
  );
  const hash = await s.auth.hashPassword(PASSWORD);
  s.passwords.upsert(accountId, hash, new Date(1_000_000));
  return accountId;
}

async function exhaustEmailLimit(
  rateLimiter: FakeRateLimiter,
  digester: NodeTokenDigester,
  config: AppConfig,
  email: string,
): Promise<void> {
  const key = `login:email:${digester.digest('email', email)}`;
  const max = config.iam.rateLimit.loginEmailMax;
  for (let i = 0; i < max; i += 1) {
    await rateLimiter.consume(key, max, config.iam.rateLimit.emailWindowSeconds);
  }
}

describe('LoginService', () => {
  it('issues an AAL1 session: opaque 256-bit token, only its digest stored', async () => {
    const s = setup();
    const accountId = await seedEnabledAccount(s);

    const outcome = await s.service.login({
      email: EMAIL,
      password: PASSWORD,
      ipHmac: 'ip-hmac-1',
      ip: '1.2.3.4',
      deviceToken: null,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    });

    expect(outcome.kind).toBe('session');
    if (outcome.kind !== 'session') {
      return;
    }
    const session: IssuedSession = outcome.session;
    expect(session.token).toMatch(OPAQUE_TOKEN);
    expect(session.accountId).toBe(accountId);
    expect(session.authLevel).toBe('aal1');
    expect(session.state).toBe('active');
    expect(session.createdAtMs).toBe(1_000_000);
    expect(session.idleExpiresAtMs).toBe(1_000_000 + s.config.iam.sessionIdleSeconds * 1000);
    expect(session.absoluteExpiresAtMs).toBe(
      1_000_000 + s.config.iam.sessionAbsoluteSeconds * 1000,
    );

    expect(s.sessions.inserted).toHaveLength(1);
    const inserted = s.sessions.inserted[0];
    if (inserted === undefined) {
      throw new Error('expected one inserted session');
    }
    expect(inserted.id).toBe(session.sessionId);
    expect(inserted.generation).toBe(1);
    expect(inserted.parentId).toBeNull();
    expect(inserted.familyId).toMatch(UUID_V4);
    expect(inserted.authLevel).toBe('aal1');

    // A missing device cookie gets a fresh opaque token and a device record;
    // the session is bound to it, the UA is stored only as digest + summary.
    expect(outcome.deviceToken).toMatch(OPAQUE_TOKEN);
    expect(session.deviceId).toBe(inserted.deviceId);
    expect(inserted.deviceId).not.toBeNull();
    expect(s.devices.upserted).toHaveLength(1);
    const device = s.devices.upserted[0];
    if (device === undefined) {
      throw new Error('expected one upserted device');
    }
    expect(device.deviceDigest).toBe(s.digester.digest('device', outcome.deviceToken));
    expect(device.deviceDigest).not.toBe(outcome.deviceToken);
    expect(device.label).toBe('Chrome on Windows');
    expect(device.uaSummary).toBe('Chrome on Windows');
    expect(device.uaDigest).toBe(
      s.digester.digest(
        'ua',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      ),
    );
    // R1-06B: the device persists the keyed HMAC of the /24 prefix only.
    expect(device.ipHmac).toBe(s.digester.digest('device-ip', '1.2.3.0/24'));
    // The token is stored only as a keyed digest — never raw.
    expect(inserted.tokenDigest).toBe(s.digester.digest('session', session.token));
    expect(inserted.tokenDigest).not.toBe(session.token);
    expect(s.audit.events.some((event) => JSON.stringify(event).includes(session.token))).toBe(
      false,
    );

    const success = s.audit.events.filter((event) => event.eventType === 'login.success');
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({
      accountId,
      sessionId: session.sessionId,
      severity: 'info',
      reason: 'LOGIN_SUCCESS',
      ipHmac: 'ip-hmac-1',
    });
  });

  it('answers unknown emails with 401 INVALID_CREDENTIALS after a dummy verify', async () => {
    const s = setup();

    const caught = await s.service
      .login({
        email: 'nobody@example.com',
        password: PASSWORD,
        ipHmac: 'ip-hmac-1',
        ip: '1.2.3.4',
        deviceToken: null,
        userAgent: null,
      })
      .catch((error: unknown) => error);

    expectHttpException(caught, 401, 'INVALID_CREDENTIALS');
    expect(s.auth.calls).toContain('dummyVerify');
    expect(s.sessions.inserted).toHaveLength(0);
    expect(s.audit.events).toHaveLength(1);
    expect(s.audit.events[0]).toMatchObject({
      eventType: 'login.invalid_credentials',
      severity: 'warning',
      reason: LOGIN_REASONS.unknownEmail,
      ipHmac: 'ip-hmac-1',
    });
    // The event never names a non-existent account.
    expect(s.audit.events[0]?.accountId).toBeUndefined();
  });

  it('answers a wrong password with the same 401 and the BAD_PASSWORD reason', async () => {
    const s = setup();
    await seedEnabledAccount(s);

    const caught = await s.service
      .login({
        email: EMAIL,
        password: 'wrong-password',
        ipHmac: 'ip-hmac-1',
        ip: '1.2.3.4',
        deviceToken: null,
        userAgent: null,
      })
      .catch((error: unknown) => error);

    expectHttpException(caught, 401, 'INVALID_CREDENTIALS');
    // A real credential check ran — no dummy verify on this path.
    expect(s.auth.calls).toContain('verifyPassword');
    expect(s.auth.calls).not.toContain('dummyVerify');
    expect(s.sessions.inserted).toHaveLength(0);
    expect(s.audit.events[0]).toMatchObject({
      eventType: 'login.invalid_credentials',
      severity: 'warning',
      reason: LOGIN_REASONS.badPassword,
    });
  });

  it.each(['suspended', 'deletion_pending', 'deleted'] as const)(
    'rejects the %s state with 401 + ACCOUNT_STATE_DENIED_%s after a dummy verify',
    async (state) => {
      const s = setup();
      await seedEnabledAccount(s, { state });

      const caught = await s.service
        .login({
          email: EMAIL,
          password: PASSWORD,
          ipHmac: 'ip-hmac-1',
          ip: '1.2.3.4',
          deviceToken: null,
          userAgent: null,
        })
        .catch((error: unknown) => error);

      expectHttpException(caught, 401, 'INVALID_CREDENTIALS');
      expect(s.auth.calls).toContain('dummyVerify');
      expect(s.sessions.inserted).toHaveLength(0);
      expect(s.audit.events[0]).toMatchObject({
        eventType: 'login.invalid_credentials',
        severity: 'warning',
        reason: `ACCOUNT_STATE_DENIED_${state.toUpperCase()}`,
      });
    },
  );

  it('flags an account without credentials as critical but still answers 401', async () => {
    const s = setup();
    const emailDigest = s.digester.digest('email', EMAIL);
    s.accounts.seed(makeAccountRow({ id: 'account-no-cred', emailDigest }));

    const caught = await s.service
      .login({
        email: EMAIL,
        password: PASSWORD,
        ipHmac: 'ip-hmac-1',
        ip: '1.2.3.4',
        deviceToken: null,
        userAgent: null,
      })
      .catch((error: unknown) => error);

    expectHttpException(caught, 401, 'INVALID_CREDENTIALS');
    expect(s.auth.calls).toContain('dummyVerify');
    expect(s.audit.events[0]).toMatchObject({
      eventType: 'login.invalid_credentials',
      severity: 'critical',
      reason: LOGIN_REASONS.missingCredential,
    });
  });

  it('issues an MFA challenge instead of a session when a factor is enabled', async () => {
    const s = setup();
    const accountId = await seedEnabledAccount(s);
    const now = new Date(1_000_000);
    s.mfa.seedFactor({
      id: 'factor-1',
      accountId,
      type: 'totp',
      state: 'enabled',
      secretCiphertext: 'ct',
      secretNonce: 'nonce',
      secretKeyId: 'dev-key',
      createdAt: now,
      verifiedAt: now,
      enabledAt: now,
      disabledAt: null,
    });
    // R1-06A: unused codes exist → recovery joins the challenge's method set.
    s.mfa.recoveryCodes.push(
      makeRecoveryCodeRow({
        id: 'code-1',
        factorId: 'factor-1',
        accountId,
        codeDigest: s.digester.digest('recovery', 'ABCD-2345-ABCD-2345'),
      }),
    );

    const outcome = await s.service.login({
      email: EMAIL,
      password: PASSWORD,
      ipHmac: 'ip-hmac-1',
      ip: '1.2.3.4',
      deviceToken: null,
      userAgent: null,
    });

    expect(outcome.kind).toBe('mfa_challenge');
    if (outcome.kind !== 'mfa_challenge') {
      return;
    }
    const challenge: IssuedMfaChallenge = outcome.challenge;
    expect(challenge.challengeToken).toMatch(OPAQUE_TOKEN);
    expect(challenge.expiresAtMs).toBe(1_000_000 + MFA_CHALLENGE_TTL_MS);
    expect(challenge.maxAttempts).toBe(MFA_CHALLENGE_MAX_ATTEMPTS);
    // No session is issued while the challenge is pending; the device IS
    // touched so the challenge binds to the exact row from this step.
    expect(s.sessions.inserted).toHaveLength(0);
    expect(s.devices.upserted).toHaveLength(1);
    expect(s.mfa.challengeInserts).toHaveLength(1);
    const inserted = s.mfa.challengeInserts[0];
    if (inserted === undefined) {
      throw new Error('expected one inserted challenge');
    }
    expect(inserted.digest).toBe(s.digester.digest('challenge', challenge.challengeToken));
    expect(inserted.digest).not.toBe(challenge.challengeToken);
    expect(inserted.accountId).toBe(accountId);
    // R1-06A: the challenge is bound to the device created at this step and
    // carries the method set — TOTP always, recovery only while codes exist.
    expect(inserted.deviceId).toBe(s.devices.upserted[0]?.id);
    expect(inserted.methodSet).toEqual(['totp', 'recovery']);
    expect(s.devices.upserted[0]?.deviceDigest).toBe(
      s.digester.digest('device', outcome.deviceToken),
    );
    const issued = s.audit.events.filter((event) => event.eventType === 'mfa.challenge_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      accountId,
      severity: 'info',
      reason: 'MFA_CHALLENGE_ISSUED',
    });
  });

  it('rejects an exhausted email dimension with 429 RATE_LIMITED before any work', async () => {
    const s = setup();
    await seedEnabledAccount(s);
    await exhaustEmailLimit(s.rateLimiter, s.digester, s.config, EMAIL);

    const caught = await s.service
      .login({
        email: EMAIL,
        password: PASSWORD,
        ipHmac: 'ip-hmac-1',
        ip: '1.2.3.4',
        deviceToken: null,
        userAgent: null,
      })
      .catch((error: unknown) => error);

    expectHttpException(caught, 429, 'RATE_LIMITED');
    expect(s.sessions.inserted).toHaveLength(0);
    expect(s.audit.events).toHaveLength(0);
  });

  it('rate-limits per email digest — a different email is unaffected', async () => {
    const s = setup();
    await seedEnabledAccount(s);
    await seedEnabledAccount(s, { email: 'bob@example.com' });
    await exhaustEmailLimit(s.rateLimiter, s.digester, s.config, EMAIL);

    const outcome = await s.service.login({
      email: 'bob@example.com',
      password: PASSWORD,
      ipHmac: 'ip-hmac-1',
      ip: '1.2.3.4',
      deviceToken: null,
      userAgent: null,
    });

    expect(outcome.kind).toBe('session');
  });
});
