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
 * CP5 evidence over real Postgres + Valkey containers (task book §9): devices
 * are created at login from a server-random opaque cookie (never the raw
 * User-Agent — only a coarse summary and its keyed digest), re-login reuses
 * the same record, list/rename/revoke work on the caller's devices only,
 * revoking a device atomically revokes every session bound to it, and
 * cross-account ids answer the same stable 404 as unknown ones.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE = 'wai_session_dev';
const DEVICE_COOKIE = 'wai_device';
const PASSWORD = 'correct horse battery staple';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15';

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

interface SignedIn {
  token: string;
  deviceToken: string;
  accountId: string;
}

/** Registers and logs in with a User-Agent; returns session + device cookies. */
async function signIn(
  baseUrl: string,
  email: string,
  userAgent: string = CHROME_UA,
  deviceToken?: string,
): Promise<SignedIn> {
  const registration = await postJson(baseUrl, '/v1/account/registrations', {
    email,
    password: PASSWORD,
  });
  expect(registration.status).toBe(201);
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    ...(deviceToken === undefined ? {} : { cookie: `${DEVICE_COOKIE}=${deviceToken}` }),
  };
  const session = await postJson(
    baseUrl,
    '/v1/account/sessions',
    { email, password: PASSWORD },
    headers,
  );
  expect(session.status).toBe(201);
  const body = (await session.json()) as { account_id: string };
  const token = cookieValue(session, SESSION_COOKIE);
  const freshDevice = cookieValue(session, DEVICE_COOKIE);
  if (token === undefined || freshDevice === undefined) {
    throw new Error('login did not set the session and device cookies');
  }
  return { token, deviceToken: freshDevice, accountId: body.account_id };
}

interface DeviceDbRow {
  id: string;
  account_id: string;
  device_digest: string;
  label: string;
  ua_digest: string;
  ua_summary: string | null;
  ip_hmac: string;
  first_seen_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

async function deviceRows(accountId: string): Promise<DeviceDbRow[]> {
  const result = await pool.query<DeviceDbRow>(
    `SELECT id, account_id, device_digest, label, ua_digest, ua_summary, ip_hmac,
            first_seen_at, last_seen_at, revoked_at
       FROM iam.devices WHERE account_id = $1 ORDER BY first_seen_at`,
    [accountId],
  );
  return result.rows;
}

interface SessionDbRow {
  id: string;
  state: string;
  revoked_reason: string | null;
  device_id: string | null;
}

async function sessionRows(accountId: string): Promise<SessionDbRow[]> {
  const result = await pool.query<SessionDbRow>(
    `SELECT id, state, revoked_reason, device_id
       FROM iam.sessions WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return result.rows;
}

describe('devices over real infrastructure', () => {
  it('login creates a device from the opaque cookie; re-login reuses the record', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'device@example.invalid';
      const first = await signIn(baseUrl, email, CHROME_UA);
      expect(first.deviceToken).toMatch(OPAQUE_TOKEN);

      const rows = await deviceRows(first.accountId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) {
        throw new Error('no device row after login');
      }
      // Minimal metadata only: coarse summary + keyed digests, never the raw UA.
      expect(row.label).toBe('Chrome on Windows');
      expect(row.ua_summary).toBe('Chrome on Windows');
      expect(row.ua_digest).toBe(
        hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'ua', CHROME_UA),
      );
      expect(row.device_digest).toBe(
        hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'device', first.deviceToken),
      );
      expect(row.device_digest).not.toBe(first.deviceToken);
      // R1-06B: the client IP lands only as the HMAC of its /24 prefix — the
      // test infra sees loopback 127.0.0.1, which reduces to 127.0.0.0/24.
      expect(row.ip_hmac).toBe(
        hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'device-ip', '127.0.0.0/24'),
      );
      expect(JSON.stringify(row)).not.toContain('127.0.0.1');
      expect(row.revoked_at).toBeNull();

      // The session is bound to the device.
      const sessions = await sessionRows(first.accountId);
      expect(sessions[0]?.device_id).toBe(row.id);

      // A second login with the SAME cookie reuses the id and refreshes seen times.
      const second = await signIn(baseUrl, email, SAFARI_UA, first.deviceToken);
      expect(second.deviceToken).toBe(first.deviceToken);
      const after = await deviceRows(first.accountId);
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(row.id);
      expect(after[0]?.first_seen_at.getTime()).toBe(row.first_seen_at.getTime());
      expect(after[0]?.last_seen_at.getTime()).toBeGreaterThanOrEqual(row.last_seen_at.getTime());
      // The label follows the LAST seen User-Agent, the digest too; the IP
      // prefix HMAC is refreshed from the same loopback prefix.
      expect(after[0]?.label).toBe('Safari on macOS');
      expect(after[0]?.ua_digest).toBe(
        hmacDigest(Buffer.from(config.iam.secretPepper, 'utf8'), 'ua', SAFARI_UA),
      );
      expect(after[0]?.ip_hmac).toBe(row.ip_hmac);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('lists the caller’s devices newest-first and renames one', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'list@example.invalid';
      const first = await signIn(baseUrl, email, CHROME_UA);
      await signIn(baseUrl, email, SAFARI_UA, first.deviceToken);
      await signIn(baseUrl, email, 'curl/8.7.1');

      const listed = await fetch(`${baseUrl}/v1/account/devices`, {
        headers: { cookie: `${SESSION_COOKIE}=${first.token}` },
      });
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as {
        devices: Array<{
          device_id: string;
          label: string;
          summary: string;
          first_seen_at: string;
          last_seen_at: string;
        }>;
      };
      expect(body.devices).toHaveLength(2);
      // Newest first: the curl login is the most recent device.
      expect(body.devices[0]?.label).toBe('Unknown browser on Unknown OS');
      expect(body.devices[0]?.summary).toBe('Unknown browser on Unknown OS');
      expect(body.devices[0]?.device_id).toMatch(UUID_V4);
      expect(body.devices[1]?.label).toBe('Safari on macOS');
      const firstSeen = body.devices.map((device) => new Date(device.first_seen_at).getTime());
      expect([...firstSeen].sort((x, y) => y - x)).toEqual(firstSeen); // newest first
      const id = body.devices[1]?.device_id;
      if (id === undefined) {
        throw new Error('list returned no devices');
      }

      const rename = await fetch(`${baseUrl}/v1/account/devices/${id}`, {
        method: 'PATCH',
        headers: {
          cookie: `${SESSION_COOKIE}=${first.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ label: 'Work laptop' }),
      });
      expect(rename.status).toBe(200);
      const renamed = (await rename.json()) as { device_id: string; label: string };
      expect(renamed.device_id).toBe(id);
      expect(renamed.label).toBe('Work laptop');

      const rows = await deviceRows(first.accountId);
      expect(rows.find((row) => row.id === id)?.label).toBe('Work laptop');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('revoking a device atomically revokes every active session bound to it', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'revoke@example.invalid';
      const first = await signIn(baseUrl, email, CHROME_UA);
      // Same cookie again: a SECOND session on the SAME device record.
      await signIn(baseUrl, email, CHROME_UA, first.deviceToken);
      // A different cookie: a device that must survive the revoke.
      const third = await signIn(baseUrl, email, 'curl/8.7.1');

      const listed = await fetch(`${baseUrl}/v1/account/devices`, {
        headers: { cookie: `${SESSION_COOKIE}=${first.token}` },
      });
      const body = (await listed.json()) as {
        devices: Array<{ device_id: string; label: string }>;
      };
      // The Chrome device carries BOTH sessions — revoking it must kill both.
      const target = body.devices.find((device) => device.label === 'Chrome on Windows')?.device_id;
      if (target === undefined) {
        throw new Error('expected a device to revoke');
      }

      const revoke = await fetch(`${baseUrl}/v1/account/devices/${target}`, {
        method: 'DELETE',
        headers: { cookie: `${SESSION_COOKIE}=${first.token}` },
      });
      expect(revoke.status).toBe(204);

      const rows = await deviceRows(first.accountId);
      expect(rows.find((row) => row.id === target)?.revoked_at).not.toBeNull();

      const sessions = await sessionRows(first.accountId);
      const revokedSessions = sessions.filter(
        (row) => row.device_id === target && row.state === 'revoked',
      );
      // Both sessions bound to the device were revoked in one shot...
      expect(revokedSessions.length).toBeGreaterThanOrEqual(2);
      for (const row of revokedSessions) {
        expect(row.revoked_reason).toBe('device_revoked');
      }
      // ...while sessions of OTHER devices stay active.
      const otherActive = sessions.filter(
        (row) => row.device_id !== target && row.state === 'active',
      );
      expect(otherActive.length).toBeGreaterThan(0);

      // The revoked device disappears from the list. The revoke killed the
      // sessions bound to it (including first.token's), so list with a token
      // whose device survived.
      const after = await fetch(`${baseUrl}/v1/account/devices`, {
        headers: { cookie: `${SESSION_COOKIE}=${third.token}` },
      });
      expect(after.status).toBe(200);
      const afterBody = (await after.json()) as { devices: Array<{ device_id: string }> };
      expect(afterBody.devices.map((device) => device.device_id)).not.toContain(target);
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('re-login after a revoke re-activates the device (the cookie is the identity)', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const email = 'reactivate@example.invalid';
      const first = await signIn(baseUrl, email, CHROME_UA);

      const listed = await fetch(`${baseUrl}/v1/account/devices`, {
        headers: { cookie: `${SESSION_COOKIE}=${first.token}` },
      });
      const body = (await listed.json()) as { devices: Array<{ device_id: string }> };
      const target = body.devices[0]?.device_id;
      if (target === undefined) {
        throw new Error('no device to revoke');
      }
      const revoke = await fetch(`${baseUrl}/v1/account/devices/${target}`, {
        method: 'DELETE',
        headers: { cookie: `${SESSION_COOKIE}=${first.token}` },
      });
      expect(revoke.status).toBe(204);
      expect((await deviceRows(first.accountId))[0]?.revoked_at).not.toBeNull();

      // Logging in again with the SAME device cookie brings the record back.
      const again = await signIn(baseUrl, email, CHROME_UA, first.deviceToken);
      expect(again.deviceToken).toBe(first.deviceToken);
      const rows = await deviceRows(first.accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(target);
      expect(rows[0]?.revoked_at).toBeNull();
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);

  it('cross-account device ids answer the same stable 404 as unknown ids', async () => {
    const { baseUrl, api } = await startApi();
    try {
      const owner = await signIn(baseUrl, 'device-owner@example.invalid', CHROME_UA);
      const intruder = await signIn(baseUrl, 'device-intruder@example.invalid', SAFARI_UA);

      const listed = await fetch(`${baseUrl}/v1/account/devices`, {
        headers: { cookie: `${SESSION_COOKIE}=${owner.token}` },
      });
      const body = (await listed.json()) as { devices: Array<{ device_id: string }> };
      const ownerDeviceId = body.devices[0]?.device_id;
      if (ownerDeviceId === undefined) {
        throw new Error('owner has no devices');
      }

      const unknown = '00000000-0000-4000-8000-000000000000';
      for (const deviceId of [ownerDeviceId, unknown]) {
        const rename = await fetch(`${baseUrl}/v1/account/devices/${deviceId}`, {
          method: 'PATCH',
          headers: {
            cookie: `${SESSION_COOKIE}=${intruder.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ label: 'hijacked' }),
        });
        expect(rename.status).toBe(404);
        expect(((await rename.json()) as { code: string }).code).toBe('DEVICE_NOT_FOUND');

        const revoke = await fetch(`${baseUrl}/v1/account/devices/${deviceId}`, {
          method: 'DELETE',
          headers: { cookie: `${SESSION_COOKIE}=${intruder.token}` },
        });
        expect(revoke.status).toBe(404);
        expect(((await revoke.json()) as { code: string }).code).toBe('DEVICE_NOT_FOUND');
      }

      // The owner’s device and sessions are untouched.
      const ownerRows = await deviceRows(owner.accountId);
      expect(ownerRows[0]?.revoked_at).toBeNull();
      expect(ownerRows[0]?.label).toBe('Chrome on Windows');
      expect((await sessionRows(owner.accountId))[0]?.state).toBe('active');
    } finally {
      await closeApiApp(api);
    }
  }, 60_000);
});
