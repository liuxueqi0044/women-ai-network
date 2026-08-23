import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { OPEN_ENDED } from '@wai/contracts';
import {
  getJson,
  putJson,
  registerAndLogin,
  startEligibilityHarness,
  stopEligibilityHarness,
  waitForBlockedInsert,
  type ApiApp,
} from './helpers.js';
import type { StartedInfra } from '@wai/testkit';

/**
 * CP4 evidence over real Postgres + Valkey: the jurisdiction declaration
 * vertical (task book §6). Session-bound routes, strict DTOs that reject
 * account_id injection, idempotent re-declaration, the supersede history
 * chain, the 409 concurrent race, and session-scoped status that can never
 * leak another account's data.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let started: StartedInfra;
let pool: Pool;
let baseUrl: string;
let api: ApiApp;
let emailSeq = 0;

beforeAll(async () => {
  const harness = await startEligibilityHarness();
  started = harness.started;
  pool = harness.pool;
  baseUrl = harness.baseUrl;
  api = harness.api;
}, 180_000);

afterAll(async () => {
  await stopEligibilityHarness({ api, started, pool });
});

function freshEmail(): string {
  emailSeq += 1;
  return `jurisdiction-${emailSeq}@example.invalid`;
}

async function currentDeclaration(accountId: string): Promise<{
  id: string;
  version: number;
  superseded_at: string | null;
} | null> {
  const { rows } = await pool.query<{ id: string; version: number; superseded_at: string | null }>(
    `SELECT id, version, superseded_at FROM eligibility.jurisdiction_declarations
     WHERE account_id = $1 ORDER BY version`,
    [accountId],
  );
  return rows[rows.length - 1] ?? null;
}

describe('PUT /v1/eligibility/jurisdiction', () => {
  it('answers SESSION_REQUIRED without a session cookie on every route', async () => {
    const attempts = [
      putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }),
      putJson(baseUrl, '/v1/eligibility/age-declaration', { birth_date: '2000-06-15' }),
      getJson(baseUrl, '/v1/eligibility/status'),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(401);
      const body = (await response.json()) as { code: string; message: string };
      // The error envelope also carries request_id from the global filter.
      expect(body).toMatchObject({ code: 'SESSION_REQUIRED', message: 'Session required' });
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('declares a country jurisdiction and returns the session-bound response', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    const response = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'US', source: 'self_declared' },
      cookie,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      declaration_id: string;
      country_code: string;
      review_state: string;
      effective_from: string;
    };
    expect(body.declaration_id).toMatch(UUID_V4);
    expect(body.country_code).toBe('US');
    expect(body.review_state).toBe('accepted');
    expect(body.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body).not.toHaveProperty('subdivision_code');

    const row = await currentDeclaration(accountId);
    expect(row?.id).toBe(body.declaration_id);
    expect(row?.version).toBe(1);
  });

  it('declares with a subdivision; the response carries subdivision_code', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    const response = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'US', subdivision_code: 'CA' },
      cookie,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { subdivision_code?: string };
    expect(body.subdivision_code).toBe('CA');
  });

  it('is idempotent: identical content returns the same declaration', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    const first = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'US', subdivision_code: 'CA' },
      cookie,
    );
    const second = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'US', subdivision_code: 'CA' },
      cookie,
    );
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { declaration_id: string; effective_from: string };
    const secondBody = (await second.json()) as { declaration_id: string; effective_from: string };
    expect(secondBody.declaration_id).toBe(firstBody.declaration_id);
    expect(secondBody.effective_from).toBe(firstBody.effective_from);
  });

  it('supersedes the old declaration on content change, preserving history', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, cookie);
    const changed = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'GB' },
      cookie,
    );
    expect(changed.status).toBe(200);
    const body = (await changed.json()) as { declaration_id: string };
    expect(body.declaration_id).toMatch(UUID_V4);

    const { rows } = await pool.query<{ version: number; superseded_at: string | null }>(
      `SELECT version, superseded_at FROM eligibility.jurisdiction_declarations
       WHERE account_id = $1 ORDER BY version`,
      [accountId],
    );
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    expect(rows[0]?.superseded_at).not.toBeNull();
    expect(rows[1]?.superseded_at).toBeNull();
  });

  it('rejects injected account_id and invalid codes with 400 VALIDATION_ERROR', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    const injected = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'US', account_id: '00000000-0000-4000-8000-000000000000' },
      cookie,
    );
    expect(injected.status).toBe(400);
    const injectedBody = (await injected.json()) as { code: string; details?: unknown };
    expect(injectedBody.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(injectedBody.details)).toBe(true);

    const lowercase = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'us' },
      cookie,
    );
    expect(lowercase.status).toBe(400);

    const badSubdivision = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'US', subdivision_code: 'california' },
      cookie,
    );
    expect(badSubdivision.status).toBe(400);
  });

  it('a concurrent declaration that loses the account slot answers 409 concurrent_declaration_update', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    const client = await pool.connect();
    try {
      // Deterministic race: hold an uncommitted current declaration for the
      // account, so the API request's insert must block on the partial
      // unique index behind it, then commits into the 23505 violation.
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO eligibility.jurisdiction_declarations
           (id, account_id, country_code, subdivision_code, source, review_state,
            effective_from, superseded_at, version, created_at)
         VALUES ($1, $2, 'US', NULL, 'self_declared', 'accepted',
                 now(), NULL, 1, now())`,
        [randomUUID(), accountId],
      );
      const pending = putJson(
        baseUrl,
        '/v1/eligibility/jurisdiction',
        { country_code: 'GB' },
        cookie,
      );
      await waitForBlockedInsert(pool, 'jurisdiction_declarations');
      await client.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; message: string };
      expect(body).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'concurrent_declaration_update',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // The loser left nothing behind: the winning row is the only one.
    const { rows } = await pool.query<{ n: string; current: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE superseded_at IS NULL)::text AS current
       FROM eligibility.jurisdiction_declarations WHERE account_id = $1`,
      [accountId],
    );
    expect(rows[0]?.current).toBe('1');
    expect(rows[0]?.n).toBe('1');
  });
});

describe('GET /v1/eligibility/status', () => {
  it('returns all-null for an account with nothing declared', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    const response = await getJson(baseUrl, '/v1/eligibility/status', cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jurisdiction: null,
      active_policy: null,
      age: null,
    });
  });

  it('assembles the declared jurisdiction and the active synthetic policy', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, cookie);
    const response = await getJson(baseUrl, '/v1/eligibility/status', cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      jurisdiction: { declaration_id: string; country_code: string };
      active_policy: {
        policy_id: string;
        jurisdiction_key: string;
        revision: number;
        effective_until: string;
        timezone: string;
      };
      age: unknown;
    };
    expect(body.jurisdiction?.country_code).toBe('US');
    expect(body.jurisdiction?.declaration_id).toMatch(UUID_V4);
    expect(body.active_policy).toMatchObject({
      policy_id: '11e2e6ce-6b8e-4b1a-9f3a-8c9d1e2f3a4b',
      jurisdiction_key: 'US',
      revision: 1,
      effective_until: OPEN_ENDED,
      timezone: 'America/New_York',
    });
    expect(body.age).toBeNull();
    void accountId;
  });

  it('leaves active_policy null for a jurisdiction without an approved policy', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'XZ' }, cookie);
    const response = await getJson(baseUrl, '/v1/eligibility/status', cookie);
    const body = (await response.json()) as { active_policy: unknown };
    expect(body.active_policy).toBeNull();
  });

  it('is session-scoped: account B data never appears in account A status', async () => {
    const a = await registerAndLogin(baseUrl, freshEmail());
    const b = await registerAndLogin(baseUrl, freshEmail());
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'DE' }, b.cookie);

    const statusA = (await getJson(baseUrl, '/v1/eligibility/status', a.cookie).then((r) =>
      r.json(),
    )) as { jurisdiction: { country_code: string } | null };
    expect(statusA.jurisdiction).toBeNull();

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM eligibility.jurisdiction_declarations WHERE account_id = $1`,
      [b.accountId],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(statusA)).not.toContain(rows[0]?.id);
  });
});
