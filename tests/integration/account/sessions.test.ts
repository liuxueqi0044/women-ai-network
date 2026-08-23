import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * CP4 evidence over real Postgres + Valkey containers (task book §6): the
 * session lifecycle vertical — current/touch, atomic rotate with
 * exactly-one-wins concurrency, replay of a rotated token compromising the
 * whole family, logout/revoke, account-state denial revoking live sessions,
 * cookie-only token transport, and digest-only storage.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_NAME = 'wai_session_dev';
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

function sessionCookie(
  response: Response,
): { name: string; value: string; raw: string } | undefined {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    const name = eq > 0 ? (pair?.slice(0, eq) ?? '') : '';
    if (name === COOKIE_NAME) {
      return { name, value: eq > 0 ? (pair?.slice(eq + 1) ?? '') : '', raw };
    }
  }
  return undefined;
}

function cookieHeader(token: string): Record<string, string> {
  return { cookie: `${COOKIE_NAME}=${token}` };
}

/** Registers + logs in; returns the session cookie token and account id. */
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
  const cookie = sessionCookie(session);
  if (cookie === undefined) {
    throw new Error('login did not set the session cookie');
  }
  return { token: cookie.value, accountId: body.account_id };
}

interface SessionDbRow {
  id: string;
  token_digest: string;
  state: string;
  family_id: string;
  generation: number;
  parent_id: string | null;
  successor_id: string | null;
  revoked_reason: string | null;
  absolute_expires_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
}

async function sessionRows(accountId: string): Promise<SessionDbRow[]> {
  const result = await pool.query<SessionDbRow>(
    `SELECT id, token_digest, state, family_id, generation, parent_id, successor_id,
            revoked_reason, absolute_expires_at, last_seen_at, idle_expires_at
       FROM iam.sessions WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return result.rows;
}

describe('session lifecycle over real infrastructure', () => {
  it('current session: touch slides the idle window and the token never leaves the cookie', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const { token, accountId } = await signIn(baseUrl, 'touch@example.invalid');

      const first = await fetch(`${baseUrl}/v1/account/session`, {
        headers: cookieHeader(token),
      });
      expect(first.status).toBe(200);
      const body = (await first.json()) as {
        session_id: string;
        account_id: string;
        auth_level: string;
        state: string;
      };
      expect(body.session_id).toMatch(UUID_V4);
      expect(body.auth_level).toBe('aal1');
      expect(body.state).toBe('active');
      expect(JSON.stringify(body)).not.toContain(token);

      // The touch recomputed last_seen and the idle expiry from the same clock.
      const row = (await sessionRows(accountId))[0];
      if (row === undefined) {
        throw new Error('session row missing after login');
      }
      expect(row.idle_expires_at.getTime() - row.last_seen_at.getTime()).toBe(
        config.iam.sessionIdleSeconds * 1000,
      );
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('touch near the absolute deadline caps the idle expiry and never 500s (R1-02)', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const { token, accountId } = await signIn(baseUrl, 'touch-end@example.invalid');
      // Force the session one minute from its absolute deadline — a naive
      // now+idle touch would write idle_expires_at past absolute and violate
      // the DB constraint (500). Timestamps keep the full ordering chain
      // created <= last_seen <= idle <= absolute valid.
      await pool.query(
        `UPDATE iam.sessions
            SET created_at = now() - interval '90 seconds',
                last_seen_at = now() - interval '30 seconds',
                idle_expires_at = now() + interval '30 seconds',
                absolute_expires_at = now() + interval '60 seconds'
          WHERE account_id = $1`,
        [accountId],
      );

      const response = await fetch(`${baseUrl}/v1/account/session`, {
        headers: cookieHeader(token),
      });
      expect(response.status).toBe(200);

      const row = (await sessionRows(accountId))[0];
      if (row === undefined) {
        throw new Error('session row missing after touch');
      }
      expect(row.idle_expires_at.getTime()).toBe(row.absolute_expires_at.getTime());
      expect(row.idle_expires_at.getTime() - row.last_seen_at.getTime()).toBeLessThanOrEqual(
        config.iam.sessionIdleSeconds * 1000,
      );
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('rotate near the absolute deadline caps the successor idle, never 500s (R1-02)', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const { token, accountId } = await signIn(baseUrl, 'rotate-end@example.invalid');
      await pool.query(
        `UPDATE iam.sessions
            SET created_at = now() - interval '90 seconds',
                last_seen_at = now() - interval '30 seconds',
                idle_expires_at = now() + interval '30 seconds',
                absolute_expires_at = now() + interval '60 seconds'
          WHERE account_id = $1`,
        [accountId],
      );

      const rotated = await fetch(`${baseUrl}/v1/account/session/rotate`, {
        method: 'POST',
        headers: cookieHeader(token),
      });
      expect(rotated.status).toBe(200);

      const rows = await sessionRows(accountId);
      const successor = rows.find((row) => row.generation === 2);
      if (successor === undefined) {
        throw new Error('successor session row missing after rotate');
      }
      expect(successor.idle_expires_at.getTime()).toBe(successor.absolute_expires_at.getTime());
      // The absolute expiry is inherited, never extended by rotation.
      expect(successor.absolute_expires_at.getTime()).toBeLessThanOrEqual(
        Date.now() + 60_000 + 5_000,
      );
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('rotate: fresh cookie, family continuity, inherited absolute expiry, replay burns the family', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const { token: oldToken, accountId } = await signIn(baseUrl, 'rotate@example.invalid');

      const rotated = await fetch(`${baseUrl}/v1/account/session/rotate`, {
        method: 'POST',
        headers: cookieHeader(oldToken),
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = (await rotated.json()) as { session_id: string; state: string };
      expect(rotatedBody.state).toBe('active');
      expect(JSON.stringify(rotatedBody)).not.toContain(oldToken);

      const newCookie = sessionCookie(rotated);
      expect(newCookie).toBeDefined();
      expect(newCookie?.value).toMatch(OPAQUE_TOKEN);
      expect(newCookie?.value).not.toBe(oldToken);
      expect(newCookie?.raw).toContain('HttpOnly');
      expect(newCookie?.raw).toMatch(/SameSite=Lax/i);
      expect(newCookie?.raw).toContain('Path=/');
      expect(newCookie?.raw).not.toContain('Secure'); // dev/test: http://127.0.0.1

      // DB: old row rotated with successor link; only the keyed digest is stored.
      const rows = await sessionRows(accountId);
      expect(rows).toHaveLength(2);
      const oldRow = rows[0];
      const successorRow = rows[1];
      expect(oldRow?.state).toBe('rotated');
      expect(oldRow?.successor_id).toBe(rotatedBody.session_id);
      expect(successorRow?.state).toBe('active');
      expect(successorRow?.family_id).toBe(oldRow?.family_id);
      expect(successorRow?.generation).toBe(2);
      expect(successorRow?.parent_id).toBe(oldRow?.id);
      expect(successorRow?.absolute_expires_at.getTime()).toBe(
        oldRow?.absolute_expires_at.getTime(),
      );
      expect(successorRow?.token_digest).toBe(
        hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'session', newCookie?.value ?? ''),
      );
      expect(rows.map((row) => row.token_digest)).not.toContain(oldToken);

      // The successor works...
      const current = await fetch(`${baseUrl}/v1/account/session`, {
        headers: cookieHeader(newCookie?.value ?? ''),
      });
      expect(current.status).toBe(200);

      // ...until the OLD token resurfaces: replay burns the whole family.
      const replay = await fetch(`${baseUrl}/v1/account/session`, {
        headers: cookieHeader(oldToken),
      });
      expect(replay.status).toBe(401);
      expect(((await replay.json()) as { code: string }).code).toBe('SESSION_REPLAY_DETECTED');
      expect(sessionCookie(replay)?.value).toBe('');

      const after = await sessionRows(accountId);
      expect(after[1]?.state).toBe('compromised');
      expect(after[1]?.revoked_reason).toBe('replay_detected');

      // Both the old token and the compromised successor are now dead.
      const successorDead = await fetch(`${baseUrl}/v1/account/session`, {
        headers: cookieHeader(newCookie?.value ?? ''),
      });
      expect(successorDead.status).toBe(401);
      expect(((await successorDead.json()) as { code: string }).code).toBe('SESSION_REQUIRED');

      const events = await pool.query<{ event_type: string; severity: string }>(
        'SELECT event_type, severity FROM iam.security_events WHERE account_id = $1 ORDER BY created_at',
        [accountId],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        'registration.created',
        'login.success',
        'session.rotated',
        'session.replay_detected',
      ]);
      expect(
        events.rows.find((row) => row.event_type === 'session.replay_detected')?.severity,
      ).toBe('critical');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('concurrent rotate: exactly one winner, the loser burns the family', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const { token, accountId } = await signIn(baseUrl, 'race@example.invalid');
      const headers = cookieHeader(token);

      const [a, b] = await Promise.all([
        fetch(`${baseUrl}/v1/account/session/rotate`, { method: 'POST', headers }),
        fetch(`${baseUrl}/v1/account/session/rotate`, { method: 'POST', headers }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
      const loser = a.status === 200 ? b : a;
      expect(((await loser.json()) as { code: string }).code).toBe('SESSION_REPLAY_DETECTED');

      // The winner's successor is compromised too — retrying the old request
      // killed the fresh session as well (the intended security posture).
      const rows = await sessionRows(accountId);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.state).toBe('rotated');
      expect(rows[1]?.state).toBe('compromised');
      expect(rows[1]?.revoked_reason).toBe('replay_detected');

      const winnerCookie = a.status === 200 ? sessionCookie(a) : sessionCookie(b);
      const winnerDead = await fetch(`${baseUrl}/v1/account/session`, {
        headers: cookieHeader(winnerCookie?.value ?? ''),
      });
      expect(winnerDead.status).toBe(401);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('accepts the token ONLY in the cookie — body, query and bearer are ignored', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const { token } = await signIn(baseUrl, 'cookie-only@example.invalid');

      const bearer = await fetch(`${baseUrl}/v1/account/session`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bearer.status).toBe(401);
      expect(((await bearer.json()) as { code: string }).code).toBe('SESSION_REQUIRED');

      const query = await fetch(`${baseUrl}/v1/account/session?token=${token}`);
      expect(query.status).toBe(401);

      const body = await postJson(baseUrl, '/v1/account/session/rotate', { token });
      expect(body.status).toBe(401);
      expect(((await body.json()) as { code: string }).code).toBe('SESSION_REQUIRED');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('logout revokes the session, clears the cookie and kills the old token', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const { token, accountId } = await signIn(baseUrl, 'logout@example.invalid');

      const logout = await fetch(`${baseUrl}/v1/account/session`, {
        method: 'DELETE',
        headers: cookieHeader(token),
      });
      expect(logout.status).toBe(204);
      expect(sessionCookie(logout)?.value).toBe('');

      const rows = await sessionRows(accountId);
      expect(rows[0]?.state).toBe('revoked');
      expect(rows[0]?.revoked_reason).toBe('logout');

      const events = await pool.query<{ reason: string }>(
        "SELECT reason FROM iam.security_events WHERE event_type = 'session.revoked' AND account_id = $1",
        [accountId],
      );
      expect(events.rows.map((row) => row.reason)).toContain('LOGOUT');

      const dead = await fetch(`${baseUrl}/v1/account/session`, {
        headers: cookieHeader(token),
      });
      expect(dead.status).toBe(401);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('lists active sessions newest first and revokes one by id', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const { token, accountId } = await signIn(baseUrl, 'list@example.invalid');
      for (let i = 0; i < 2; i += 1) {
        const extra = await postJson(baseUrl, '/v1/account/sessions', {
          email: 'list@example.invalid',
          password: PASSWORD,
        });
        expect(extra.status).toBe(201);
      }

      const listed = await fetch(`${baseUrl}/v1/account/sessions`, {
        headers: cookieHeader(token),
      });
      expect(listed.status).toBe(200);
      const listBody = (await listed.json()) as {
        sessions: Array<{ session_id: string; state: string; created_at: string }>;
      };
      expect(listBody.sessions).toHaveLength(3);
      expect(listBody.sessions.every((row) => row.state === 'active')).toBe(true);
      const created = listBody.sessions.map((row) => new Date(row.created_at).getTime());
      expect([...created].sort((x, y) => y - x)).toEqual(created); // newest first

      const victim = listBody.sessions[2];
      if (victim === undefined) {
        throw new Error('list returned no sessions');
      }
      const revoke = await fetch(`${baseUrl}/v1/account/sessions/${victim.session_id}`, {
        method: 'DELETE',
        headers: cookieHeader(token),
      });
      expect(revoke.status).toBe(204);

      const after = await sessionRows(accountId);
      expect(after.filter((row) => row.state === 'active')).toHaveLength(2);
      expect(after.find((row) => row.id === victim.session_id)?.state).toBe('revoked');
      const events = await pool.query<{ reason: string }>(
        "SELECT reason FROM iam.security_events WHERE event_type = 'session.revoked' AND account_id = $1",
        [accountId],
      );
      expect(events.rows.map((row) => row.reason)).toContain('REVOKED_BY_USER');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('revoking another account’s session answers the same 404 as an unknown id', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const owner = await signIn(baseUrl, 'owner@example.invalid');
      const intruder = await signIn(baseUrl, 'intruder@example.invalid');

      const mine = await fetch(`${baseUrl}/v1/account/sessions`, {
        headers: cookieHeader(owner.token),
      });
      const mineBody = (await mine.json()) as { sessions: Array<{ session_id: string }> };
      const ownerSessionId = mineBody.sessions[0]?.session_id;
      if (ownerSessionId === undefined) {
        throw new Error('owner has no sessions');
      }

      for (const sessionId of [ownerSessionId, '00000000-0000-4000-8000-000000000000']) {
        const revoke = await fetch(`${baseUrl}/v1/account/sessions/${sessionId}`, {
          method: 'DELETE',
          headers: cookieHeader(intruder.token),
        });
        expect(revoke.status).toBe(404);
        expect(((await revoke.json()) as { code: string }).code).toBe('NOT_FOUND');
      }

      const ownerRows = await sessionRows(owner.accountId);
      expect(ownerRows[0]?.state).toBe('active');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('suspended / deletion_pending / deleted accounts kill live sessions on the next request', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const cases = [
        { state: 'suspended', reason: 'admin_suspend', event: 'ACCOUNT_STATE_DENIED_SUSPENDED' },
        {
          state: 'deletion_pending',
          reason: 'user_deletion_request',
          event: 'ACCOUNT_STATE_DENIED_DELETION_PENDING',
        },
        { state: 'deleted', reason: 'deletion_completed', event: 'ACCOUNT_STATE_DENIED_DELETED' },
      ] as const;

      for (const test of cases) {
        const email = `${test.state}@example.invalid`;
        const { token, accountId } = await signIn(baseUrl, email);
        await pool.query(
          `UPDATE iam.accounts SET state = $1, state_reason = $2, state_actor_type = 'system',
             state_changed_at = now() WHERE id = $3`,
          [test.state, test.reason, accountId],
        );

        const denied = await fetch(`${baseUrl}/v1/account/session`, {
          headers: cookieHeader(token),
        });
        expect(denied.status).toBe(401);
        expect(((await denied.json()) as { code: string }).code).toBe('ACCOUNT_STATE_DENIED');
        expect(sessionCookie(denied)?.value).toBe('');

        const rows = await sessionRows(accountId);
        expect(rows[0]?.state).toBe('revoked');
        expect(rows[0]?.revoked_reason).toBe('account_state_denied');

        const events = await pool.query<{ reason: string }>(
          "SELECT reason FROM iam.security_events WHERE event_type = 'account.state_denied' AND account_id = $1",
          [accountId],
        );
        expect(events.rows.map((row) => row.reason)).toContain(test.event);

        const retry = await fetch(`${baseUrl}/v1/account/session`, {
          headers: cookieHeader(token),
        });
        expect(retry.status).toBe(401);
      }
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);
});
