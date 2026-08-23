import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { loadEnv, type AppConfig } from '@wai/config';
import { createPool, hmacDigest, MigrationRunner } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { closeApiApp, createApiApp } from '../../../apps/api/src/app.js';
import { valkeyUrl } from '../helpers.js';

// Injected by vitest.config.ts (`define`); resolves to packages/db/migrations.
declare const WAI_MIGRATIONS_DIR: string;
const MIGRATIONS_DIR = WAI_MIGRATIONS_DIR;

/**
 * CP5 evidence over real Postgres + Valkey containers (task book §8): the TOTP
 * MFA vertical — enrollment with a once-returned otpauth URI, first-code
 * confirm that enables the factor, mints 10 single-use recovery codes (digest
 * storage only) and rotates the session to AAL2; password login then demands a
 * single-use 5-minute challenge; wrong codes burn the 5-attempt budget;
 * recovery codes are consumed exactly once even under concurrency; regenerate
 * kills the old unused codes; disable re-verifies password + code and rotates
 * back to AAL1. TOTP codes are generated with an INDEPENDENT RFC 6238
 * implementation (node:crypto) so the API's own provider is never used to
 * validate itself.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE = 'wai_session_dev';
const CHALLENGE_COOKIE = 'wai_mfa_challenge';
const DEVICE_COOKIE = 'wai_device';
const RECOVERY_CODE_FORMAT =
  /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const PASSWORD = 'correct horse battery staple';

let started: StartedInfra;
let rawEnv: NodeJS.ProcessEnv;
let config: AppConfig;
let pool: Pool;

beforeAll(async () => {
  started = await startTestInfra();
  rawEnv = {
    NODE_ENV: 'test',
    LOG_PRETTY: 'false',
    LOG_LEVEL: 'warn',
    DATABASE_URL: started.infra.databaseUrl,
    VALKEY_URL: valkeyUrl(started.infra),
    // The file's apps share one loopback IP and the shared Valkey, so the
    // route-level MFA counters accumulate across tests; raise the cap so the
    // later tests are not throttled by earlier evidence.
    IAM_RATE_LIMIT_IP_MFA_MAX: '100',
  };
  config = loadEnv(rawEnv);
  pool = createPool(started.infra.databaseUrl);
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

function deleteJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** R1-06A: a challenge completion must present the challenge AND its device cookie. */
function challengeCookies(challengeToken: string, deviceToken: string): string {
  return `${CHALLENGE_COOKIE}=${challengeToken}; ${DEVICE_COOKIE}=${deviceToken}`;
}

/** Reads one cookie by name from a response (cleared cookies come back empty). */
function cookieValue(response: Response, name: string): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (eq > 0 && pair?.slice(0, eq) === name) {
      return pair.slice(eq + 1);
    }
  }
  return undefined;
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s period) — independent of the API provider. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`base32Decode: invalid character ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secret: string, atMs: number): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = (hash[hash.length - 1] ?? 0) & 0x0f;
  if (offset === undefined) {
    throw new Error('totp: empty hash');
  }
  const binary =
    (((hash[offset] ?? 0) & 0x7f) << 24) |
    ((hash[offset + 1] ?? 0) << 16) |
    ((hash[offset + 2] ?? 0) << 8) |
    (hash[offset + 3] ?? 0);
  return (binary % 1_000_000).toString().padStart(6, '0');
}

function secretFromUri(uri: string): string {
  const parsed = new URL(uri);
  const secret = parsed.searchParams.get('secret');
  if (secret === null || secret === '') {
    throw new Error(`otpauth URI carries no secret: ${uri}`);
  }
  return secret;
}

/** Registers + logs in (no MFA yet); returns the session cookie token and account id. */
async function signIn(
  baseUrl: string,
  email: string,
): Promise<{ token: string; accountId: string }> {
  const registration = await postJson(baseUrl, '/v1/account/registrations', {
    email,
    password: PASSWORD,
  });
  expect(registration.status).toBe(201);
  const session = await postJson(baseUrl, '/v1/account/sessions', { email, password: PASSWORD });
  expect(session.status).toBe(201);
  const body = (await session.json()) as { account_id: string };
  const token = cookieValue(session, SESSION_COOKIE);
  if (token === undefined) {
    throw new Error('login did not set the session cookie');
  }
  return { token, accountId: body.account_id };
}

interface FactorDbRow {
  id: string;
  account_id: string;
  state: string;
  secret_ciphertext: string;
  secret_key_id: string;
  enabled_at: Date | null;
}

async function factorRows(accountId: string): Promise<FactorDbRow[]> {
  const result = await pool.query<FactorDbRow>(
    `SELECT id, account_id, state, secret_ciphertext, secret_key_id, enabled_at
       FROM iam.mfa_factors WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return result.rows;
}

interface RecoveryCodeDbRow {
  id: string;
  factor_id: string;
  code_digest: string;
  used_at: Date | null;
}

async function recoveryCodeRows(accountId: string): Promise<RecoveryCodeDbRow[]> {
  const result = await pool.query<RecoveryCodeDbRow>(
    `SELECT id, factor_id, code_digest, used_at
       FROM iam.recovery_codes WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return result.rows;
}

interface SessionDbRow {
  id: string;
  state: string;
  auth_level: string;
  revoked_reason: string | null;
  token_digest: string;
  device_id: string | null;
}

async function sessionRows(accountId: string): Promise<SessionDbRow[]> {
  const result = await pool.query<SessionDbRow>(
    `SELECT id, state, auth_level, revoked_reason, token_digest, device_id
       FROM iam.sessions WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return result.rows;
}

interface ChallengeDbRow {
  id: string;
  state: string;
  attempt_count: number;
  device_id: string | null;
  method_set: string[];
}

async function challengeRows(accountId: string): Promise<ChallengeDbRow[]> {
  const result = await pool.query<ChallengeDbRow>(
    `SELECT id, state, attempt_count, device_id, method_set
       FROM iam.mfa_challenges WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return result.rows;
}

interface DeviceDbRow {
  id: string;
  device_digest: string;
  ip_hmac: string;
  label: string;
  ua_digest: string;
  ua_summary: string | null;
}

async function deviceRows(accountId: string): Promise<DeviceDbRow[]> {
  const result = await pool.query<DeviceDbRow>(
    `SELECT id, device_digest, ip_hmac, label, ua_digest, ua_summary
       FROM iam.devices WHERE account_id = $1 ORDER BY first_seen_at`,
    [accountId],
  );
  return result.rows;
}

async function securityEvents(
  accountId: string,
): Promise<Array<{ event_type: string; reason: string }>> {
  const result = await pool.query<{ event_type: string; reason: string }>(
    'SELECT event_type, reason FROM iam.security_events WHERE account_id = $1 ORDER BY created_at',
    [accountId],
  );
  return result.rows;
}

/** Enrolls and confirms MFA for a signed-in account; returns the TOTP secret + codes. */
async function enableMfa(
  baseUrl: string,
  token: string,
): Promise<{ secret: string; codes: string[]; sessionToken: string }> {
  const start = await postJson(
    baseUrl,
    '/v1/account/mfa/totp/enrollment',
    { password: PASSWORD },
    { cookie: `${SESSION_COOKIE}=${token}` },
  );
  expect(start.status).toBe(201);
  const startBody = (await start.json()) as { factor_id: string; otpauth_uri: string };
  expect(startBody.factor_id).toMatch(UUID_V4);
  expect(startBody.otpauth_uri.startsWith('otpauth://totp/')).toBe(true);
  const secret = secretFromUri(startBody.otpauth_uri);

  const confirm = await postJson(
    baseUrl,
    '/v1/account/mfa/totp/enrollment/confirm',
    { totp_code: totpCode(secret, Date.now()) },
    { cookie: `${SESSION_COOKIE}=${token}` },
  );
  expect(confirm.status).toBe(200);
  const confirmBody = (await confirm.json()) as { recovery_codes: string[] };
  expect(confirmBody.recovery_codes).toHaveLength(10);
  for (const code of confirmBody.recovery_codes) {
    expect(code).toMatch(RECOVERY_CODE_FORMAT);
  }
  const sessionToken = cookieValue(confirm, SESSION_COOKIE);
  if (sessionToken === undefined) {
    throw new Error('confirm did not rotate the session cookie');
  }
  return { secret, codes: confirmBody.recovery_codes, sessionToken };
}

/**
 * Password login when MFA is enabled → 401 MFA_REQUIRED + challenge cookie.
 * R1-06A: the response also carries the device cookie the challenge is bound
 * to — completing it REQUIRES that same cookie.
 */
async function startChallenge(
  baseUrl: string,
  email: string,
): Promise<{ challengeToken: string; deviceToken: string }> {
  const login = await postJson(baseUrl, '/v1/account/sessions', { email, password: PASSWORD });
  expect(login.status).toBe(401);
  expect(((await login.json()) as { code: string }).code).toBe('MFA_REQUIRED');
  const challengeToken = cookieValue(login, CHALLENGE_COOKIE);
  const deviceToken = cookieValue(login, DEVICE_COOKIE);
  if (challengeToken === undefined) {
    throw new Error('MFA_REQUIRED login did not set the challenge cookie');
  }
  if (deviceToken === undefined) {
    throw new Error('MFA_REQUIRED login did not set the device cookie');
  }
  return { challengeToken, deviceToken };
}

describe('TOTP MFA over real infrastructure', () => {
  it('enrollment: secret travels only in the once-returned URI, confirm enables + rotates to AAL2', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'enroll@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { secret, codes, sessionToken } = await enableMfa(baseUrl, token);

      // The old session was rotated to AAL2 and the response token works.
      expect(sessionToken).toMatch(OPAQUE_TOKEN);
      expect(sessionToken).not.toBe(token);
      const current = await fetch(`${baseUrl}/v1/account/session`, {
        headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
      });
      expect(current.status).toBe(200);
      expect(((await current.json()) as { auth_level: string }).auth_level).toBe('aal2');

      // DB: factor enabled, ciphertext holds NO raw secret, digest-only codes.
      const factors = await factorRows(accountId);
      expect(factors).toHaveLength(1);
      expect(factors[0]?.state).toBe('enabled');
      expect(factors[0]?.enabled_at).not.toBeNull();
      expect(factors[0]?.secret_ciphertext).not.toContain(secret);
      expect(factors[0]?.secret_key_id).toBe('dev-key');

      const rows = await recoveryCodeRows(accountId);
      expect(rows).toHaveLength(10);
      for (const code of codes) {
        expect(
          rows.some(
            (row) =>
              row.code_digest ===
              hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'recovery', code),
          ),
        ).toBe(true);
      }
      expect(rows.map((row) => row.code_digest)).not.toContain(codes[0]);

      // The old AAL1 session was rotated away as the auth strength changed —
      // its token is dead (state 'rotated', the reason lives in the audit
      // event), the new session carries AAL2.
      const sessions = await sessionRows(accountId);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.state).toBe('rotated');
      expect(sessions[1]?.state).toBe('active');
      expect(sessions[1]?.auth_level).toBe('aal2');

      // The enrollment URI is never returned again.
      const again = await postJson(
        baseUrl,
        '/v1/account/mfa/totp/enrollment',
        { password: PASSWORD },
        { cookie: `${SESSION_COOKIE}=${sessionToken}` },
      );
      expect(again.status).toBe(409);
      expect(((await again.json()) as { code: string }).code).toBe('MFA_ALREADY_ENABLED');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('repeated start answers 409 while PENDING; confirm resolves the unique pending (R1-04)', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'pending-slot@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);

      const first = await postJson(
        baseUrl,
        '/v1/account/mfa/totp/enrollment',
        { password: PASSWORD },
        { cookie: `${SESSION_COOKIE}=${token}` },
      );
      expect(first.status).toBe(201);
      const secret = secretFromUri(((await first.json()) as { otpauth_uri: string }).otpauth_uri);

      // A second start while the first enrollment is still pending: 409 —
      // pending occupies the unique slot (the 0001 code created a duplicate).
      const second = await postJson(
        baseUrl,
        '/v1/account/mfa/totp/enrollment',
        { password: PASSWORD },
        { cookie: `${SESSION_COOKIE}=${token}` },
      );
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe('MFA_ENROLLMENT_IN_PROGRESS');

      // Exactly one factor row exists and confirm resolves it.
      let factors = await factorRows(accountId);
      expect(factors).toHaveLength(1);
      expect(factors[0]?.state).toBe('pending');

      const confirm = await postJson(
        baseUrl,
        '/v1/account/mfa/totp/enrollment/confirm',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: `${SESSION_COOKIE}=${token}` },
      );
      expect(confirm.status).toBe(200);
      factors = await factorRows(accountId);
      expect(factors).toHaveLength(1);
      expect(factors[0]?.state).toBe('enabled');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('concurrent enrollment starts: exactly one pending factor, the loser answers 409 (R1-04)', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'concurrent-start@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const headers = { cookie: `${SESSION_COOKIE}=${token}` };

      const [a, b] = await Promise.all([
        postJson(baseUrl, '/v1/account/mfa/totp/enrollment', { password: PASSWORD }, headers),
        postJson(baseUrl, '/v1/account/mfa/totp/enrollment', { password: PASSWORD }, headers),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      expect(statuses[1]).toBe(409);
      const loserCode = ((a.status === 409 ? await a.json() : await b.json()) as { code: string })
        .code;
      // The account row lock serializes the starts, so the loser sees the
      // winner's pending factor; accept both codes for any interleaving.
      expect(['MFA_ENROLLMENT_IN_PROGRESS', 'MFA_ALREADY_ENABLED']).toContain(loserCode);

      const factors = await factorRows(accountId);
      expect(factors).toHaveLength(1);
      expect(factors[0]?.state).toBe('pending');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('disable frees the slot: re-enrollment succeeds afterwards (R1-04)', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 're-enroll@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { codes, sessionToken } = await enableMfa(baseUrl, token);

      const disable = await deleteJson(
        baseUrl,
        '/v1/account/mfa/totp',
        { password: PASSWORD, recovery_code: codes[0] },
        { cookie: `${SESSION_COOKIE}=${sessionToken}` },
      );
      expect(disable.status).toBe(204);

      const again = await postJson(
        baseUrl,
        '/v1/account/mfa/totp/enrollment',
        { password: PASSWORD },
        { cookie: `${SESSION_COOKIE}=${cookieValue(disable, SESSION_COOKIE) ?? ''}` },
      );
      expect(again.status).toBe(201);

      const factors = await factorRows(accountId);
      expect(factors).toHaveLength(2);
      expect(factors[0]?.state).toBe('disabled');
      expect(factors[1]?.state).toBe('pending');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('password login now demands the single-use challenge; TOTP completes it into an AAL2 session', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'challenge@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { secret, sessionToken } = await enableMfa(baseUrl, token);

      const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
      expect(challengeToken).toMatch(OPAQUE_TOKEN);

      const complete = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: challengeCookies(challengeToken, deviceToken) },
      );
      expect(complete.status).toBe(200);
      const completeBody = (await complete.json()) as {
        session_id: string;
        auth_level: string;
        state: string;
      };
      expect(completeBody.auth_level).toBe('aal2');
      expect(completeBody.state).toBe('active');
      expect(JSON.stringify(completeBody)).not.toContain(challengeToken);
      const newToken = cookieValue(complete, SESSION_COOKIE);
      expect(newToken).toMatch(OPAQUE_TOKEN);
      expect(newToken).not.toBe(sessionToken);
      // Challenge cookie cleared on success, device cookie set.
      expect(cookieValue(complete, CHALLENGE_COOKIE)).toBe('');
      expect(cookieValue(complete, 'wai_device')).toMatch(OPAQUE_TOKEN);

      // The same challenge token can never complete twice.
      const replay = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: challengeCookies(challengeToken, deviceToken) },
      );
      expect(replay.status).toBe(401);
      expect(((await replay.json()) as { code: string }).code).toBe('MFA_INVALID');

      const sessions = await sessionRows(accountId);
      const active = sessions.filter((row) => row.state === 'active');
      expect(active).toHaveLength(2); // the rotated enrollment session + this login
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('five wrong codes burn the attempt budget, then the challenge expires', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'bruteforce@example.invalid';
      const { token } = await signIn(baseUrl, email);
      await enableMfa(baseUrl, token);

      const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
      const headers = { cookie: challengeCookies(challengeToken, deviceToken) };
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const wrong = await postJson(
          baseUrl,
          '/v1/account/sessions/mfa',
          { totp_code: '000000' },
          headers,
        );
        if (attempt < 5) {
          expect(wrong.status).toBe(401);
          expect(((await wrong.json()) as { code: string }).code).toBe('MFA_INVALID');
          // Budget left: the server must NOT clear the challenge cookie, so
          // the client can retry with the same token.
          expect(cookieValue(wrong, CHALLENGE_COOKIE)).not.toBe('');
        }
      }

      // The 6th attempt finds the (already expired) challenge — terminal.
      const sixth = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: '000000' },
        headers,
      );
      expect(sixth.status).toBe(401);
      expect(((await sixth.json()) as { code: string }).code).toBe('MFA_CHALLENGE_EXPIRED');
      expect(cookieValue(sixth, CHALLENGE_COOKIE)).toBe('');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('concurrent wrong codes never push attempt_count past max and never 500 (R1-05)', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'concurrent-bruteforce@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      await enableMfa(baseUrl, token);

      const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
      const headers = { cookie: challengeCookies(challengeToken, deviceToken) };

      // 8 parallel wrong-code misses against a 5-attempt budget: the count
      // must cap at max_attempts (atomic conditional UPDATE), the losers must
      // answer a stable 401 — never a 500 from a constraint violation.
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          postJson(baseUrl, '/v1/account/sessions/mfa', { totp_code: '000000' }, headers),
        ),
      );
      for (const response of responses) {
        expect(response.status).toBe(401);
        const body = (await response.json()) as { code: string };
        expect(['MFA_INVALID', 'MFA_CHALLENGE_EXPIRED']).toContain(body.code);
      }

      const result = await pool.query<{ attempt_count: number; state: string }>(
        `SELECT attempt_count, state FROM iam.mfa_challenges
          WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [accountId],
      );
      const challenge = result.rows[0];
      expect(challenge?.attempt_count).toBe(5);
      expect(challenge?.state).toBe('expired');

      const sessions = await sessionRows(accountId);
      expect(sessions.filter((row) => row.state === 'active')).toHaveLength(1); // only the enrollment session
      const codes = await recoveryCodeRows(accountId);
      expect(codes.filter((row) => row.used_at !== null)).toHaveLength(0); // no code burned
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('recovery-code login consumes the code exactly once, even when raced', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'recovery-login@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { codes } = await enableMfa(baseUrl, token);
      const code = codes[0];
      if (code === undefined) {
        throw new Error('enableMfa returned no codes');
      }

      const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
      const headers = { cookie: challengeCookies(challengeToken, deviceToken) };
      const [a, b] = await Promise.all([
        postJson(
          baseUrl,
          '/v1/account/sessions/mfa',
          { recovery_code: code.toLowerCase() },
          headers,
        ),
        postJson(baseUrl, '/v1/account/sessions/mfa', { recovery_code: code }, headers),
      ]);

      // The challenge itself is single-use: exactly one completion wins.
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
      const loser = a.status === 200 ? b : a;
      // Both 401 outcomes are valid single-use interleavings: a contender
      // already inside completion loses consumeChallenge as MFA_INVALID;
      // one scheduled after the winner commits observes a terminal challenge
      // as MFA_CHALLENGE_EXPIRED. The durable invariants below are identical.
      expect(['MFA_INVALID', 'MFA_CHALLENGE_EXPIRED']).toContain(
        ((await loser.json()) as { code: string }).code,
      );
      const winner = a.status === 200 ? a : b;
      expect(cookieValue(winner, SESSION_COOKIE)).toMatch(OPAQUE_TOKEN);

      // DB: exactly one session issued and the code consumed once.
      const active = (await sessionRows(accountId)).filter((row) => row.state === 'active');
      expect(active).toHaveLength(2);
      const codesRow = (await recoveryCodeRows(accountId)).find(
        (row) =>
          row.code_digest ===
          hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'recovery', code),
      );
      expect(codesRow?.used_at).not.toBeNull();

      // The consumed code is dead: a fresh challenge cannot use it again.
      const again = await startChallenge(baseUrl, email);
      const reused = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { recovery_code: code },
        { cookie: challengeCookies(again.challengeToken, again.deviceToken) },
      );
      expect(reused.status).toBe(401);
      expect(((await reused.json()) as { code: string }).code).toBe('RECOVERY_CODE_INVALID');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('regenerate replaces the unused codes; the old ones stop working', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'regenerate@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { codes, sessionToken } = await enableMfa(baseUrl, token);
      const oldCode = codes[0];
      if (oldCode === undefined) {
        throw new Error('enableMfa returned no codes');
      }

      const regenerate = await postJson(
        baseUrl,
        '/v1/account/mfa/recovery-codes/regenerate',
        { password: PASSWORD },
        { cookie: `${SESSION_COOKIE}=${sessionToken}` },
      );
      expect(regenerate.status).toBe(200);
      const fresh = ((await regenerate.json()) as { recovery_codes: string[] }).recovery_codes;
      expect(fresh).toHaveLength(10);
      expect(fresh).not.toContain(oldCode);

      const rows = await recoveryCodeRows(accountId);
      expect(rows.filter((row) => row.used_at === null)).toHaveLength(10);
      for (const code of fresh) {
        expect(
          rows.some(
            (row) =>
              row.code_digest ===
              hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'recovery', code),
          ),
        ).toBe(true);
      }

      // The old code is gone: a challenge completed with it fails.
      const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
      const stale = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { recovery_code: oldCode },
        { cookie: challengeCookies(challengeToken, deviceToken) },
      );
      expect(stale.status).toBe(401);
      expect(((await stale.json()) as { code: string }).code).toBe('RECOVERY_CODE_INVALID');

      // A fresh code completes the challenge.
      const freshCode = fresh[0];
      if (freshCode === undefined) {
        throw new Error('regenerate returned no codes');
      }
      const again = await startChallenge(baseUrl, email);
      const done = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { recovery_code: freshCode },
        { cookie: challengeCookies(again.challengeToken, again.deviceToken) },
      );
      expect(done.status).toBe(200);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it("concurrent disable with the same recovery code: exactly one wins, the loser's request fails", async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'disable-race@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { codes, sessionToken } = await enableMfa(baseUrl, token);
      const code = codes[0];
      if (code === undefined) {
        throw new Error('enableMfa returned no codes');
      }

      const headers = { cookie: `${SESSION_COOKIE}=${sessionToken}` };
      const body = { password: PASSWORD, recovery_code: code };
      const [a, b] = await Promise.all([
        deleteJson(baseUrl, '/v1/account/mfa/totp', body, headers),
        deleteJson(baseUrl, '/v1/account/mfa/totp', body, headers),
      ]);

      const statuses = [a.status, b.status].sort();
      // The winner always answers 204. The loser's answer depends on the race
      // window: if it read the factor before the winner's commit it reaches the
      // recovery-code consumption and answers 401 RECOVERY_CODE_INVALID; if it
      // read the factor after the winner's commit the factor is already
      // disabled and it answers 404 NOT_FOUND ("No enabled MFA factor"). Both
      // are correct: the code is consumed exactly once and the factor flips
      // exactly once, whichever interleaving wins. The deterministic
      // RECOVERY_CODE_INVALID path is covered by the concurrent login case.
      expect(statuses[0]).toBe(204);
      expect([401, 404]).toContain(statuses[1]);
      const loser = a.status === 204 ? b : a;
      if (loser.status === 401) {
        expect(((await loser.json()) as { code: string }).code).toBe('RECOVERY_CODE_INVALID');
      } else {
        expect(((await loser.json()) as { code: string }).code).toBe('NOT_FOUND');
      }

      const factors = await factorRows(accountId);
      expect(factors[0]?.state).toBe('disabled');
      const used = (await recoveryCodeRows(accountId)).find(
        (row) =>
          row.code_digest ===
          hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'recovery', code),
      );
      expect(used?.used_at).not.toBeNull();

      // Exactly one rotation happened: the disabled family has one active AAL1.
      const sessions = await sessionRows(accountId);
      const active = sessions.filter((row) => row.state === 'active');
      expect(active).toHaveLength(1);
      expect(active[0]?.auth_level).toBe('aal1');

      // Password login works again — no challenge.
      const login = await postJson(baseUrl, '/v1/account/sessions', { email, password: PASSWORD });
      expect(login.status).toBe(201);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('disable with a TOTP code re-verifies the second factor and revokes the other session', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'disable-totp@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { secret } = await enableMfa(baseUrl, token);

      // Second AAL2 session from the MFA login flow.
      const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
      const second = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: challengeCookies(challengeToken, deviceToken) },
      );
      expect(second.status).toBe(200);
      const secondToken = cookieValue(second, SESSION_COOKIE);
      if (secondToken === undefined) {
        throw new Error('MFA login did not set a session cookie');
      }

      const disable = await deleteJson(
        baseUrl,
        '/v1/account/mfa/totp',
        { password: PASSWORD, totp_code: totpCode(secret, Date.now()) },
        { cookie: `${SESSION_COOKIE}=${secondToken}` },
      );
      expect(disable.status).toBe(204);
      const rotatedToken = cookieValue(disable, SESSION_COOKIE);
      expect(rotatedToken).toMatch(OPAQUE_TOKEN);
      expect(rotatedToken).not.toBe(secondToken);

      // The disabling session rotated to AAL1; the OTHER session was revoked.
      const current = await fetch(`${baseUrl}/v1/account/session`, {
        headers: { cookie: `${SESSION_COOKIE}=${rotatedToken ?? ''}` },
      });
      expect(current.status).toBe(200);
      expect(((await current.json()) as { auth_level: string }).auth_level).toBe('aal1');
      const sessions = await sessionRows(accountId);
      expect(sessions.filter((row) => row.state === 'active')).toHaveLength(1);
      const revoked = sessions.find(
        (row) => row.state === 'revoked' && row.revoked_reason === 'mfa_strength_change',
      );
      expect(revoked).toBeDefined();

      // Password-only login succeeds now.
      const login = await postJson(baseUrl, '/v1/account/sessions', { email, password: PASSWORD });
      expect(login.status).toBe(201);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('disable rejects a wrong password or a stale code without side effects', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'disable-fail@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { codes, sessionToken } = await enableMfa(baseUrl, token);
      const code = codes[0];
      if (code === undefined) {
        throw new Error('enableMfa returned no codes');
      }
      const headers = { cookie: `${SESSION_COOKIE}=${sessionToken}` };

      const badPassword = await deleteJson(
        baseUrl,
        '/v1/account/mfa/totp',
        { password: 'wrong-password', recovery_code: code },
        headers,
      );
      expect(badPassword.status).toBe(401);
      expect(((await badPassword.json()) as { code: string }).code).toBe('INVALID_PASSWORD');
      expect((await factorRows(accountId))[0]?.state).toBe('enabled');

      const badCode = await deleteJson(
        baseUrl,
        '/v1/account/mfa/totp',
        { password: PASSWORD, recovery_code: 'ABCD-EFGH-JKMN-PQRS' },
        headers,
      );
      expect(badCode.status).toBe(401);
      expect(((await badCode.json()) as { code: string }).code).toBe('RECOVERY_CODE_INVALID');
      expect((await factorRows(accountId))[0]?.state).toBe('enabled');
      // No recovery code was burned by the failed attempt.
      expect(
        (await recoveryCodeRows(accountId)).filter((row) => row.used_at === null),
      ).toHaveLength(10);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('R1-06A: the challenge binds to the password-step device — stolen cookies cannot redeem it', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'device-bound@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { secret } = await enableMfa(baseUrl, token);

      // "Browser A" and "Browser B" each start their own challenge, bound to
      // their own device rows.
      const a = await startChallenge(baseUrl, email);
      const b = await startChallenge(baseUrl, email);
      expect(a.deviceToken).not.toBe(b.deviceToken);
      const challenges = await challengeRows(accountId);
      const challengeA = challenges[0];
      const challengeB = challenges[1];
      if (challengeA === undefined || challengeB === undefined) {
        throw new Error('expected two challenge rows');
      }
      expect(challengeA.device_id).not.toBeNull();
      expect(challengeA.device_id).not.toBe(challengeB.device_id);
      // The password-step device is persisted per challenge.
      const devices = await deviceRows(accountId);
      expect(devices.map((row) => row.id)).toContain(challengeA.device_id);
      expect(devices.map((row) => row.id)).toContain(challengeB.device_id);

      // A stolen challenge cookie WITHOUT the device cookie: uniform 401.
      const noDevice = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: `${CHALLENGE_COOKIE}=${a.challengeToken}` },
      );
      expect(noDevice.status).toBe(401);
      expect(((await noDevice.json()) as { code: string }).code).toBe('MFA_INVALID');

      // A stolen challenge cookie with the WRONG device's cookie: same 401.
      const wrongDevice = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: challengeCookies(a.challengeToken, b.deviceToken) },
      );
      expect(wrongDevice.status).toBe(401);
      expect(((await wrongDevice.json()) as { code: string }).code).toBe('MFA_INVALID');

      // Device mismatches cannot burn the victim's code-attempt budget — and
      // no session was issued by either failure.
      const afterFailures = await challengeRows(accountId);
      expect(afterFailures[0]?.attempt_count).toBe(0);
      expect(afterFailures[1]?.attempt_count).toBe(0);
      expect((await sessionRows(accountId)).filter((row) => row.state === 'active')).toHaveLength(
        1,
      ); // the enrollment session only
      // The internal reason is audited, but the public envelope stays uniform.
      const failures = (await securityEvents(accountId)).filter(
        (event) => event.event_type === 'mfa.challenge_failed',
      );
      expect(failures.map((event) => event.reason)).toEqual([
        'MFA_DEVICE_MISMATCH',
        'MFA_DEVICE_MISMATCH',
      ]);

      // The bound device completes the SAME challenge into an AAL2 session
      // tied to that device row.
      const complete = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: challengeCookies(a.challengeToken, a.deviceToken) },
      );
      expect(complete.status).toBe(200);
      expect(cookieValue(complete, SESSION_COOKIE)).toMatch(OPAQUE_TOKEN);
      const sessions = await sessionRows(accountId);
      expect(
        sessions.some((row) => row.state === 'active' && row.device_id === challengeA.device_id),
      ).toBe(true);
      expect((await challengeRows(accountId))[0]?.state).toBe('consumed');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('R1-06A: with every recovery code spent, a challenge accepts TOTP only', async () => {
    const { baseUrl, api } = await startApi({ IAM_RATE_LIMIT_LOGIN_EMAIL_MAX: '100' });
    try {
      const email = 'totp-only@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { secret, codes } = await enableMfa(baseUrl, token);

      // Burn all 10 codes through real challenge completions.
      for (const code of codes) {
        const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
        const done = await postJson(
          baseUrl,
          '/v1/account/sessions/mfa',
          { recovery_code: code },
          { cookie: challengeCookies(challengeToken, deviceToken) },
        );
        expect(done.status).toBe(200);
      }
      const unused = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM iam.recovery_codes WHERE account_id = $1 AND used_at IS NULL',
        [accountId],
      );
      expect(Number(unused.rows[0]?.n)).toBe(0);

      // The next challenge carries only TOTP in its method set.
      const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
      const challenges = await challengeRows(accountId);
      const last = challenges[challenges.length - 1];
      expect(last?.method_set).toEqual(['totp']);
      expect(last?.device_id).not.toBeNull();

      // A recovery attempt is rejected — and consumes nothing, so the SAME
      // challenge still completes with a TOTP code.
      const recovery = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { recovery_code: codes[0] },
        { cookie: challengeCookies(challengeToken, deviceToken) },
      );
      expect(recovery.status).toBe(401);
      expect(((await recovery.json()) as { code: string }).code).toBe('RECOVERY_CODE_INVALID');
      const afterAttempt = await challengeRows(accountId);
      expect(afterAttempt[afterAttempt.length - 1]?.attempt_count).toBe(1);
      const stillUnused = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM iam.recovery_codes WHERE account_id = $1 AND used_at IS NULL',
        [accountId],
      );
      expect(Number(stillUnused.rows[0]?.n)).toBe(0);
      // The failed attempt issued no session — the count stays at the
      // enrollment session plus the 10 recovery-login sessions.
      const activeBefore = (await sessionRows(accountId)).filter((row) => row.state === 'active');
      expect(activeBefore).toHaveLength(11);

      const totp = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: challengeCookies(challengeToken, deviceToken) },
      );
      expect(totp.status).toBe(200);
      expect(cookieValue(totp, SESSION_COOKIE)).toMatch(OPAQUE_TOKEN);
      expect((await sessionRows(accountId)).filter((row) => row.state === 'active')).toHaveLength(
        12,
      );
    } finally {
      await closeApiApp(api);
    }
  }, 90_000);

  it('R1-06B: devices store only the HMAC of the IP prefix — never the raw address', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'ip-prefix@example.invalid';
      const { token, accountId } = await signIn(baseUrl, email);
      const { secret } = await enableMfa(baseUrl, token);

      const { challengeToken, deviceToken } = await startChallenge(baseUrl, email);
      const challenges = await challengeRows(accountId);
      const boundDevice = (await deviceRows(accountId)).find(
        (row) => row.id === challenges[0]?.device_id,
      );
      if (boundDevice === undefined) {
        throw new Error('challenge device not found');
      }
      // The loopback /24 prefix digest — never the full 127.0.0.1.
      expect(boundDevice.ip_hmac).toBe(
        hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'device-ip', '127.0.0.0/24'),
      );
      expect(JSON.stringify(await deviceRows(accountId))).not.toContain('127.0.0.1');

      // Completing the challenge keeps the device and binds the session to it.
      const complete = await postJson(
        baseUrl,
        '/v1/account/sessions/mfa',
        { totp_code: totpCode(secret, Date.now()) },
        { cookie: challengeCookies(challengeToken, deviceToken) },
      );
      expect(complete.status).toBe(200);
      expect(
        (await sessionRows(accountId)).some(
          (row) => row.state === 'active' && row.device_id === boundDevice.id,
        ),
      ).toBe(true);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);
});
