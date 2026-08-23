import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { AppConfig } from '@wai/config';
import { hmacDigest, parsePiiKeys } from '@wai/db';
import type { StartedInfra, StartedOpa } from '@wai/testkit';
import { PartitionDecisionService } from '../../../apps/api/src/eligibility/services/partition-decision.service.js';
import { BIRTHDAY_HMAC_CONTEXT } from '../../../apps/api/src/eligibility/infra/eligibility-secret-cipher.js';
import { capturingLogger, type CollectingStream } from '../helpers.js';
import {
  getJson,
  postJson,
  putJson,
  registerAndLogin,
  startEligibilityHarness,
  stopEligibilityHarness,
  type ApiApp,
} from './helpers.js';

/**
 * CP4/CP5 privacy evidence: the exact birth date exists ONLY as AES-256-GCM
 * ciphertext + keyed digest — never plaintext. Verified three ways: (1) no
 * eligibility column is shaped to hold a plaintext birthday, (2) the full
 * HTTP vertical (including a CP5 mode evaluation against the real engine)
 * with a capturing logger emits no birth date / email / password / token in
 * any log line, (3) a JSON dump of every eligibility table contains only
 * derived facts plus randomized ciphertext — and two accounts declaring the
 * SAME birthday get different ciphertexts (no equality leakage) with the
 * same digest (idempotency still works).
 */

const BIRTH_DATE = '2011-06-15';
const EMAIL = 'privacy@example.invalid';

let started: StartedInfra;
let pool: Pool;
let config: AppConfig;
let baseUrl: string;
let api: ApiApp;
let opa: StartedOpa | undefined;
let capturedStream: CollectingStream;

beforeAll(async () => {
  const captured = capturingLogger('wai-api');
  capturedStream = captured.stream;
  const harness = await startEligibilityHarness({ logger: captured.logger, opa: true });
  started = harness.started;
  pool = harness.pool;
  config = harness.config;
  baseUrl = harness.baseUrl;
  api = harness.api;
  opa = harness.opa;
}, 180_000);

afterAll(async () => {
  await stopEligibilityHarness({ api, started, pool, ...(opa === undefined ? {} : { opa }) });
});

async function eligibilityTextDump(): Promise<string> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'eligibility' ORDER BY table_name`,
  );
  const parts: string[] = [];
  for (const table of rows.map((row) => row.table_name)) {
    const { rows: rowsOfTable } = await pool.query(
      `SELECT to_json(t)::text AS json FROM eligibility."${table}" t`,
    );
    parts.push(...rowsOfTable.map((row) => row.json as string));
  }
  return parts.join('\n');
}

describe('the eligibility schema cannot hold a plaintext birthday', () => {
  it('no column name anywhere in the schema looks like a date-of-birth', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'eligibility' ORDER BY table_name, ordinal_position`,
    );
    const suspicious = rows.filter((row) =>
      /birth[_-]?date|date[_-]?of[_-]?birth|^dob$/i.test(row.column_name),
    );
    expect(suspicious).toEqual([]);
    const birthdayColumns = rows.filter(
      (row) => row.table_name === 'age_evidence' && row.column_name.startsWith('birthday'),
    );
    expect(birthdayColumns.map((row) => row.column_name)).toEqual([
      'birthday_digest',
      'birthday_ciphertext',
      'birthday_nonce',
      'birthday_key_id',
    ]);
  });

  it('the full vertical leaves no plaintext birthday anywhere: DB dump, responses, logs', async () => {
    const { cookie } = await registerAndLogin(baseUrl, EMAIL);
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, cookie);
    const declaration = await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: BIRTH_DATE },
      cookie,
    );
    expect(declaration.status).toBe(200);
    // Read each body exactly once (a Response body cannot be read twice).
    const declarationText = await declaration.text();
    const declarationBody = JSON.parse(declarationText) as { age_band: string; cohort_key: string };
    expect(declarationBody.cohort_key).toBe('youth_15');
    const status = await getJson(baseUrl, '/v1/eligibility/status', cookie);
    expect(status.status).toBe(200);
    const statusText = await status.text();

    // The birth date is absent from every HTTP response on the wire.
    for (const text of [declarationText, statusText]) {
      expect(text).not.toContain(BIRTH_DATE);
    }

    // ... from every eligibility table (derived facts + ciphertext only) ...
    const dump = await eligibilityTextDump();
    expect(dump).not.toContain(BIRTH_DATE);
    expect(dump).toContain('youth_15');
    expect(dump).toContain('birthday_ciphertext');

    // ... and from every log line the API emitted.
    const logDump = capturedStream.lines.map((line) => JSON.stringify(line)).join('\n');
    expect(logDump).not.toContain(BIRTH_DATE);
    expect(logDump).not.toContain(EMAIL);
    expect(logDump).not.toContain('correct horse battery staple');
  });

  it('the stored evidence is digest + randomized ciphertext under the active key', async () => {
    const { accountId, cookie } = await registerAndLogin(
      baseUrl,
      'privacy-evidence@example.invalid',
    );
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, cookie);
    await putJson(baseUrl, '/v1/eligibility/age-declaration', { birth_date: BIRTH_DATE }, cookie);
    const { rows } = await pool.query<{
      birthday_digest: string;
      birthday_ciphertext: string;
      birthday_nonce: string;
      birthday_key_id: string;
    }>(
      `SELECT birthday_digest, birthday_ciphertext, birthday_nonce, birthday_key_id
       FROM eligibility.age_evidence WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    const key = parsePiiKeys(config.iam.piiKeysJson).get(config.iam.piiKeyId);
    expect(row?.birthday_digest).toBe(hmacDigest(key!, BIRTHDAY_HMAC_CONTEXT, BIRTH_DATE));
    expect(row?.birthday_key_id).toBe(config.iam.piiKeyId);
    expect(row?.birthday_ciphertext).not.toContain(BIRTH_DATE);
    expect(row?.birthday_nonce).not.toContain(BIRTH_DATE);
  });

  it('a mode evaluation leaves no birthday in the response, the decision snapshot or the logs', async () => {
    const { cookie } = await registerAndLogin(baseUrl, 'privacy-mode@example.invalid');
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, cookie);
    await putJson(baseUrl, '/v1/eligibility/age-declaration', { birth_date: BIRTH_DATE }, cookie);
    const evaluation = await postJson(
      baseUrl,
      '/v1/eligibility/mode-evaluations',
      // 15 on the current date: below the parental-consent line — the deny
      // response must be just as birthday-free as an allow.
      { mode: 'friends' },
      cookie,
    );
    expect(evaluation.status).toBe(200);
    const text = await evaluation.text();
    expect(text).not.toContain(BIRTH_DATE);

    // The immutable snapshot in mode_decisions carries derived facts only.
    const snapshot = await pool.query<{ json: string }>(
      `SELECT to_json(t)::text AS json FROM eligibility.mode_decisions t`,
    );
    const snapshotDump = snapshot.rows.map((row) => row.json).join('\n');
    expect(snapshotDump).not.toContain(BIRTH_DATE);
    expect(snapshotDump).toContain('youth_15');

    // The full table dump and every log line stay clean.
    const dump = await eligibilityTextDump();
    expect(dump).not.toContain(BIRTH_DATE);
    const logDump = capturedStream.lines.map((line) => JSON.stringify(line)).join('\n');
    expect(logDump).not.toContain(BIRTH_DATE);
  });

  it('a partition decision leaves no birthday of either party in the view, snapshot or logs', async () => {
    const actor = await registerAndLogin(baseUrl, 'privacy-partition-actor@example.invalid');
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, actor.cookie);
    await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: '1996-06-15' },
      actor.cookie,
    );
    const subject = await registerAndLogin(baseUrl, 'privacy-partition-subject@example.invalid');
    await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, subject.cookie);
    await putJson(
      baseUrl,
      '/v1/eligibility/age-declaration',
      { birth_date: BIRTH_DATE },
      subject.cookie,
    );

    const view = await api
      .get(PartitionDecisionService)
      .decide(actor.accountId, subject.accountId, {
        capability: 'discover',
        effective_at: new Date().toISOString(),
      });
    const viewText = JSON.stringify(view);
    expect(viewText).not.toContain(BIRTH_DATE);
    expect(viewText).not.toContain('1996-06-15');
    expect(view.subject_cohort_key).toBe('youth_15');

    // The immutable snapshot carries derived cohort facts for BOTH parties.
    const snapshot = await pool.query<{ json: string }>(
      `SELECT to_json(t)::text AS json FROM eligibility.partition_decisions t`,
    );
    const snapshotDump = snapshot.rows.map((row) => row.json).join('\n');
    expect(snapshotDump).not.toContain(BIRTH_DATE);
    expect(snapshotDump).not.toContain('1996-06-15');
    expect(snapshotDump).toContain('youth_15');

    const dump = await eligibilityTextDump();
    expect(dump).not.toContain(BIRTH_DATE);
    expect(dump).not.toContain('1996-06-15');

    const logDump = capturedStream.lines.map((line) => JSON.stringify(line)).join('\n');
    expect(logDump).not.toContain(BIRTH_DATE);
    expect(logDump).not.toContain('1996-06-15');
  });

  it('same birthday across accounts: equal digests, DIFFERENT ciphertexts', async () => {
    const digests: string[] = [];
    const ciphertexts: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const email = `privacy-same-birthday-${i}@example.invalid`;
      const { accountId, cookie } = await registerAndLogin(baseUrl, email);
      await putJson(baseUrl, '/v1/eligibility/jurisdiction', { country_code: 'US' }, cookie);
      await putJson(baseUrl, '/v1/eligibility/age-declaration', { birth_date: BIRTH_DATE }, cookie);
      const { rows } = await pool.query<{
        birthday_digest: string;
        birthday_ciphertext: string;
      }>(
        `SELECT birthday_digest, birthday_ciphertext FROM eligibility.age_evidence
         WHERE account_id = $1`,
        [accountId],
      );
      digests.push(rows[0]?.birthday_digest ?? '');
      ciphertexts.push(rows[0]?.birthday_ciphertext ?? '');
    }
    // Deterministic keyed digest: same birthday is detectable (idempotency).
    expect(digests[0]).toBe(digests[1]);
    // Randomized AES-256-GCM: the stored ciphertexts never reveal equality.
    expect(ciphertexts[0]).not.toBe(ciphertexts[1]);
  });
});
