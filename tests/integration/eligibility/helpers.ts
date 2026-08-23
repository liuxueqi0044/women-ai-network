import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { loadEnv, type AppConfig } from '@wai/config';
import { createDb, createPool, MigrationRunner, type Db } from '@wai/db';
import type { WaiLogger } from '@wai/observability';
import {
  startOpaTestContainer,
  startTestInfra,
  type StartedInfra,
  type StartedOpa,
} from '@wai/testkit';
import { closeApiApp, createApiApp } from '../../../apps/api/src/app.js';
import type { OpaConfig } from '../../../apps/api/src/eligibility/infra/opa-config.js';
import { valkeyUrl } from '../helpers.js';
import { seedSyntheticPolicy } from './seed.js';

// Injected by vitest.config.ts (`define`); resolves to packages/db/migrations.
declare const WAI_MIGRATIONS_DIR: string;
// Injected by vitest.config.ts; resolves to packages/authz/policies.
declare const WAI_POLICIES_DIR: string;

export const SESSION_COOKIE = 'wai_session_dev';
export const PASSWORD = 'correct horse battery staple';

export type ApiApp = Awaited<ReturnType<typeof createApiApp>>;

export interface EligibilityHarness {
  started: StartedInfra;
  config: AppConfig;
  db: Db;
  seedPolicy: boolean;
}

/**
 * Starts the Postgres/Valkey containers, applies all migrations and (by
 * default) seeds the synthetic US policy. With `opa: true` the pinned OPA
 * container is started and wired into the API via the third createApiApp
 * argument. Shared by the CP4/CP5 integration files — each test file runs in
 * its own worker process (fileParallelism is off), so infra never overlaps.
 */
export async function startEligibilityHarness(
  opts: { seedPolicy?: boolean; logger?: WaiLogger; opa?: boolean } = {},
): Promise<{
  started: StartedInfra;
  config: AppConfig;
  db: Db;
  pool: Pool;
  baseUrl: string;
  api: ApiApp;
  opa: StartedOpa | undefined;
}> {
  const started = await startTestInfra();
  const rawEnv = {
    NODE_ENV: 'test',
    LOG_PRETTY: 'false',
    LOG_LEVEL: 'warn',
    DATABASE_URL: started.infra.databaseUrl,
    VALKEY_URL: valkeyUrl(started.infra),
  };
  const config = loadEnv(rawEnv);
  const pool = createPool(started.infra.databaseUrl);
  const db = createDb(pool);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  if (opts.seedPolicy !== false) {
    await seedSyntheticPolicy(db);
  }
  let opa: StartedOpa | undefined;
  let opaConfig: OpaConfig | undefined;
  if (opts.opa === true) {
    opa = await startOpaTestContainer(WAI_POLICIES_DIR);
    opaConfig = { baseUrl: opa.baseUrl, queryTimeoutMs: 5_000 };
  }
  const api = await createApiApp(
    config,
    opts.logger === undefined ? undefined : { logger: opts.logger },
    opaConfig,
  );
  await api.listen(0, '127.0.0.1');
  return { started, config, db, pool, baseUrl: `http://127.0.0.1:${httpPort(api)}`, api, opa };
}

export async function stopEligibilityHarness(harness: {
  api: ApiApp;
  started: StartedInfra;
  pool: Pool;
  opa?: StartedOpa;
}): Promise<void> {
  await closeApiApp(harness.api);
  await harness.pool.end();
  await harness.opa?.stop();
  await harness.started.stop();
}

function httpPort(api: ApiApp): number {
  const server = api.getHttpServer() as Server;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('API did not bind to a TCP port');
  }
  return address.port;
}

/**
 * Waits until a backend is blocked on a lock while inserting into `table`
 * (pg_stat_activity). Used by the deterministic 409 race tests: a test-held
 * uncommitted row occupies the partial unique index slot, the API request's
 * insert blocks behind it, and the test commits to force the 23505.
 */
export async function waitForBlockedInsert(
  pool: Pool,
  table: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ blocked: string }>(
      `SELECT count(*)::text AS blocked
       FROM pg_stat_activity
       WHERE state = 'active' AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()
         AND query ILIKE '%' || $1 || '%'`,
      [table],
    );
    if (rows[0]?.blocked === '1') {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a blocked insert into ${table}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function parseSetCookies(response: Response): Array<{ name: string; value: string }> {
  return response.headers.getSetCookie().map((raw) => {
    const [pair] = raw.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    return {
      name: eq > 0 ? (pair?.slice(0, eq) ?? '') : '',
      value: eq > 0 ? (pair?.slice(eq + 1) ?? '') : '',
    };
  });
}

export function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

export function putJson(
  baseUrl: string,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

export function getJson(baseUrl: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: cookie === undefined ? {} : { cookie },
  });
}

/**
 * Registers an account and logs in; returns the full `name=value` cookie
 * header entry (the same shape IAM-01 integration tests use — fastify only
 * populates request.cookies from well-formed cookie pairs).
 */
export async function registerAndLogin(
  baseUrl: string,
  email: string,
): Promise<{ accountId: string; cookie: string }> {
  const registration = await postJson(baseUrl, '/v1/account/registrations', {
    email,
    password: PASSWORD,
  });
  if (registration.status !== 201) {
    throw new Error(`registration failed with ${registration.status}`);
  }
  const session = await postJson(baseUrl, '/v1/account/sessions', { email, password: PASSWORD });
  if (session.status !== 201) {
    throw new Error(`login failed with ${session.status}`);
  }
  const accountId = ((await registration.json()) as { account_id: string }).account_id;
  const value = parseSetCookies(session).find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  if (value.length === 0) {
    throw new Error('login did not set the session cookie');
  }
  return { accountId, cookie: `${SESSION_COOKIE}=${value}` };
}
