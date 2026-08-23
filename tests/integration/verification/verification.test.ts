import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv, type AppConfig } from '@wai/config';
import {
  canonicalJsonHash,
  createDb,
  createEligibilityRepositories,
  createPool,
  MigrationRunner,
  PgAccountRepository,
  PgVerificationRepository,
  type Db,
  type EligibilityRepositories,
} from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { AgeCredentialService } from '../../../apps/api/src/eligibility/services/age-credential.service.js';
import { createBirthdayCipher } from '../../../apps/api/src/eligibility/infra/eligibility-secret-cipher.js';
import { SystemElgClock } from '../../../apps/api/src/eligibility/infra/elg-clock.js';
import { PgJurisdictionPolicySelector } from '../../../apps/api/src/eligibility/infra/pg-jurisdiction-policy-selector.js';
import { MockIdentityVerificationProvider } from '../../../apps/api/src/verification/provider/mock-provider.js';
import { CommunityAccessService } from '../../../apps/api/src/verification/community-access.service.js';
import { VerificationService } from '../../../apps/api/src/verification/verification.service.js';
import { VerificationWebhookService } from '../../../apps/api/src/verification/verification-webhook.service.js';

declare const WAI_MIGRATIONS_DIR: string;

const ACCOUNT_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const SECOND_ACCOUNT_ID = 'eeeeeeee-0000-4000-8000-000000000002';
const THIRD_ACCOUNT_ID = 'eeeeeeee-0000-4000-8000-000000000003';
const FOURTH_ACCOUNT_ID = 'eeeeeeee-0000-4000-8000-000000000004';
const ELG_POLICY_ID = 'eeeeeeee-1000-4000-8000-000000000001';
const MEMBER_POLICY_ID = 'eeeeeeee-2000-4000-8000-000000000001';
const BIRTH_DATE = '2000-03-14';
const PROVIDER_SECRET = 'verification-integration-secret-32-bytes-minimum';

let started: StartedInfra;
let pool: Pool;
let db: Db;
let repo: PgVerificationRepository;
let eligibility: EligibilityRepositories;
let config: AppConfig;

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  db = createDb(pool);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR).up();
  repo = new PgVerificationRepository(pool);
  eligibility = createEligibilityRepositories(db);
  config = loadEnv({ NODE_ENV: 'test', DATABASE_URL: started.infra.databaseUrl });
  await insertAccount(ACCOUNT_ID, 'verification-test-1');
  await insertAccount(SECOND_ACCOUNT_ID, 'verification-test-2');
  await insertAccount(THIRD_ACCOUNT_ID, 'verification-test-3');
  await insertAccount(FOURTH_ACCOUNT_ID, 'verification-test-4');
  await seedEligibilityPolicy();
  await eligibility.jurisdictionDeclarations.upsertCurrent({
    id: 'eeeeeeee-3000-4000-8000-000000000001',
    accountId: ACCOUNT_ID,
    countryCode: 'US',
    subdivisionCode: null,
    now: new Date(),
  });
  await eligibility.jurisdictionDeclarations.upsertCurrent({
    id: 'eeeeeeee-3000-4000-8000-000000000004',
    accountId: FOURTH_ACCOUNT_ID,
    countryCode: 'US',
    subdivisionCode: null,
    now: new Date(),
  });
  await eligibility.jurisdictionDeclarations.upsertCurrent({
    id: 'eeeeeeee-3000-4000-8000-000000000003',
    accountId: THIRD_ACCOUNT_ID,
    countryCode: 'US',
    subdivisionCode: null,
    now: new Date(),
  });
  await eligibility.jurisdictionDeclarations.upsertCurrent({
    id: 'eeeeeeee-3000-4000-8000-000000000002',
    accountId: SECOND_ACCOUNT_ID,
    countryCode: 'US',
    subdivisionCode: null,
    now: new Date(),
  });
  await pool.query(
    `INSERT INTO verification.membership_policies
       (id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,
        effective_from,effective_until,created_at)
     VALUES ($1,1,'approved',$2,'synthetic:test','reviewer',now(),
             '2026-01-01T00:00:00Z','2028-01-01T00:00:00Z',now())`,
    [MEMBER_POLICY_ID, 'a'.repeat(64)],
  );
});

afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('VER-01 PostgreSQL event ownership', () => {
  it('signed_provider_event_is_idempotent_and_order_safe', async () => {
    const now = new Date();
    const first = await repo.claimProviderEvent(
      'mock',
      'evt-lease',
      'a'.repeat(64),
      now,
      now,
      60_000,
    );
    expect(first.outcome).toBe('claimed');
    if (!('processingToken' in first)) throw new Error('missing first token');

    const concurrent = await repo.claimProviderEvent(
      'mock',
      'evt-lease',
      'a'.repeat(64),
      now,
      now,
      60_000,
    );
    expect(concurrent.outcome).toBe('in_progress');

    const reclaimedAt = new Date(now.getTime() + 61_000);
    const reclaimed = await repo.claimProviderEvent(
      'mock',
      'evt-lease',
      'a'.repeat(64),
      now,
      reclaimedAt,
      60_000,
    );
    expect(reclaimed.outcome).toBe('retry_claimed');
    if (!('processingToken' in reclaimed)) throw new Error('missing reclaimed token');
    expect(
      await repo.completeProviderEvent('mock', 'evt-lease', first.processingToken, 'processed'),
    ).toBe(false);
    expect(
      await repo.completeProviderEvent('mock', 'evt-lease', reclaimed.processingToken, 'processed'),
    ).toBe(true);
    expect(
      (await repo.claimProviderEvent('mock', 'evt-lease', 'a'.repeat(64), now, reclaimedAt))
        .outcome,
    ).toBe('processed');
    expect(
      (await repo.claimProviderEvent('mock', 'evt-lease', 'b'.repeat(64), now, reclaimedAt))
        .outcome,
    ).toBe('conflict');
    // Conflict is terminal; replaying the original bytes cannot reopen it.
    expect(
      (await repo.claimProviderEvent('mock', 'evt-lease', 'a'.repeat(64), now, reclaimedAt))
        .outcome,
    ).toBe('conflict');
  });

  it('allows exactly one concurrent owner', async () => {
    const now = new Date();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        repo.claimProviderEvent('mock', 'evt-concurrent', 'c'.repeat(64), now, now),
      ),
    );
    expect(results.filter((value) => value.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((value) => value.outcome === 'in_progress')).toHaveLength(3);
  });

  it('keeps failed work retryable without acknowledging it as processed', async () => {
    const now = new Date();
    const claim = await repo.claimProviderEvent(
      'mock',
      'evt-retry-delay',
      'd'.repeat(64),
      now,
      now,
    );
    if (!('processingToken' in claim)) throw new Error('missing retry token');
    expect(
      await repo.failProviderEvent(
        'mock',
        'evt-retry-delay',
        claim.processingToken,
        'provider_event_processing_failed',
        now,
      ),
    ).toBe(true);
    expect(
      (
        await repo.claimProviderEvent(
          'mock',
          'evt-retry-delay',
          'd'.repeat(64),
          now,
          new Date(now.getTime() + 1_000),
        )
      ).outcome,
    ).toBe('retry_later');
    expect(
      (
        await repo.claimProviderEvent(
          'mock',
          'evt-retry-delay',
          'd'.repeat(64),
          now,
          new Date(now.getTime() + 31_000),
        )
      ).outcome,
    ).toBe('retry_claimed');
  });

  it('keeps approved membership policy revisions immutable and reproducible', async () => {
    const policyId = 'eeeeeeee-2000-4000-8000-000000000099';
    await pool.query(
      `INSERT INTO verification.membership_policies
         (id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,
          effective_from,effective_until,created_at)
       VALUES ($1,1,'approved',$2,'synthetic:test','reviewer',now(),
               '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',now())`,
      [policyId, '9'.repeat(64)],
    );
    await expect(
      pool.query(
        `UPDATE verification.membership_policies SET content_hash=$2
          WHERE id=$1 AND revision=1`,
        [policyId, '8'.repeat(64)],
      ),
    ).rejects.toThrow(/immutable/);
    await pool.query(
      `UPDATE verification.membership_policies SET status='retired'
        WHERE id=$1 AND revision=1`,
      [policyId],
    );
    await pool.query(
      `INSERT INTO verification.membership_policies
         (id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,
          effective_from,effective_until,created_at)
       VALUES ($1,2,'approved',$2,'synthetic:test:v2','reviewer',now(),
               '2027-01-01T00:00:00Z','2028-01-01T00:00:00Z',now())`,
      [policyId, '7'.repeat(64)],
    );
    const revisions = await pool.query<{ revision: number; status: string }>(
      `SELECT revision,status FROM verification.membership_policies
        WHERE id=$1 ORDER BY revision`,
      [policyId],
    );
    expect(revisions.rows).toEqual([
      { revision: 1, status: 'retired' },
      { revision: 2, status: 'approved' },
    ]);
  });
});

describe('VER-01 provider -> identity -> Eligibility -> membership', () => {
  it('external_age_attestation_is_issued_without_persisting_plaintext_dob', async () => {
    const { provider, verification, webhook, age, access } = services();
    const created = await verification.createIdentitySession(
      ACCOUNT_ID,
      'provider-flow-idempotency-key',
    );
    expect(created.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.session_id).not.toContain('mock_session');
    const providerSessionReference = `mock_session_${created.session_id}`;
    const occurredAt = new Date().toISOString();
    const raw = Buffer.from(
      JSON.stringify({
        provider_event_id: 'evt-full-chain-verified',
        provider_session_reference: providerSessionReference,
        event_type: 'session.verified',
        occurred_at: occurredAt,
        decision: 'verified',
        identity_confirmed: true,
        liveness_result: 'passed',
        verified_birth_date: BIRTH_DATE,
        age_thresholds_met: [13, 18],
        provider_subject_reference: 'provider-subject-one',
        assurance_expires_at: '2027-08-18T00:00:00Z',
      }),
    );
    const signature = provider.sign(raw);
    await expect(
      webhook.handle(
        'mock',
        { 'x-verification-signature': signature },
        Buffer.from(`${raw.toString('utf8')} `),
      ),
    ).rejects.toThrow('provider_signature_invalid');

    await expect(
      webhook.handle('mock', { 'x-verification-signature': signature }, raw),
    ).resolves.toEqual({ accepted: true, replay: false });
    await expect(
      webhook.handle('mock', { 'x-verification-signature': signature }, raw),
    ).resolves.toEqual({ accepted: true, replay: true });

    const status = await verification.status(ACCOUNT_ID);
    expect(status).toMatchObject({
      identity: 'verified',
      age_assurance: 'attested',
      membership: 'not_applied',
    });
    const credential = await age.current(ACCOUNT_ID);
    expect(credential).toMatchObject({ assurance_level: 'externally_attested', age_band: 'adult' });
    expect((await access.decide(ACCOUNT_ID, 'friends')).decision).toBe('limited');

    await verification.applyMembership(ACCOUNT_ID, MEMBER_POLICY_ID, 1, 'community_participation');
    expect((await verification.status(ACCOUNT_ID)).membership).toBe('submitted');
    expect((await access.decide(ACCOUNT_ID, 'friends')).decision).toBe('limited');
    const membership = await pool.query<{ id: string }>(
      `SELECT id FROM verification.membership_cases WHERE account_id=$1`,
      [ACCOUNT_ID],
    );
    await verification.review({
      caseId: membership.rows[0]!.id,
      reviewerPrincipal: 'operator:test',
      decision: 'approved',
      reasonCode: 'POLICY_REQUIREMENTS_MET',
    });
    expect((await access.decide(ACCOUNT_ID, 'friends')).decision).toBe('eligible');

    // A later-delivered but older terminal event is ignored and cannot revoke
    // or create another external credential.
    const olderRaw = Buffer.from(
      JSON.stringify({
        provider_event_id: 'evt-full-chain-older-failed',
        provider_session_reference: providerSessionReference,
        event_type: 'session.failed',
        occurred_at: new Date(new Date(occurredAt).getTime() - 60_000).toISOString(),
        decision: 'failed',
        identity_confirmed: false,
        liveness_result: 'failed',
        age_thresholds_met: [],
      }),
    );
    await webhook.handle('mock', { 'x-verification-signature': provider.sign(olderRaw) }, olderRaw);
    expect((await verification.status(ACCOUNT_ID)).identity).toBe('verified');
    expect((await age.current(ACCOUNT_ID))?.credential_id).toBe(credential?.credential_id);

    const verificationDump = await dumpSchema('verification');
    const eligibilityDump = await dumpSchema('eligibility');
    expect(`${verificationDump}\n${eligibilityDump}`).not.toContain(BIRTH_DATE);
    expect(verificationDump).not.toContain('provider-subject-one');
    expect(verificationDump).not.toContain(providerSessionReference);
    expect(verificationDump).not.toContain(created.client_token ?? 'unreachable-client-token');
  });

  it('provider_verified_does_not_auto_approve_membership and appeal is durable', async () => {
    const { provider, verification, webhook } = services();
    const created = await verification.createIdentitySession(
      SECOND_ACCOUNT_ID,
      'second-provider-flow-key',
    );
    const raw = Buffer.from(
      JSON.stringify({
        provider_event_id: 'evt-second-verified',
        provider_session_reference: `mock_session_${created.session_id}`,
        event_type: 'session.verified',
        occurred_at: new Date().toISOString(),
        decision: 'verified',
        identity_confirmed: true,
        liveness_result: 'passed',
        verified_birth_date: '1999-11-20',
        age_thresholds_met: [18],
        provider_subject_reference: 'provider-subject-two',
        assurance_expires_at: '2027-08-18T00:00:00Z',
      }),
    );
    await webhook.handle('mock', { 'x-verification-signature': provider.sign(raw) }, raw);
    expect((await verification.status(SECOND_ACCOUNT_ID)).membership).toBe('not_applied');

    await verification.applyMembership(SECOND_ACCOUNT_ID, MEMBER_POLICY_ID, 1, 'safety_commitment');
    const membership = await pool.query<{ id: string }>(
      `SELECT id FROM verification.membership_cases WHERE account_id=$1`,
      [SECOND_ACCOUNT_ID],
    );
    await verification.review({
      caseId: membership.rows[0]!.id,
      reviewerPrincipal: 'operator:test',
      decision: 'rejected',
      reasonCode: 'INSUFFICIENT_EVIDENCE',
    });
    await Promise.all([
      verification.appeal(SECOND_ACCOUNT_ID, 'new_information', 'private appeal statement'),
      verification.appeal(SECOND_ACCOUNT_ID, 'new_information', 'private appeal statement'),
    ]);
    expect((await verification.status(SECOND_ACCOUNT_ID)).appeal).toBe('submitted');
    const appeal = await pool.query<{ id: string }>(
      `SELECT id FROM verification.membership_appeals WHERE membership_case_id=$1`,
      [membership.rows[0]!.id],
    );
    await verification.reviewAppeal({
      appealId: appeal.rows[0]!.id,
      reviewerPrincipal: 'operator:appeal',
      decision: 'overturned',
      reasonCode: 'NEW_INFORMATION_ACCEPTED',
    });
    expect(await verification.status(SECOND_ACCOUNT_ID)).toMatchObject({
      membership: 'approved',
      appeal: 'overturned',
    });
    const dump = await dumpSchema('verification');
    expect(dump).not.toContain('private appeal statement');

    await Promise.all([
      verification.requestRedaction(SECOND_ACCOUNT_ID),
      verification.requestRedaction(SECOND_ACCOUNT_ID),
    ]);
    const redactions = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM verification.redaction_requests WHERE account_id=$1`,
      [SECOND_ACCOUNT_ID],
    );
    expect(redactions.rows[0]?.count).toBe('1');

    await pool.query(
      `UPDATE verification.redaction_requests
          SET state='held', legal_hold=true
        WHERE account_id=$1`,
      [SECOND_ACCOUNT_ID],
    );
    await verification.requestRedaction(SECOND_ACCOUNT_ID);
    const holdAudit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM verification.audit_events
        WHERE account_id=$1 AND event_type='privacy.redaction_blocked_by_legal_hold'
          AND reason_code='LEGAL_HOLD_ACTIVE'`,
      [SECOND_ACCOUNT_ID],
    );
    expect(holdAudit.rows[0]?.count).toBe('1');
  });

  it('subject collision enters needs_review without auto-punishment', async () => {
    const { provider, verification, webhook, age } = services();
    const created = await verification.createIdentitySession(
      THIRD_ACCOUNT_ID,
      'third-provider-flow-key',
    );
    const raw = Buffer.from(
      JSON.stringify({
        provider_event_id: 'evt-third-subject-collision',
        provider_session_reference: `mock_session_${created.session_id}`,
        event_type: 'session.verified',
        occurred_at: new Date().toISOString(),
        decision: 'verified',
        identity_confirmed: true,
        liveness_result: 'passed',
        verified_birth_date: '1998-01-01',
        age_thresholds_met: [18],
        // Already bound to ACCOUNT_ID by the first full-chain test.
        provider_subject_reference: 'provider-subject-one',
        assurance_expires_at: '2027-08-18T00:00:00Z',
      }),
    );
    await webhook.handle('mock', { 'x-verification-signature': provider.sign(raw) }, raw);
    expect(await verification.status(THIRD_ACCOUNT_ID)).toMatchObject({
      identity: 'needs_review',
      age_assurance: 'needs_review',
      membership: 'not_applied',
    });
    await expect(age.current(THIRD_ACCOUNT_ID)).resolves.toBeNull();
    const account = await pool.query<{ state: string }>(
      `SELECT state FROM iam.accounts WHERE id=$1`,
      [THIRD_ACCOUNT_ID],
    );
    expect(account.rows[0]?.state).toBe('enabled');
  });

  it('does not publish attested state when Eligibility issuance fails', async () => {
    const provider = new MockIdentityVerificationProvider({ secret: PROVIDER_SECRET });
    const verification = new VerificationService(provider, pool, config);
    const webhook = new VerificationWebhookService(provider, pool, config, {
      async issueExternalAttestation(): Promise<never> {
        throw new Error('unsafe 1997-02-03 provider detail');
      },
    });
    const created = await verification.createIdentitySession(
      FOURTH_ACCOUNT_ID,
      'fourth-provider-flow-key',
    );
    const raw = Buffer.from(
      JSON.stringify({
        provider_event_id: 'evt-age-issuer-failure',
        provider_session_reference: `mock_session_${created.session_id}`,
        event_type: 'session.verified',
        occurred_at: new Date().toISOString(),
        decision: 'verified',
        identity_confirmed: true,
        liveness_result: 'passed',
        verified_birth_date: '1997-02-03',
        age_thresholds_met: [18],
        assurance_expires_at: '2027-08-18T00:00:00Z',
      }),
    );
    await expect(
      webhook.handle('mock', { 'x-verification-signature': provider.sign(raw) }, raw),
    ).rejects.toThrow();
    expect(await verification.status(FOURTH_ACCOUNT_ID)).toMatchObject({
      identity: 'pending',
      age_assurance: 'pending',
    });
    const event = await pool.query<{ status: string; last_error_safe: string }>(
      `SELECT status,last_error_safe FROM verification.provider_events
        WHERE provider_event_id='evt-age-issuer-failure'`,
    );
    expect(event.rows[0]).toEqual({
      status: 'retryable',
      last_error_safe: 'provider_event_processing_failed',
    });
    expect(JSON.stringify(event.rows[0])).not.toContain('1997-02-03');
  });
});

function services(): {
  provider: MockIdentityVerificationProvider;
  verification: VerificationService;
  webhook: VerificationWebhookService;
  age: AgeCredentialService;
  access: CommunityAccessService;
} {
  const provider = new MockIdentityVerificationProvider({ secret: PROVIDER_SECRET });
  const selector = new PgJurisdictionPolicySelector(
    eligibility.jurisdictionDeclarations,
    eligibility.jurisdictionPolicies,
  );
  const age = new AgeCredentialService(
    {
      jurisdictionDeclarations: eligibility.jurisdictionDeclarations,
      ageEvidence: eligibility.ageEvidence,
      ageCredentials: eligibility.ageCredentials,
    },
    selector,
    createBirthdayCipher(config.iam.piiKeysJson, config.iam.piiKeyId),
    new SystemElgClock(),
  );
  const verification = new VerificationService(provider, pool, config);
  const webhook = new VerificationWebhookService(provider, pool, config, age);
  const access = new CommunityAccessService(verification, age, new PgAccountRepository(db));
  return { provider, verification, webhook, age, access };
}

async function insertAccount(id: string, digest: string): Promise<void> {
  await pool.query(
    `INSERT INTO iam.accounts
       (id,email_digest,email_ciphertext,email_nonce,email_key_id,state,state_reason,
        state_actor_type,state_changed_at,created_at,updated_at)
     VALUES ($1,$2,'cipher','nonce','key','enabled','registered','system',now(),now(),now())`,
    [id, digest],
  );
}

async function seedEligibilityPolicy(): Promise<void> {
  const modes = ['friends', 'activities', 'professional', 'circles', 'events', 'dating'];
  const document = {
    policy_id: ELG_POLICY_ID,
    revision: 1,
    minimum_account_age: 13,
    age_of_majority: 18,
    digital_consent_age: 16,
    parental_consent_required_below: 16,
    youth_launch_state: 'launched',
    allowed_cohorts: ['adult'],
    cross_cohort_contact_policy: 'same_cohort_only',
    mode_rules: {
      mode_enabled: Object.fromEntries(modes.map((mode) => [mode, true])),
      platform_minimum_age_by_mode: Object.fromEntries(
        modes.map((mode) => [mode, mode === 'dating' ? 18 : 13]),
      ),
      mode_minimum_age: Object.fromEntries(modes.map((mode) => [mode, 0])),
      required_age_assurance_by_mode: Object.fromEntries(
        modes.map((mode) => [mode, mode === 'dating' ? 'externally_attested' : 'self_declared']),
      ),
    },
  };
  await eligibility.jurisdictionPolicies.insert({
    id: ELG_POLICY_ID,
    jurisdictionKey: 'US',
    revision: 1,
    status: 'approved',
    content: document,
    contentHash: canonicalJsonHash(document),
    ruleHash: canonicalJsonHash({
      minimum_account_age: document.minimum_account_age,
      age_of_majority: document.age_of_majority,
      digital_consent_age: document.digital_consent_age,
      parental_consent_required_below: document.parental_consent_required_below,
      youth_launch_state: document.youth_launch_state,
      allowed_cohorts: document.allowed_cohorts,
      cross_cohort_contact_policy: document.cross_cohort_contact_policy,
      mode_rules: document.mode_rules,
    }),
    locationPrecisionPolicy: 'country_and_subdivision',
    profilingPolicy: 'derived_facts_only',
    retentionPolicy: 'credential_until_superseded',
    legalBasisRefs: ['synthetic:test'],
    reviewedBy: 'integration-reviewer',
    reviewedAt: new Date('2026-01-01T00:00:00Z'),
    timezone: 'UTC',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveUntil: new Date('2028-01-01T00:00:00Z'),
    isSynthetic: true,
    now: new Date(),
  });
}

async function dumpSchema(schema: 'verification' | 'eligibility'): Promise<string> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name`,
    [schema],
  );
  const parts: string[] = [];
  for (const table of tables.rows) {
    const values = await pool.query<{ json: string }>(
      `SELECT to_json(t)::text AS json FROM ${schema}."${table.table_name}" t`,
    );
    parts.push(...values.rows.map((value) => value.json));
  }
  return parts.join('\n');
}
