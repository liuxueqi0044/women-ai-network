import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { loadEnv, type AppConfig } from '@wai/config';
import { createDb, createPool, hmacDigest, MigrationRunner, schema, type Db } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { closeApiApp, createApiApp } from '../../../apps/api/src/app.js';
import { awaitRedisReady, capturingLogger, valkeyUrl } from '../helpers.js';

// Injected by vitest.config.ts (`define`); resolves to packages/db/migrations.
declare const WAI_MIGRATIONS_DIR: string;
const MIGRATIONS_DIR = WAI_MIGRATIONS_DIR;

/**
 * CP3 evidence over real Postgres + Valkey containers: the full registration /
 * login vertical (task book §7) — uniform duplicate responses, indistinguishable
 * 401 INVALID_CREDENTIALS for every failure with distinct audit reasons,
 * account-state denial, MFA-gated login, IP + email-digest rate limiting,
 * JSON-only + Origin guards, and PII discipline (digest-only storage, opaque
 * cookie token, nothing sensitive in logs).
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = 'alice@example.invalid';
const PASSWORD = 'correct horse battery staple';

let started: StartedInfra;
let rawEnv: NodeJS.ProcessEnv;
let config: AppConfig;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  started = await startTestInfra();
  rawEnv = {
    NODE_ENV: 'test',
    LOG_PRETTY: 'false',
    LOG_LEVEL: 'warn',
    DATABASE_URL: started.infra.databaseUrl,
    VALKEY_URL: valkeyUrl(started.infra),
  };
  config = loadEnv(rawEnv);
  pool = createPool(started.infra.databaseUrl);
  db = createDb(pool);
  // Fresh containers start empty — the API never migrates itself.
  const runner = new MigrationRunner(pool, MIGRATIONS_DIR);
  await runner.up();
}, 180_000);

afterAll(async () => {
  await pool.end();
  await started.stop();
});

type ApiApp = Awaited<ReturnType<typeof createApiApp>>;

function httpPort(api: ApiApp): number {
  const server = api.getHttpServer() as Server;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('API did not bind to a TCP port');
  }
  return address.port;
}

async function startApi(env: NodeJS.ProcessEnv = {}): Promise<{ baseUrl: string; api: ApiApp }> {
  const api = await createApiApp(loadEnv({ ...rawEnv, ...env }));
  await api.listen(0, '127.0.0.1');
  return { baseUrl: `http://127.0.0.1:${httpPort(api)}`, api };
}

/** Client-side cookie jar for the raw session token and attribute checks. */
function parseSetCookies(response: Response): Array<{ name: string; value: string; raw: string }> {
  return response.headers.getSetCookie().map((raw) => {
    const [pair] = raw.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    return {
      name: eq > 0 ? (pair?.slice(0, eq) ?? '') : '',
      value: eq > 0 ? (pair?.slice(eq + 1) ?? '') : '',
      raw,
    };
  });
}

function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function register(baseUrl: string, email: string, password = PASSWORD): Promise<Response> {
  return postJson(baseUrl, '/v1/account/registrations', { email, password });
}

async function login(baseUrl: string, email: string, password = PASSWORD): Promise<Response> {
  return postJson(baseUrl, '/v1/account/sessions', { email, password });
}

describe('registration and login over real infrastructure', () => {
  it('registers and logs in: opaque cookie token, digests only, real Argon2, audit trail', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const registration = await register(baseUrl, EMAIL);
      expect(registration.status).toBe(201);
      const registrationBody = (await registration.json()) as {
        account_id: string;
        state: string;
      };
      expect(registrationBody.account_id).toMatch(UUID_V4);
      expect(registrationBody.state).toBe('enabled');
      // No token/cookie material in the response body.
      expect(JSON.stringify(registrationBody)).not.toContain(PASSWORD);

      const session = await login(baseUrl, EMAIL);
      expect(session.status).toBe(201);
      const sessionBody = (await session.json()) as {
        session_id: string;
        account_id: string;
        auth_level: string;
        state: string;
        created_at: string;
        last_seen_at: string;
        idle_expires_at: string;
        absolute_expires_at: string;
      };
      expect(sessionBody.session_id).toMatch(UUID_V4);
      expect(sessionBody.account_id).toBe(registrationBody.account_id);
      expect(sessionBody.auth_level).toBe('aal1');
      expect(sessionBody.state).toBe('active');
      expect(sessionBody.idle_expires_at).toBeDefined();
      expect(sessionBody.absolute_expires_at).toBeDefined();

      // The token travels ONLY in the HttpOnly cookie — never in the body.
      const cookies = parseSetCookies(session);
      const sessionCookie = cookies.find((cookie) => cookie.name === 'wai_session_dev');
      expect(sessionCookie).toBeDefined();
      const token = sessionCookie?.value ?? '';
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(sessionBody)).not.toContain(token);
      expect(sessionCookie?.raw).toContain('HttpOnly');
      expect(sessionCookie?.raw).toMatch(/SameSite=Lax/i);
      expect(sessionCookie?.raw).toContain('Path=/');
      expect(sessionCookie?.raw).not.toContain('Secure'); // dev/test: http://127.0.0.1

      // Database: only digests + ciphertext; the raw token never lands there.
      const digest = hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'session', token);
      const sessionRows = await pool.query<{ token_digest: string }>(
        'SELECT token_digest FROM iam.sessions WHERE account_id = $1',
        [registrationBody.account_id],
      );
      expect(sessionRows.rows).toHaveLength(1);
      expect(sessionRows.rows[0]?.token_digest).toBe(digest);
      expect(JSON.stringify(sessionRows.rows)).not.toContain(token);

      // Email: keyed digest for lookup, AES-256-GCM ciphertext for storage.
      const emailDigest = hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'email', EMAIL);
      const accountRows = await pool.query<{
        email_digest: string;
        email_ciphertext: string;
        email_key_id: string;
      }>('SELECT email_digest, email_ciphertext, email_key_id FROM iam.accounts WHERE id = $1', [
        registrationBody.account_id,
      ]);
      const account = accountRows.rows[0];
      expect(account?.email_digest).toBe(emailDigest);
      expect(account?.email_key_id).toBe(config.iam.piiKeyId);
      expect(account?.email_ciphertext).not.toContain(EMAIL);

      // Password: the REAL Argon2id provider produced the OWASP PHC format.
      const credentialRows = await pool.query<{ hash: string }>(
        'SELECT hash FROM iam.password_credentials WHERE account_id = $1',
        [registrationBody.account_id],
      );
      expect(credentialRows.rows[0]?.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

      // Audit trail: created + successful login, no PII in event rows.
      const events = await pool.query<{ event_type: string; reason: string }>(
        'SELECT event_type, reason FROM iam.security_events WHERE account_id = $1 ORDER BY created_at',
        [registrationBody.account_id],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        'registration.created',
        'login.success',
      ]);
      expect(JSON.stringify(events.rows)).not.toContain(EMAIL);
      expect(JSON.stringify(events.rows)).not.toContain(PASSWORD);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('R1-06C: the registration request id lands on the account’s initial state transition', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'transition@example.invalid';
      const requestId = '6f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c';
      const registration = await postJson(
        baseUrl,
        '/v1/account/registrations',
        { email, password: PASSWORD },
        { 'x-request-id': requestId },
      );
      expect(registration.status).toBe(201);
      // The accepted id is echoed on the response.
      expect(registration.headers.get('x-request-id')).toBe(requestId);
      const { account_id: accountId } = (await registration.json()) as { account_id: string };

      // The append-only transition audit starts at birth, stamped with the
      // exact request that created the account.
      const transitions = await pool.query<{
        from_state: string;
        to_state: string;
        reason: string;
        actor_type: string;
        version: number;
        request_id: string | null;
      }>(
        `SELECT from_state, to_state, reason, actor_type, version, request_id
           FROM iam.account_state_transitions WHERE account_id = $1`,
        [accountId],
      );
      expect(transitions.rows).toHaveLength(1);
      expect(transitions.rows[0]).toMatchObject({
        from_state: 'registered',
        to_state: 'enabled',
        reason: 'registered',
        actor_type: 'system',
        version: 0,
        request_id: requestId,
      });
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('answers a duplicate registration with a FRESH id that is never the real one', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const first = await register(baseUrl, EMAIL);
      const firstBody = (await first.json()) as { account_id: string };
      const second = await register(baseUrl, EMAIL);
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as { account_id: string; state: string };
      expect(secondBody.state).toBe('enabled');
      expect(secondBody.account_id).toMatch(UUID_V4);
      expect(secondBody.account_id).not.toBe(firstBody.account_id);

      const rows = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM iam.accounts WHERE email_digest = $1',
        [hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'email', EMAIL)],
      );
      expect(Number(rows.rows[0]?.n)).toBe(1);
      const duplicateEvents = await pool.query<{ reason: string }>(
        'SELECT reason FROM iam.security_events WHERE event_type = $1',
        ['registration.duplicate'],
      );
      expect(
        duplicateEvents.rows.some((row) => row.reason === 'REGISTRATION_DUPLICATE_EMAIL'),
      ).toBe(true);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('answers wrong password and unknown email with IDENTICAL 401 envelopes, distinct audit reasons', async () => {
    const { baseUrl, api } = await startApi();
    try {
      await register(baseUrl, EMAIL);

      const wrongPassword = await login(baseUrl, EMAIL, 'wrong-password-123');
      const unknownEmail = await login(baseUrl, 'nobody@example.invalid');

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      const wrongBody = (await wrongPassword.json()) as {
        code: string;
        message: string;
        request_id: string;
      };
      const unknownBody = (await unknownEmail.json()) as {
        code: string;
        message: string;
        request_id: string;
      };
      // Indistinguishable public responses — no account enumeration. (Each
      // request carries its own correlation id, so request_id is not compared.)
      expect(wrongBody.code).toBe(unknownBody.code);
      expect(wrongBody.message).toBe(unknownBody.message);
      expect(wrongBody.request_id).toMatch(UUID_V4);
      expect(wrongBody.code).toBe('INVALID_CREDENTIALS');
      expect(wrongBody.message).toBe('Invalid email or password');
      expect(unknownEmail.headers.get('set-cookie')).toBeNull();

      const reasons = await pool.query<{ reason: string }>(
        "SELECT reason FROM iam.security_events WHERE event_type = 'login.invalid_credentials'",
      );
      const reasonSet = new Set(reasons.rows.map((row) => row.reason));
      expect(reasonSet).toContain('INVALID_CREDENTIALS_BAD_PASSWORD');
      expect(reasonSet).toContain('INVALID_CREDENTIALS_UNKNOWN_EMAIL');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('rejects a suspended account with the same 401 and records the denied-state event', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'suspended@example.invalid';
      const registration = await register(baseUrl, email);
      const { account_id: accountId } = (await registration.json()) as { account_id: string };

      // Admin-ish state change straight in the DB — no admin API exists yet.
      // state_reason must satisfy accounts_state_reason_chk for the new state.
      await pool.query(
        `UPDATE iam.accounts SET state = 'suspended', state_reason = 'admin_suspend',
           state_actor_type = 'system', state_changed_at = now() WHERE id = $1`,
        [accountId],
      );

      const session = await login(baseUrl, email);
      expect(session.status).toBe(401);
      const body = (await session.json()) as { code: string; message: string };
      expect(body).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
      expect(session.headers.get('set-cookie')).toBeNull();

      const events = await pool.query<{ reason: string }>(
        'SELECT reason FROM iam.security_events WHERE account_id = $1 AND event_type = $2',
        [accountId, 'login.invalid_credentials'],
      );
      expect(events.rows.map((row) => row.reason)).toContain('ACCOUNT_STATE_DENIED_SUSPENDED');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('requires MFA when a factor is enabled: 401 MFA_REQUIRED + challenge cookie, no session cookie', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'mfa-user@example.invalid';
      const registration = await register(baseUrl, email);
      const { account_id: accountId } = (await registration.json()) as { account_id: string };

      // Enable a TOTP factor directly — the enrollment API lands in CP5.
      const now = new Date();
      await db.insert(schema.mfaFactors).values({
        id: '9f2a1b0c-6b2a-4e12-9a1c-2d3e4f5a6b7c',
        accountId,
        type: 'totp',
        state: 'enabled',
        secretCiphertext: 'ciphertext-secret-nonce-tag',
        secretNonce: 'nonce-placeholder',
        secretKeyId: config.iam.piiKeyId,
        createdAt: now,
        verifiedAt: now,
        enabledAt: now,
      });

      const session = await login(baseUrl, email);
      expect(session.status).toBe(401);
      const body = (await session.json()) as { code: string };
      expect(body.code).toBe('MFA_REQUIRED');

      // The challenge token is a 5-minute HttpOnly cookie scoped to the
      // MFA completion routes — and no session cookie was set.
      const cookies = parseSetCookies(session);
      const challenge = cookies.find((cookie) => cookie.name === 'wai_mfa_challenge');
      expect(challenge).toBeDefined();
      expect(challenge?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge?.raw).toContain('HttpOnly');
      expect(challenge?.raw).toContain('Path=/v1/account/sessions');
      expect(challenge?.raw).toContain('Max-Age=300');
      expect(cookies.some((cookie) => cookie.name === 'wai_session_dev')).toBe(false);

      const challengeRows = await pool.query<{ digest: string }>(
        'SELECT digest FROM iam.mfa_challenges WHERE account_id = $1',
        [accountId],
      );
      expect(challengeRows.rows).toHaveLength(1);
      expect(challengeRows.rows[0]?.digest).toBe(
        hmacDigest(
          Buffer.from(config.iam.secretPepper, 'utf8'),
          'challenge',
          challenge?.value ?? '',
        ),
      );
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('rate-limits the email dimension with 429 RATE_LIMITED and retry-after', async () => {
    const { baseUrl, api } = await startApi({
      IAM_RATE_LIMIT_LOGIN_EMAIL_MAX: '2',
      IAM_RATE_LIMIT_EMAIL_WINDOW_SECONDS: '900',
    });
    try {
      // A dedicated email for this test keeps the shared Valkey counters clean.
      for (let i = 0; i < 2; i += 1) {
        const allowed = await login(baseUrl, 'ratelimit-email@example.invalid');
        expect(allowed.status).not.toBe(429);
      }
      const denied = await login(baseUrl, 'ratelimit-email@example.invalid');
      expect(denied.status).toBe(429);
      const body = (await denied.json()) as { code: string; message: string; request_id: string };
      expect(body.code).toBe('RATE_LIMITED');
      expect(body.request_id).toMatch(UUID_V4);
      expect(denied.headers.get('retry-after')).toBeDefined();
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('rate-limits the IP dimension per route with 429 + retry-after headers', async () => {
    // The IP counters live in the shared Valkey under wai:iam:rl:http:* —
    // flush them so this instance starts from a clean slate regardless of the
    // requests the other tests already made from the same loopback IP.
    const redis = new Redis({
      host: started.infra.valkey.host,
      port: started.infra.valkey.port,
      password: started.infra.valkey.password,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    await awaitRedisReady(redis);
    const keys = await redis.keys('wai:iam:rl:http:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    redis.disconnect();

    const { baseUrl, api } = await startApi({
      IAM_RATE_LIMIT_IP_SESSIONS_MAX: '3',
      IAM_RATE_LIMIT_IP_WINDOW_SECONDS: '300',
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        const allowed = await login(baseUrl, 'ip-limiter@example.invalid');
        expect(allowed.status).not.toBe(429);
      }
      const denied = await login(baseUrl, 'ip-limiter@example.invalid', 'wrong-password-123');
      expect(denied.status).toBe(429);
      const body = (await denied.json()) as { code: string; message: string };
      expect(body.code).toBe('RATE_LIMITED');
      expect(body.message).toBe('Too many requests; try again later');
      expect(denied.headers.get('retry-after')).toBeDefined();
      expect(denied.headers.get('ratelimit-remaining')).toBe('0');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('rejects non-JSON payloads (415), disallowed origins (403) and invalid payloads (400)', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const notJson = await fetch(`${baseUrl}/v1/account/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=a%40b.com&password=x',
      });
      expect(notJson.status).toBe(415);
      expect(((await notJson.json()) as { code: string }).code).toBe('UNSUPPORTED_MEDIA_TYPE');

      const badOrigin = await postJson(
        baseUrl,
        '/v1/account/sessions',
        {
          email: EMAIL,
          password: PASSWORD,
        },
        { origin: 'https://evil.example' },
      );
      expect(badOrigin.status).toBe(403);
      expect(((await badOrigin.json()) as { code: string }).code).toBe('FORBIDDEN');

      const goodOrigin = await postJson(
        baseUrl,
        '/v1/account/sessions',
        {
          email: 'origin-allowed@example.invalid',
          password: 'wrong-password-123',
        },
        { origin: 'http://localhost:3000' },
      );
      // The guard passed; the login itself failed with the uniform 401.
      expect(goodOrigin.status).toBe(401);
      expect(((await goodOrigin.json()) as { code: string }).code).toBe('INVALID_CREDENTIALS');

      const shortPassword = await register(baseUrl, 'validation@example.invalid', 'short');
      expect(shortPassword.status).toBe(400);
      const validation = (await shortPassword.json()) as { code: string; details?: unknown };
      expect(validation.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(validation.details)).toBe(true);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('never puts email, password or the session token in any log line', async () => {
    const captured = capturingLogger('wai-api');
    const api = await createApiApp(config, { logger: captured.logger });
    await api.listen(0, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${httpPort(api)}`;
    try {
      const email = 'log-pii@example.invalid';
      await register(baseUrl, email);
      const session = await login(baseUrl, email);
      const token =
        parseSetCookies(session).find((cookie) => cookie.name === 'wai_session_dev')?.value ?? '';

      const dump = captured.stream.lines.map((line) => JSON.stringify(line)).join('\n');
      expect(dump).not.toContain(email);
      expect(dump).not.toContain(PASSWORD);
      expect(dump).not.toContain(token);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);
});
