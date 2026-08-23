import { describe, expect, it } from 'vitest';
import { loadEnv, type AppConfig } from '@wai/config';
import { parsePepper, parsePiiKeys } from '@wai/db';
import {
  DeterministicRandomSource,
  FakeRateLimiter,
  FixedClock,
  MockAuthProvider,
} from '@wai/testkit';
import { NodeSecretCipher } from '../infra/node-secret-cipher.js';
import { NodeTokenDigester } from '../infra/node-token-digester.js';
import {
  expectHttpException,
  FakeAccountRepository,
  FakeAuditRepository,
  makeAccountRow,
  RecordingAuthProvider,
} from './spec-helpers.js';
import { RegistrationService } from './registration.service.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = 'alice@example.com';
const PASSWORD = 'correct horse battery staple';

/**
 * CP3 unit spec for RegistrationService (task book §7). Proves the contract
 * invariants with the deterministic testkit fakes: uniform duplicate response
 * (fresh UUID, never the real id), PII discipline (digest lookup + ciphertext
 * storage only), hash-before-lookup timing, 23505 concurrency mapping, and the
 * email-dimension rate limit.
 */
function setup(): {
  config: AppConfig;
  accounts: FakeAccountRepository;
  audit: FakeAuditRepository;
  auth: RecordingAuthProvider;
  digester: NodeTokenDigester;
  cipher: NodeSecretCipher;
  rateLimiter: FakeRateLimiter;
  service: RegistrationService;
} {
  const config = loadEnv({ NODE_ENV: 'test', LOG_PRETTY: 'false' });
  const clock = new FixedClock(1_000_000);
  const auth = new RecordingAuthProvider(new MockAuthProvider());
  const digester = new NodeTokenDigester(parsePepper(config.iam.secretPepper));
  const cipher = new NodeSecretCipher(parsePiiKeys(config.iam.piiKeysJson));
  const accounts = new FakeAccountRepository();
  const audit = new FakeAuditRepository();
  const rateLimiter = new FakeRateLimiter(clock);
  const service = new RegistrationService(
    config,
    accounts,
    audit,
    auth,
    cipher,
    digester,
    rateLimiter,
    clock,
    new DeterministicRandomSource(),
  );
  return { config, accounts, audit, auth, digester, cipher, rateLimiter, service };
}

async function exhaustEmailLimit(
  rateLimiter: FakeRateLimiter,
  digester: NodeTokenDigester,
  config: AppConfig,
  email: string,
): Promise<void> {
  const key = `register:email:${digester.digest('email', email)}`;
  const max = config.iam.rateLimit.registrationEmailMax;
  for (let i = 0; i < max; i += 1) {
    await rateLimiter.consume(key, max, config.iam.rateLimit.emailWindowSeconds);
  }
}

describe('RegistrationService', () => {
  it('registers a fresh account: real id, digest-only lookup, ciphertext-only email', async () => {
    const { service, accounts, audit, digester, cipher, config } = setup();

    const result = await service.register({
      email: EMAIL,
      password: PASSWORD,
      ipHmac: 'ip-hmac-1',
      requestId: 'req-1',
    });

    expect(result).toEqual({ account_id: expect.stringMatching(UUID_V4), state: 'enabled' });

    const rows = [...accounts.accounts.values()];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('expected one stored account row');
    }
    expect(row.id).toBe(result.account_id);
    // PII discipline: email only ever exists as a keyed digest + ciphertext.
    expect(row.emailDigest).toBe(digester.digest('email', EMAIL));
    expect(row.emailDigest).not.toContain(EMAIL);
    expect(JSON.stringify(row)).not.toContain(EMAIL);
    expect(row.emailKeyId).toBe(config.iam.piiKeyId);
    const decrypted = cipher.decrypt({
      keyId: row.emailKeyId,
      nonce: row.emailNonce,
      ciphertext: row.emailCiphertext,
    });
    expect(decrypted).toBe(EMAIL);
    expect(decrypted).not.toBe(row.emailDigest);

    // Password lands as a provider hash, never raw.
    const inserted = accounts.insertedWithPassword[0];
    expect(inserted?.hash).toMatch(/^mock-hash:v1:/);
    expect(inserted?.hash).not.toContain(PASSWORD);

    // R1-06C: the append-only transition audit starts at birth, stamped with
    // the registration request id.
    expect(accounts.transitions).toHaveLength(1);
    expect(accounts.transitions[0]).toMatchObject({
      accountId: result.account_id,
      fromState: 'registered',
      toState: 'enabled',
      reason: 'registered',
      actorType: 'system',
      actorId: null,
      requestId: 'req-1',
      version: 0,
    });

    const created = audit.events.filter((event) => event.eventType === 'registration.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      accountId: result.account_id,
      severity: 'info',
      reason: 'REGISTRATION_CREATED',
      ipHmac: 'ip-hmac-1',
    });
    expect(audit.events.some((event) => event.eventType === 'registration.duplicate')).toBe(false);
  });

  it('returns a FRESH random id for a duplicate email — never the real one', async () => {
    const { service, accounts, audit, digester } = setup();
    const existingId = '11111111-1111-4111-8111-111111111111';
    accounts.seed(makeAccountRow({ id: existingId, emailDigest: digester.digest('email', EMAIL) }));

    const result = await service.register({
      email: EMAIL,
      password: PASSWORD,
      ipHmac: 'ip-hmac-1',
      requestId: 'req-1',
    });

    expect(result.account_id).toMatch(UUID_V4);
    expect(result.account_id).not.toBe(existingId);
    expect(accounts.accounts.size).toBe(1);
    expect(accounts.insertedWithPassword).toHaveLength(0);

    const duplicate = audit.events.filter((event) => event.eventType === 'registration.duplicate');
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toMatchObject({
      severity: 'warning',
      reason: 'REGISTRATION_DUPLICATE_EMAIL',
      ipHmac: 'ip-hmac-1',
    });
    expect(duplicate[0]?.accountId).toBeUndefined();
    expect(audit.events.some((event) => event.eventType === 'registration.created')).toBe(false);
  });

  it('hashes the password BEFORE the existence check (uniform timing)', async () => {
    const { service, accounts, audit, auth, digester } = setup();
    accounts.seed(makeAccountRow({ id: 'existing', emailDigest: digester.digest('email', EMAIL) }));
    const lookups: string[] = [];
    const originalLookup = accounts.findByEmailDigest.bind(accounts);
    accounts.findByEmailDigest = async (digest: string) => {
      lookups.push(digest);
      return originalLookup(digest);
    };

    await service.register({
      email: EMAIL,
      password: PASSWORD,
      ipHmac: 'ip-hmac-1',
      requestId: 'req-1',
    });

    // Even for a duplicate the password is hashed first, so fresh and
    // duplicate registrations pay the same cost.
    expect(auth.calls[0]).toBe('hashPassword');
    expect(lookups).toEqual([digester.digest('email', EMAIL)]);
    expect(audit.events.some((event) => event.eventType === 'registration.duplicate')).toBe(true);
  });

  it('maps a concurrent unique violation (23505) to the same uniform response', async () => {
    const { service, accounts, audit } = setup();
    accounts.uniqueViolationOnNextInsert = true;

    const result = await service.register({
      email: EMAIL,
      password: PASSWORD,
      ipHmac: 'ip-hmac-1',
      requestId: 'req-1',
    });

    expect(result.account_id).toMatch(UUID_V4);
    expect(accounts.accounts.size).toBe(0);
    // The insert was attempted and failed — nothing was recorded.
    expect(accounts.insertedWithPassword).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it('rejects an exhausted email dimension with 429 RATE_LIMITED before any work', async () => {
    const { service, accounts, audit, rateLimiter, digester, config } = setup();
    await exhaustEmailLimit(rateLimiter, digester, config, EMAIL);

    const caught = await service
      .register({
        email: EMAIL,
        password: PASSWORD,
        ipHmac: 'ip-hmac-1',
        requestId: 'req-1',
      })
      .catch((error: unknown) => error);

    expectHttpException(caught, 429, 'RATE_LIMITED');
    expect(accounts.accounts.size).toBe(0);
    expect(audit.events).toHaveLength(0);
  });

  it('rate-limits per email digest — a different email is unaffected', async () => {
    const { service, accounts, rateLimiter, digester, config } = setup();
    await exhaustEmailLimit(rateLimiter, digester, config, EMAIL);

    const result = await service.register({
      email: 'bob@example.com',
      password: PASSWORD,
      ipHmac: 'ip-hmac-1',
      requestId: 'req-1',
    });

    expect(result.account_id).toMatch(UUID_V4);
    expect(accounts.accounts.size).toBe(1);
  });
});
