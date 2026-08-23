import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { aesGcmDecrypt, hmacDigest, parsePiiKeys } from '@wai/db';
import { OPEN_ENDED } from '@wai/contracts';
import type { AppConfig } from '@wai/config';
import type { StartedInfra } from '@wai/testkit';
import { BIRTHDAY_HMAC_CONTEXT } from '../../../apps/api/src/eligibility/infra/eligibility-secret-cipher.js';
import {
  getJson,
  putJson,
  registerAndLogin,
  startEligibilityHarness,
  stopEligibilityHarness,
  waitForBlockedInsert,
  type ApiApp,
} from './helpers.js';

/**
 * CP4 evidence over real Postgres: the age declaration vertical (task book
 * §6). Real policy selection from the seeded synthetic row, real AES-256-GCM
 * encryption into age_evidence (independently decryptable only with the PII
 * key), Temporal-based band/cohort derivation in the policy timezone, the
 * replacement credential chain, and the concurrent 409 race. The birth date
 * never appears in any response.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let started: StartedInfra;
let pool: Pool;
let config: AppConfig;
let baseUrl: string;
let api: ApiApp;
let emailSeq = 0;

beforeAll(async () => {
  const harness = await startEligibilityHarness();
  started = harness.started;
  pool = harness.pool;
  config = harness.config;
  baseUrl = harness.baseUrl;
  api = harness.api;
}, 180_000);

afterAll(async () => {
  await stopEligibilityHarness({ api, started, pool });
});

function freshEmail(): string {
  emailSeq += 1;
  return `age-credential-${emailSeq}@example.invalid`;
}

/** Always in the future in every IANA timezone, however the test is run. */
function futureDateIso(): string {
  return new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function declareJurisdiction(cookie: string): Promise<void> {
  const response = await putJson(
    baseUrl,
    '/v1/eligibility/jurisdiction',
    { country_code: 'US' },
    cookie,
  );
  expect(response.status).toBe(200);
}

interface CredentialRow {
  id: string;
  age_band: string;
  cohort_key: string;
  assurance_level: string;
  issuer_type: string;
  policy_revision: number;
  valid_until: string;
  superseded_at: string | null;
}

async function credentialRows(accountId: string): Promise<CredentialRow[]> {
  const { rows } = await pool.query<CredentialRow>(
    `SELECT id, age_band, cohort_key, assurance_level, issuer_type,
            policy_revision, valid_until::text AS valid_until, superseded_at
     FROM eligibility.age_credentials WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

describe('PUT /v1/eligibility/age-declaration — preconditions', () => {
  it('requires a jurisdiction declaration first (400 jurisdiction_required)', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    const response = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: '2000-06-15' },
      cookie,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'jurisdiction_required',
    });
  });

  it('requires an active approved policy (400 no_active_jurisdiction_policy)', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    const declared = await putJson(
      baseUrl,
      '/v1/eligibility/jurisdiction',
      { country_code: 'XZ' },
      cookie,
    );
    expect(declared.status).toBe(200);
    const response = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: '2000-06-15' },
      cookie,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe('no_active_jurisdiction_policy');
  });

  it('rejects non-date and out-of-range birth dates at the DTO (400)', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    await declareJurisdiction(cookie);
    for (const birthDate of ['15/06/2000', '2000-13-01', '1899-12-31', 'not-a-date']) {
      const response = await putJson(
        baseUrl,
        '/v1/eligibility/age-declaration',
        { birth_date: birthDate },
        cookie,
      );
      expect(response.status, birthDate).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects a clearly future birth date in the selected policy timezone (400)', async () => {
    const { cookie } = await registerAndLogin(baseUrl, freshEmail());
    await declareJurisdiction(cookie);
    // The DTO checks calendar shape only. The service owns the contextual
    // upper bound after selecting the policy timezone.
    const response = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: futureDateIso() },
      cookie,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe('birth_date_in_future');
  });
});

describe('PUT /v1/eligibility/age-declaration — derive and store', () => {
  it('issues an adult credential; evidence is encrypted with the real PII key', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    await declareJurisdiction(cookie);
    const birthDate = '2000-06-15';
    const response = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: birthDate },
      cookie,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      credential_id: string;
      age_band: string;
      cohort_key: string;
      assurance_level: string;
      valid_until: string;
    };
    expect(body.credential_id).toMatch(UUID_V4);
    expect(body.age_band).toBe('adult');
    expect(body.cohort_key).toBe('adult');
    expect(body.assurance_level).toBe('self_declared');
    expect(body.valid_until).not.toBe(OPEN_ENDED);
    // The response never echoes the birth date.
    expect(JSON.stringify(body)).not.toContain(birthDate);

    // Evidence: keyed digest + AES-256-GCM ciphertext under the active key.
    const key = parsePiiKeys(config.iam.piiKeysJson).get(config.iam.piiKeyId);
    expect(key).toBeDefined();
    const evidence = await pool.query<{
      id: string;
      birthday_digest: string;
      birthday_ciphertext: string;
      birthday_nonce: string;
      birthday_key_id: string;
    }>(
      `SELECT id, birthday_digest, birthday_ciphertext, birthday_nonce, birthday_key_id
       FROM eligibility.age_evidence WHERE account_id = $1`,
      [accountId],
    );
    const evidenceRow = evidence.rows[0];
    expect(evidenceRow).toBeDefined();
    expect(evidenceRow?.birthday_digest).toBe(hmacDigest(key!, BIRTHDAY_HMAC_CONTEXT, birthDate));
    expect(evidenceRow?.birthday_key_id).toBe('dev-key');
    expect(evidenceRow?.birthday_ciphertext).not.toContain(birthDate);
    // The ciphertext round-trips ONLY with the key: decrypt recovers the date.
    expect(
      aesGcmDecrypt(key!, {
        ciphertext: evidenceRow?.birthday_ciphertext ?? '',
        nonce: evidenceRow?.birthday_nonce ?? '',
      }),
    ).toBe(birthDate);

    // Credential: derived facts + policy anchor + next birthday validity.
    const rows = await credentialRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      age_band: 'adult',
      cohort_key: 'adult',
      assurance_level: 'self_declared',
      issuer_type: 'eligibility_self_declaration',
      policy_revision: 1,
      superseded_at: null,
    });
    expect(new Date(rows[0]?.valid_until ?? '').toISOString()).toBe(body.valid_until);
    expect(rows[0]?.id).toBe(body.credential_id);
  });

  it('derives youth and below_minimum bands for younger birthdays', async () => {
    const cases: Array<{ birthDate: string; band: string; cohort: string }> = [
      { birthDate: '2011-06-15', band: 'youth', cohort: 'youth_15' },
      { birthDate: '2015-06-15', band: 'below_minimum', cohort: 'below_minimum' },
    ];
    for (const c of cases) {
      const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
      await declareJurisdiction(cookie);
      const response = await putJson(
        baseUrl,
        '/v1/eligibility/age-declaration',
        { birth_date: c.birthDate },
        cookie,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { age_band: string; cohort_key: string };
      expect(body.age_band).toBe(c.band);
      expect(body.cohort_key).toBe(c.cohort);
      const rows = await credentialRows(accountId);
      expect(rows[0]?.age_band).toBe(c.band);
    }
  });

  it('is idempotent: the same birth date re-issues the same credential', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    await declareJurisdiction(cookie);
    const first = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: '2000-06-15' },
      cookie,
    );
    const second = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: '2000-06-15' },
      cookie,
    );
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { credential_id: string };
    const secondBody = (await second.json()) as { credential_id: string };
    expect(secondBody.credential_id).toBe(firstBody.credential_id);
    const rows = await credentialRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.superseded_at).toBeNull();
  });

  it('supersedes the credential when the declared birth date changes', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    await declareJurisdiction(cookie);
    await putJson(baseUrl, '/v1/eligibility/age-declaration', { birth_date: '2000-06-15' }, cookie);
    const changed = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: '2011-06-15' },
      cookie,
    );
    expect(changed.status).toBe(200);
    const changedBody = (await changed.json()) as { age_band: string };
    expect(changedBody.age_band).toBe('youth');

    const rows = await credentialRows(accountId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.superseded_at).not.toBeNull();
    expect(rows[1]?.superseded_at).toBeNull();
    expect(rows[1]?.age_band).toBe('youth');
    // History keeps the derived facts only — no birth date anywhere.
    expect(JSON.stringify(rows)).not.toContain('2000-06-15');
    expect(JSON.stringify(rows)).not.toContain('2011-06-15');
  });

  it('a concurrent declaration that loses the account slot answers 409 concurrent_age_declaration_update', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    await declareJurisdiction(cookie);
    const client = await pool.connect();
    try {
      // Deterministic race: hold an uncommitted current age_evidence row, so
      // the API request's evidence insert must block on the partial unique
      // index behind it, then commits into the 23505 violation.
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO eligibility.age_evidence
           (id, account_id, birthday_digest, birthday_ciphertext, birthday_nonce,
            birthday_key_id, source, declared_at, superseded_at, created_at)
         VALUES ($1, $2, $3, 'ciphertext', 'nonce', 'dev-key',
                 'self_declared', now(), NULL, now())`,
        [randomUUID(), accountId, 'a'.repeat(64)],
      );
      const pending = putJson(
        baseUrl,
        '/v1/eligibility/age-declaration',
        { birth_date: '2000-06-15' },
        cookie,
      );
      await waitForBlockedInsert(pool, 'age_evidence');
      await client.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string; message: string };
      expect(body).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'concurrent_age_declaration_update',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // The loser left nothing behind: the winning evidence row is the only
    // one and no credential was ever issued from the failed transaction.
    const evidence = await pool.query<{ n: string; current: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE superseded_at IS NULL)::text AS current
       FROM eligibility.age_evidence WHERE account_id = $1`,
      [accountId],
    );
    expect(evidence.rows[0]?.current).toBe('1');
    expect(evidence.rows[0]?.n).toBe('1');
    const credentials = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM eligibility.age_credentials WHERE account_id = $1`,
      [accountId],
    );
    expect(credentials.rows[0]?.n).toBe('0');
  });
});

describe('GET /v1/eligibility/status — age block', () => {
  it('reports credential facts (never the birth date) until the next birthday boundary', async () => {
    const { accountId, cookie } = await registerAndLogin(baseUrl, freshEmail());
    await declareJurisdiction(cookie);
    await putJson(baseUrl, '/v1/eligibility/age-declaration', { birth_date: '2000-06-15' }, cookie);
    const response = await getJson(baseUrl, '/v1/eligibility/status', cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      age: {
        credential_id: string;
        age_band: string;
        cohort_key: string;
        assurance_level: string;
        valid_from: string;
        valid_until: string;
      };
    };
    expect(body.age).toMatchObject({
      age_band: 'adult',
      cohort_key: 'adult',
      assurance_level: 'self_declared',
    });
    expect(body.age?.valid_until).not.toBe(OPEN_ENDED);
    expect(body.age?.credential_id).toMatch(UUID_V4);
    expect(body.age?.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(body)).not.toContain('2000-06-15');

    const rows = await credentialRows(accountId);
    expect(body.age?.credential_id).toBe(rows[0]?.id);
  });
});
