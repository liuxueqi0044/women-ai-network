import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv, type AppConfig } from '@wai/config';
import { createPool, MigrationRunner } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { closeApiApp, createApiApp } from '../../../apps/api/src/app.js';
import { valkeyUrl } from '../helpers.js';

declare const WAI_MIGRATIONS_DIR: string;
let started: StartedInfra;
let app: Awaited<ReturnType<typeof createApiApp>>;
let baseUrl: string;
let config: AppConfig;
let cookie = '';

beforeAll(async () => {
  started = await startTestInfra();
  config = loadEnv({
    NODE_ENV: 'test',
    LOG_PRETTY: 'false',
    LOG_LEVEL: 'warn',
    DATABASE_URL: started.infra.databaseUrl,
    VALKEY_URL: valkeyUrl(started.infra),
  });
  const pool = createPool(started.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  await pool.end();
  app = await createApiApp(config);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('api did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const registration = await fetch(`${baseUrl}/v1/account/registrations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'mch-http@example.invalid',
      password: 'correct horse battery staple',
    }),
  });
  expect(registration.status).toBe(201);
  const login = await fetch(`${baseUrl}/v1/account/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'mch-http@example.invalid',
      password: 'correct horse battery staple',
    }),
  });
  cookie =
    login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0] ?? '')
      .find((value) => value.startsWith('wai_session')) ?? '';
}, 180_000);

afterAll(async () => {
  await closeApiApp(app);
  await started.stop();
});

describe('MCH-01 real HTTP boundary', () => {
  it('requires the session cookie and never accepts an account id from query', async () => {
    const anonymous = await fetch(`${baseUrl}/v1/introductions?mode=friends&account_id=other`);
    expect(anonymous.status).toBe(401);
    const authenticated = await fetch(`${baseUrl}/v1/introductions?mode=friends&account_id=other`, {
      headers: { cookie },
    });
    expect(authenticated.status).toBe(400);
    const body = await authenticated.text();
    expect(body).not.toContain('other');
    expect(body).not.toContain('score');
    const oversized = await fetch(`${baseUrl}/v1/introductions?mode=friends&limit=20`, {
      headers: { cookie },
    });
    expect(oversized.status).toBe(400);
  });
  it('rejects missing or malformed idempotency keys with a stable 400', async () => {
    const response = await fetch(`${baseUrl}/v1/introductions/${crypto.randomUUID()}/pass`, {
      method: 'POST',
      headers: {
        cookie,
        origin: config.corsOrigins[0] ?? 'http://127.0.0.1:3000',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ batch_id: crypto.randomUUID() }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Idempotency-Key is required');
  });
});
