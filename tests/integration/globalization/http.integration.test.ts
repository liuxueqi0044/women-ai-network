import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { loadEnv, type AppConfig } from '@wai/config';
import { createPool, MigrationRunner } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { closeApiApp, createApiApp } from '../../../apps/api/src/app.js';
import { valkeyUrl } from '../helpers.js';

declare const WAI_MIGRATIONS_DIR: string;
let started: StartedInfra;
let env: NodeJS.ProcessEnv;
let config: AppConfig;
let baseUrl: string;
let goodOrigin: string;
let app: Awaited<ReturnType<typeof createApiApp>>;
let cookie = '';
let accountId = '';

function port(): number {
  const address = (app.getHttpServer() as Server).address();
  if (!address || typeof address === 'string') throw new Error('api did not bind');
  return address.port;
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
async function put(
  body: unknown,
  version: number,
  key: string,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/v1/globalization/preferences`, {
    method: 'PUT',
    headers: {
      cookie,
      'content-type': 'application/json',
      'if-match': `"${version}"`,
      'idempotency-key': key,
      origin: goodOrigin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
const prefs = {
  ui_locale: 'fr',
  content_locales: ['fr', 'en'],
  time_zone: 'Europe/Paris',
  hour_cycle: 'h24',
  week_start: 0,
};

beforeAll(async () => {
  started = await startTestInfra();
  env = {
    NODE_ENV: 'test',
    LOG_PRETTY: 'false',
    LOG_LEVEL: 'warn',
    DATABASE_URL: started.infra.databaseUrl,
    VALKEY_URL: valkeyUrl(started.infra),
  };
  config = loadEnv(env);
  const pool = createPool(started.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  await pool.end();
  app = await createApiApp(config);
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${port()}`;
  goodOrigin = config.corsOrigins[0] ?? 'http://127.0.0.1:3000';
  const registration = await post('/v1/account/registrations', {
    email: 'glo-http@example.invalid',
    password: 'correct horse battery staple',
  });
  accountId = ((await registration.json()) as { account_id: string }).account_id;
  const login = await post('/v1/account/sessions', {
    email: 'glo-http@example.invalid',
    password: 'correct horse battery staple',
  });
  cookie =
    login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .find((value): value is string => value !== undefined && value.startsWith('wai_session')) ??
    '';
}, 180_000);
afterAll(async () => {
  await closeApiApp(app);
  await started.stop();
});

describe('GLO-01 authenticated HTTP contract', () => {
  it('keeps catalog public, preferences session-bound and strict', async () => {
    const catalog = await fetch(`${baseUrl}/v1/globalization/catalog`);
    expect(catalog.status).toBe(200);
    const anonymous = await fetch(`${baseUrl}/v1/globalization/preferences`);
    expect(anonymous.status).toBe(401);
    const read = await fetch(`${baseUrl}/v1/globalization/preferences`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect((await jsonBody<{ version: number }>(read)).version).toBe(0);
    const extra = await put({ ...prefs, account_id: accountId }, 0, 'glo-http-extra-fields');
    expect(extra.status).toBe(400);
  });
  it('enforces Origin, replay, version, timezone and rate-limit contracts', async () => {
    const invalidOrigin = await put(prefs, 0, 'glo-http-origin', {
      origin: 'https://evil.example',
    });
    expect(invalidOrigin.status).toBe(403);
    const missingIfMatch = await fetch(`${baseUrl}/v1/globalization/preferences`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json',
        'idempotency-key': 'glo-http-no-if-match',
        origin: goodOrigin,
      },
      body: JSON.stringify(prefs),
    });
    expect(missingIfMatch.status).toBe(428);
    expect((await jsonBody<{ code: string }>(missingIfMatch)).code).toBe('PRECONDITION_REQUIRED');
    const first = await fetch(`${baseUrl}/v1/globalization/preferences`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json',
        'if-match': '"0"',
        'idempotency-key': 'glo-http-first-key',
        origin: goodOrigin,
      },
      body: JSON.stringify(prefs),
    });
    expect(first.status).toBe(200);
    const firstBody = await jsonBody<{ version: number }>(first);
    expect(firstBody.version).toBe(1);
    const replay = await fetch(`${baseUrl}/v1/globalization/preferences`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json',
        'if-match': '"0"',
        'idempotency-key': 'glo-http-first-key',
        origin: goodOrigin,
      },
      body: JSON.stringify(prefs),
    });
    expect(replay.status).toBe(200);
    expect((await jsonBody<{ version: number }>(replay)).version).toBe(1);
    const conflict = await fetch(`${baseUrl}/v1/globalization/preferences`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json',
        'if-match': '"0"',
        'idempotency-key': 'glo-http-first-key',
        origin: goodOrigin,
      },
      body: JSON.stringify({ ...prefs, week_start: 6 }),
    });
    expect(conflict.status).toBe(409);
    expect((await jsonBody<{ code: string }>(conflict)).code).toBe('IDEMPOTENCY_CONFLICT');
    const stale = await put({ ...prefs, week_start: 1 }, 0, 'glo-http-stale-key');
    expect(stale.status).toBe(409);
    expect((await jsonBody<{ code: string }>(stale)).code).toBe('VERSION_CONFLICT');
    const badZone = await put({ ...prefs, time_zone: 'Mars/Nope' }, 1, 'glo-http-zone-key');
    expect(badZone.status).toBe(400);
    expect((await jsonBody<{ code: string }>(badZone)).code).toBe('INVALID_TIME_ZONE');
    const rateEmail = 'glo-http-rate@example.invalid';
    await post('/v1/account/registrations', {
      email: rateEmail,
      password: 'correct horse battery staple',
    });
    const rateLogin = await post('/v1/account/sessions', {
      email: rateEmail,
      password: 'correct horse battery staple',
    });
    const rateCookie =
      rateLogin.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .find((value): value is string => value !== undefined && value.startsWith('wai_session')) ??
      '';
    const rateResults = [] as number[];
    for (let index = 0; index < 30; index += 1) {
      const allowed = await put({ ...prefs, week_start: index % 7 }, 0, `glo-http-limit-${index}`, {
        cookie: rateCookie,
      });
      rateResults.push(allowed.status);
    }
    expect(rateResults).toHaveLength(30);
    expect(rateResults.every((status) => status !== 429)).toBe(true);
    const limited = await put(prefs, 0, 'glo-http-limit-final', { cookie: rateCookie });
    expect(limited.status).toBe(429);
    expect((await jsonBody<{ code: string }>(limited)).code).toBe('RATE_LIMITED');
  });
  it('disabled account cannot read or write', async () => {
    const pool = createPool(env['DATABASE_URL'] as string);
    await pool.query(
      `UPDATE iam.accounts SET state='suspended', state_reason='admin_suspend' WHERE id=$1`,
      [accountId],
    );
    await pool.end();
    const read = await fetch(`${baseUrl}/v1/globalization/preferences`, { headers: { cookie } });
    expect(read.status).toBe(401);
    expect((await jsonBody<{ code: string }>(read)).code).toBe('ACCOUNT_STATE_DENIED');
    const write = await put(prefs, 1, 'glo-http-disabled');
    expect(write.status).toBe(401);
    expect((await jsonBody<{ code: string }>(write)).code).toBe('SESSION_REQUIRED');
  });
});
