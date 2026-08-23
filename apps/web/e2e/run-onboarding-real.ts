/**
 * ONB-01 real-browser evidence runner.
 *
 * This is intentionally a runner (rather than a Playwright route-mocked spec):
 * it starts its own Postgres, Valkey, OPA, API and Web processes, registers a
 * real account, and drives the browser against the network.  The fixed
 * non-default ports make the build-time API URL observable while the
 * try/finally teardown keeps failed runs from leaking local resources.
 *
 * Run from the repository root with:
 *   pnpm --filter @wai/web exec tsx e2e/run-onboarding-real.ts
 */
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import type { Pool } from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_PORT = Number(process.env['WAI_E2E_API_PORT'] ?? 3310);
const WEB_PORT = Number(process.env['WAI_E2E_WEB_PORT'] ?? 3300);
if (
  !Number.isInteger(API_PORT) ||
  API_PORT < 1024 ||
  !Number.isInteger(WEB_PORT) ||
  WEB_PORT < 1024
) {
  throw new Error('WAI_E2E_API_PORT and WAI_E2E_WEB_PORT must be valid non-privileged ports');
}
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

// This runner owns and explicitly stops every PG/Valkey/OPA container it
// starts.  Disabling the process-global Ryuk socket is important for a
// standalone Windows run: if a timed-out shell leaves Ryuk behind, the next
// run can otherwise reuse a stale socket and keep retrying after teardown.
// The testkit lifecycle remains the cleanup authority for this runner.
process.env['TESTCONTAINERS_RYUK_DISABLED'] = 'true';
process.env['MEDIA_UPLOADS_ENABLED'] = 'false';
const SESSION_COOKIE = 'wai_session_dev';
const PASSWORD = 'correct horse battery staple';

type ApiApp = {
  listen: (options: { port: number; host: string }) => Promise<unknown>;
  get: <T>(token: unknown) => T;
  close: () => Promise<void>;
};

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<void> {
  await Promise.race([
    work.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function command(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

async function waitFor(url: string, timeoutMs = 90_000, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`process exited with ${String(child.exitCode)} while waiting for ${url}`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      last = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${String(last)}`);
}

function kill(child: ChildProcess | undefined): void {
  if (child === undefined || child.exitCode !== null) return;
  child.kill('SIGTERM');
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    child.once('exit', finish);
    kill(child);
    setTimeout(finish, 5_000);
  });
}

function runBuild(): void {
  const buildEnv = {
    ...process.env,
    NEXT_PUBLIC_API_BASE_URL: `${API_ORIGIN}/v1`,
    NEXT_PUBLIC_ONBOARDING_PROVIDER: 'unconfigured',
  };
  for (const [label, args] of [
    ['workspace packages', ['build:packages']],
    ['API', ['--filter', '@wai/api', 'build']],
    ['Web', ['--filter', '@wai/web', 'build']],
  ] as const) {
    const result = spawnSync(command('pnpm'), args, {
      cwd: ROOT,
      env: buildEnv,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) throw new Error(`${label} build failed with ${String(result.status)}`);
  }
}

async function postJson(pathname: string, body: unknown, origin = WEB_ORIGIN): Promise<Response> {
  return fetch(`${API_ORIGIN}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const raw = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (raw === undefined) throw new Error('login did not set the session cookie');
  return raw.split(';', 1)[0]!;
}

async function registerAndLogin(): Promise<{ accountId: string; cookie: string }> {
  const email = `onb-real-${randomUUID()}@example.invalid`;
  const registration = await postJson('/v1/account/registrations', { email, password: PASSWORD });
  const registrationBody = await registration.text();
  assert.equal(registration.status, 201, registrationBody);
  const accountId = (JSON.parse(registrationBody) as { account_id: string }).account_id;
  const login = await postJson('/v1/account/sessions', { email, password: PASSWORD });
  const loginBody = await login.text();
  assert.equal(login.status, 201, loginBody);
  return { accountId, cookie: cookieFrom(login) };
}

async function seedGate(pool: Pool, accountId: string, api: ApiApp, cookie: string): Promise<void> {
  const eligibility = await fetch(`${API_ORIGIN}/v1/eligibility/jurisdiction`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
    body: JSON.stringify({ country_code: 'US' }),
  });
  assert.equal(eligibility.status, 200, await eligibility.text());

  const now = new Date();
  const identityCaseId = randomUUID();
  const membershipPolicyId = randomUUID();
  const membershipCaseId = randomUUID();
  const policyHash = randomUUID().replaceAll('-', '').repeat(2);
  await pool.query(
    `INSERT INTO verification.identity_cases
       (id, account_id, state, age_assurance_state, version, created_at, updated_at, verified_at)
     VALUES ($1,$2,'verified','attested',1,$3,$3,$3)`,
    [identityCaseId, accountId, now],
  );
  await pool.query(
    `INSERT INTO verification.membership_policies
       (id, revision, status, content_hash, legal_basis_ref, reviewed_by, reviewed_at,
        effective_from, effective_until, created_at)
     VALUES ($1,1,'approved',$2,'real-runner:synthetic','real-runner',$3,$4,'infinity',$3)`,
    [membershipPolicyId, policyHash, now, new Date(now.getTime() - 60_000)],
  );
  await pool.query(
    `INSERT INTO verification.membership_cases
       (id, account_id, policy_id, policy_revision, policy_content_hash, statement_category,
        consented_at, state, version, submitted_at, decided_at, created_at, updated_at)
     VALUES ($1,$2,$3,1,$4,'community_participation',$5,'approved',1,$5,$5,$5,$5)`,
    [membershipCaseId, accountId, membershipPolicyId, policyHash, now],
  );
  const { AgeCredentialService } = await import(
    '../../../apps/api/dist/eligibility/services/age-credential.service.js'
  );
  const issuer = api.get<InstanceType<typeof AgeCredentialService>>(AgeCredentialService);
  await issuer.issueExternalAttestation({
    accountId,
    evidenceId: randomUUID(),
    verificationCaseId: identityCaseId,
    attestationDigest: 'b'.repeat(64),
    birthDate: '1990-06-15',
    assuranceExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

async function advancePreferencesOutsideBrowser(cookie: string): Promise<void> {
  const stateResponse = await fetch(`${API_ORIGIN}/v1/onboarding/state?purpose=discovery`, {
    headers: { cookie },
  });
  const stateBody = (await stateResponse.json()) as {
    session: { modes: string[]; modes_version: number };
    preferences: { version: number };
  };
  assert.equal(stateResponse.status, 200);
  const response = await fetch(`${API_ORIGIN}/v1/onboarding/preferences`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin: WEB_ORIGIN,
      cookie,
      'idempotency-key': `real-external-${randomUUID()}`,
    },
    body: JSON.stringify({
      purpose: 'discovery',
      modes: stateBody.session.modes,
      mode: stateBody.session.modes[0],
      modes_version: stateBody.session.modes_version,
      expected_version: stateBody.preferences.version,
      preferences: [
        {
          mode: stateBody.session.modes[0],
          criterion: 'communication_style',
          strength: 'strong_preference',
          value: 'External concurrent edit',
          deal_breaker: false,
        },
      ],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
}

async function assertForbiddenOrigin(cookie: string): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/v1/onboarding/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example.invalid',
      cookie,
      'idempotency-key': `real-forbidden-${randomUUID()}`,
    },
    body: JSON.stringify({ purpose: 'discovery', modes: ['friends'], dating_enabled: false }),
  });
  assert.equal(response.status, 403, await response.text());
}

async function assertCredentialedCors(): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/v1/onboarding/sessions`, {
    method: 'OPTIONS',
    headers: {
      origin: WEB_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,idempotency-key',
    },
  });
  assert.ok(response.status === 200 || response.status === 204);
  assert.equal(response.headers.get('access-control-allow-origin'), WEB_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /DELETE/);
}

async function exercise(page: Page, label: string, cookie: string): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/onboarding`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create session' }).click();
  try {
    await page.getByRole('heading', { name: 'Tell us in your own words' }).waitFor({
      state: 'visible',
      timeout: 15_000,
    });
  } catch (error) {
    console.error(`real ${label} create-session UI state:`, await page.locator('main').innerText());
    throw error;
  }
  try {
    await page
      .getByLabel('What would make a connection feel worthwhile?')
      .fill(`${label}: weekday community projects and clear boundaries`);
  } catch (error) {
    console.error(`real ${label} answer UI state:`, await page.locator('main').innerText());
    throw error;
  }
  await page.getByRole('button', { name: 'Save and review' }).click();
  await page.getByRole('button', { name: 'Save manually' }).click();
  await assertVisible(page.getByRole('heading', { name: /Saved, with your control intact/ }));

  await page.reload({ waitUntil: 'networkidle' });
  await assertVisible(page.getByRole('heading', { name: /Saved, with your control intact/ }));
  await page.getByRole('button', { name: 'Edit choices' }).click();
  await page.getByRole('button', { name: 'Save manually' }).click();
  await assertVisible(page.getByRole('status').filter({ hasText: 'Existing choices kept' }));

  // Move the durable version from a second, real HTTP client. The browser
  // still holds the old version and its edited save must surface a 409.
  await advancePreferencesOutsideBrowser(cookie);
  await page.getByRole('button', { name: 'Edit choices' }).click();
  await page
    .getByLabel('What would make a connection feel worthwhile?')
    .fill(`${label}: stale browser edit`);
  await page.getByRole('button', { name: 'Save manually' }).click();
  await assertVisible(page.locator('p[role="alert"]').filter({ hasText: '409' }));
  await assertForbiddenOrigin(cookie);

  await page.getByRole('button', { name: 'Request editable AI suggestion' }).click();
  try {
    await assertVisible(page.locator('p[role="alert"]').filter({ hasText: '503' }));
  } catch (error) {
    console.error(`real ${label} AI UI state:`, await page.locator('main').innerText());
    throw error;
  }
  await page.getByRole('button', { name: 'Withdraw provider consent' }).click();
  await assertVisible(page.getByRole('status').filter({ hasText: 'consent withdrawn' }));
  await page.reload({ waitUntil: 'networkidle' });
  await assertVisible(page.getByRole('button', { name: 'Edit choices' }));
}

async function assertVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 15_000 });
}

async function main(): Promise<void> {
  let started:
    | {
        infra: { databaseUrl: string; valkey: { host: string; port: number; password: string } };
        stop: () => Promise<void>;
      }
    | undefined;
  let opa: { baseUrl: string; stop: () => Promise<void> } | undefined;
  let pool: Pool | undefined;
  let api: ApiApp | undefined;
  let closeApi: ((app: ApiApp) => Promise<void>) | undefined;
  let web: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    // Keep the runner cold-clone friendly: source imports of workspace
    // packages and the API are deliberately after their build outputs exist.
    runBuild();
    const { loadEnv } = await import('@wai/config');
    const { createDb, createPool, MigrationRunner } = await import('@wai/db');
    const { startOpaTestContainer, startTestInfra } = await import('@wai/testkit');
    const { seedSyntheticPolicy } = await import('../../../tests/integration/eligibility/seed.js');
    started = await startTestInfra();
    const valkeyUrl = `redis://:${started.infra.valkey.password}@${started.infra.valkey.host}:${started.infra.valkey.port}`;
    const config = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      LOG_PRETTY: 'false',
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      API_BASE_URL: API_ORIGIN,
      CORS_ORIGINS: WEB_ORIGIN,
      DATABASE_URL: started.infra.databaseUrl,
      VALKEY_URL: valkeyUrl,
      IAM_COOKIE_SECURE: 'false',
    });
    pool = createPool(started.infra.databaseUrl);
    const db = createDb(pool);
    await new MigrationRunner(pool, path.join(ROOT, 'packages/db/migrations')).up();
    await seedSyntheticPolicy(db);
    const { closeApiApp, createApiApp } = await import('../../../apps/api/dist/app.js');
    closeApi = closeApiApp as unknown as (app: ApiApp) => Promise<void>;
    opa = await startOpaTestContainer(path.join(ROOT, 'packages/authz/policies'));
    api = await createApiApp(config, {}, { baseUrl: opa.baseUrl, queryTimeoutMs: 5_000 });
    await api.listen({ port: API_PORT, host: '127.0.0.1' });
    await assertCredentialedCors();

    web = spawn(
      process.execPath,
      [
        path.join(ROOT, 'apps/web/node_modules/next/dist/bin/next'),
        'start',
        '-p',
        String(WEB_PORT),
      ],
      {
        cwd: path.join(ROOT, 'apps/web'),
        env: {
          ...process.env,
          NEXT_PUBLIC_API_BASE_URL: `${API_ORIGIN}/v1`,
          NEXT_PUBLIC_ONBOARDING_PROVIDER: 'unconfigured',
        },
        stdio: 'inherit',
      },
    );
    await waitFor(`${WEB_ORIGIN}/onboarding`, 90_000, web);

    browser = await chromium.launch({ headless: true });
    for (const [label, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['mobile', { width: 390, height: 844 }],
    ] as const) {
      const { accountId, cookie } = await registerAndLogin();
      await seedGate(pool, accountId, api, cookie);
      const [verification, eligibility] = await Promise.all([
        fetch(`${API_ORIGIN}/v1/verification/status`, { headers: { cookie } }),
        fetch(`${API_ORIGIN}/v1/eligibility/status`, { headers: { cookie } }),
      ]);
      console.log(
        `real ${label} gate: verification=${verification.status} ${await verification.text()} eligibility=${eligibility.status} ${await eligibility.text()}`,
      );
      const context: BrowserContext = await browser.newContext({ viewport });
      await context.addCookies([
        { name: SESSION_COOKIE, value: cookie.split('=', 2)[1]!, url: WEB_ORIGIN },
      ]);
      const page = await context.newPage();
      await exercise(page, label, cookie);
      await context.close();
      console.log(`real onboarding ${label}: ok`);
    }
    console.log('real onboarding runner: desktop/mobile passed; no route mocks used');
  } finally {
    await browser?.close().catch(() => undefined);
    await stopChild(web);
    if (api !== undefined && closeApi !== undefined) {
      await bounded(
        closeApi(api).catch(() => undefined),
        15_000,
      );
    }
    await bounded(pool?.end().catch(() => undefined) ?? Promise.resolve(), 5_000);
    await bounded(opa?.stop().catch(() => undefined) ?? Promise.resolve(), 15_000);
    await bounded(started?.stop().catch(() => undefined) ?? Promise.resolve(), 15_000);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
