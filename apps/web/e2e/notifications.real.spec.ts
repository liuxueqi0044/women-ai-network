import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPool, PgLetterRepository, PgNotificationRepository } from '@wai/db';

const apiOrigin = () => process.env['WAI_E2E_API_URL'] ?? 'http://127.0.0.1:3187';
const webOrigin = () =>
  process.env['WAI_E2E_WEB_ORIGIN'] ??
  `http://127.0.0.1:${process.env['WAI_E2E_WEB_PORT'] ?? '3188'}`;
async function signIn(page: Page) {
  const email = `ntf-real-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const password = 'correct horse battery staple';
  const registration = await page.request.post(`${apiOrigin()}/v1/account/registrations`, {
    data: { email, password },
  });
  expect(registration.ok()).toBeTruthy();
  const accountId = ((await registration.json()) as { account_id: string }).account_id;
  const reporterEmail = `ntf-reporter-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const reporterRegistration = await page.request.post(`${apiOrigin()}/v1/account/registrations`, {
    data: { email: reporterEmail, password },
  });
  expect(reporterRegistration.ok()).toBeTruthy();
  const reporterId = ((await reporterRegistration.json()) as { account_id: string }).account_id;
  const login = await page.request.post(`${apiOrigin()}/v1/account/sessions`, {
    data: { email, password },
  });
  expect(login.ok()).toBeTruthy();
  const raw =
    login
      .headersArray()
      .find((h) => h.name.toLowerCase() === 'set-cookie')
      ?.value.match(/(wai_session(?:_dev)?=[^;]+)/)?.[1] ?? '';
  const [name, value] = raw.split('=');
  await page
    .context()
    .addCookies([
      { name: name ?? 'wai_session_dev', value: value ?? '', domain: '127.0.0.1', path: '/' },
    ]);
  return { accountId, reporterId };
}

async function seedTrustedNotifications(accountId: string, reporterId: string) {
  const pool = createPool(
    process.env['DATABASE_URL'] ?? 'postgres://wai_dev:wai_dev_pg_8f3k@127.0.0.1:5433/wai_dev',
  );
  const account = { id: accountId };
  const actionId = randomUUID();
  const caseId = randomUUID();
  const reportId = randomUUID();
  const now = new Date();
  const reportIdempotency = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
  const reportRequest = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
  const identityId = randomUUID();
  const policyId = randomUUID();
  const membershipPolicyId = randomUUID();
  const membershipCaseId = randomUUID();
  const evidenceId = randomUUID();
  const credentialId = randomUUID();
  const modeId = randomUUID();
  const partitionId = randomUUID();
  const reporterIdentityId = randomUUID();
  const reporterMembershipCaseId = randomUUID();
  const reporterEvidenceId = randomUUID();
  const reporterCredentialId = randomUUID();
  const reporterModeId = randomUUID();
  const reporterPartitionId = randomUUID();
  const policyHash = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.eligibility_policy_publish','true',true)");
    await client.query(
      `INSERT INTO eligibility.jurisdiction_policies
       (id,jurisdiction_key,revision,status,content,content_hash,rule_hash,location_precision_policy,profiling_policy,retention_policy,legal_basis_refs,reviewed_by,reviewed_at,timezone,effective_from,effective_until,created_at)
       VALUES($1,$4,1,'approved','{}',$2,$2,'country_only','derived_facts_only','e2e',ARRAY['e2e'], 'e2e',$3,'UTC',$3,'infinity',$3)`,
      [policyId, policyHash, now, `US-E${account.id.slice(0, 2).toUpperCase()}`],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await pool.query(
    `INSERT INTO verification.identity_cases(id,account_id,state,age_assurance_state,version,created_at,updated_at,verified_at)
     VALUES($1,$2,'verified','attested',1,$3,$3,$3)`,
    [identityId, account.id, now],
  );
  await pool.query(
    `INSERT INTO verification.membership_policies(id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,effective_from,effective_until,created_at)
     VALUES($1,1,'approved',$2,'e2e','e2e',$3,$3,'infinity',$3)`,
    [membershipPolicyId, policyHash, now],
  );
  await pool.query(
    `INSERT INTO verification.membership_cases(id,account_id,policy_id,policy_revision,policy_content_hash,statement_category,consented_at,state,version,decided_at,created_at,updated_at)
     VALUES($1,$2,$3,1,$4,'community_participation',$5,'approved',1,$5,$5,$5)`,
    [membershipCaseId, account.id, membershipPolicyId, policyHash, now],
  );
  await pool.query(
    `INSERT INTO eligibility.age_evidence(id,account_id,birthday_digest,birthday_ciphertext,birthday_nonce,birthday_key_id,source,declared_at,created_at,verification_case_id,external_attestation_digest)
     VALUES($1,$2,$3,'cipher','nonce','e2e','verification_provider',$4,$4,$5,$6)`,
    [evidenceId, account.id, '1'.repeat(64), now, identityId, '2'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO eligibility.age_credentials(id,account_id,age_band,cohort_key,assurance_level,issuer_type,source_evidence_id,jurisdiction_policy_id,policy_revision,valid_from,valid_until,derived_at,derivation_version,created_at)
     VALUES($1,$2,'adult','adult','externally_attested','verification_module',$3,$4,1,$5,'infinity',$5,1,$5)`,
    [credentialId, account.id, evidenceId, policyId, now],
  );
  await pool.query(
    `INSERT INTO eligibility.mode_decisions(decision_id,account_id,scope,mode,decision,age_band,cohort_key,assurance_level,reason_codes,policy_id,policy_revision,policy_hash,credential_id,credential_hash,input_hash,evaluated_at,valid_until,engine_version,created_at)
     VALUES($1,$2,'age_and_jurisdiction','friends','allow','adult','adult','externally_attested','{}',$3,1,$4,$5,$6,$7,$8,'infinity',1,$8)`,
    [modeId, account.id, policyId, policyHash, credentialId, '3'.repeat(64), '4'.repeat(64), now],
  );
  await pool.query(
    `INSERT INTO eligibility.partition_decisions(decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at)
     VALUES($1,$2,$2,'adult','adult','adult','adult','discover','allow','{}',$3,$3,1,1,$4,$4,$5,$6,1,$6)`,
    [partitionId, account.id, policyId, policyHash, '5'.repeat(64), now],
  );
  await pool.query(
    `INSERT INTO verification.identity_cases(id,account_id,state,age_assurance_state,version,created_at,updated_at,verified_at)
     VALUES($1,$2,'verified','attested',1,$3,$3,$3)`,
    [reporterIdentityId, reporterId, now],
  );
  await pool.query(
    `INSERT INTO verification.membership_cases(id,account_id,policy_id,policy_revision,policy_content_hash,statement_category,consented_at,state,version,decided_at,created_at,updated_at)
     VALUES($1,$2,$3,1,$4,'community_participation',$5,'approved',1,$5,$5,$5)`,
    [reporterMembershipCaseId, reporterId, membershipPolicyId, policyHash, now],
  );
  await pool.query(
    `INSERT INTO eligibility.age_evidence(id,account_id,birthday_digest,birthday_ciphertext,birthday_nonce,birthday_key_id,source,declared_at,created_at,verification_case_id,external_attestation_digest)
     VALUES($1,$2,$3,'cipher','nonce','e2e','verification_provider',$4,$4,$5,$6)`,
    [reporterEvidenceId, reporterId, '6'.repeat(64), now, reporterIdentityId, '7'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO eligibility.age_credentials(id,account_id,age_band,cohort_key,assurance_level,issuer_type,source_evidence_id,jurisdiction_policy_id,policy_revision,valid_from,valid_until,derived_at,derivation_version,created_at)
     VALUES($1,$2,'adult','adult','externally_attested','verification_module',$3,$4,1,$5,'infinity',$5,1,$5)`,
    [reporterCredentialId, reporterId, reporterEvidenceId, policyId, now],
  );
  await pool.query(
    `INSERT INTO eligibility.mode_decisions(decision_id,account_id,scope,mode,decision,age_band,cohort_key,assurance_level,reason_codes,policy_id,policy_revision,policy_hash,credential_id,credential_hash,input_hash,evaluated_at,valid_until,engine_version,created_at)
     VALUES($1,$2,'age_and_jurisdiction','friends','allow','adult','adult','externally_attested','{}',$3,1,$4,$5,$6,$7,$8,'infinity',1,$8)`,
    [
      reporterModeId,
      reporterId,
      policyId,
      policyHash,
      reporterCredentialId,
      '8'.repeat(64),
      '9'.repeat(64),
      now,
    ],
  );
  await pool.query(
    `INSERT INTO eligibility.partition_decisions(decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at)
     VALUES($1,$2,$3,'adult','adult','adult','adult','discover','allow','{}',$4,$4,1,1,$5,$5,$6,$7,1,$7)`,
    [reporterPartitionId, reporterId, account.id, policyId, policyHash, 'a'.repeat(64), now],
  );
  // The separately registered reporter is explicitly passed into this fixture,
  // keeping the safety resource self-contained and fully seeded.
  const letters = new PgLetterRepository(pool, {
    keyId: 'test-key',
    key: Buffer.alloc(32, 7),
    hmacKey: Buffer.alloc(32, 8),
  });
  const draft = await letters.create({
    ownerId: account.id,
    kind: 'public_letter',
    content: {
      title: 'Fixture title',
      body: { paragraphs: ['Fixture body'] },
      locale: 'en',
      country_code: 'US',
      topics: ['friendship'],
      content_reminder: 'none',
      pen_name: 'Fixture',
    },
    idempotencyKey: `notification-e2e-letter-create-${randomUUID()}`,
  });
  const published = await letters.publish({
    ownerId: account.id,
    letterId: draft.id,
    expectedVersion: 1,
    idempotencyKey: `notification-e2e-letter-publish-${randomUUID()}`,
  });
  const letterId = published.id;
  await pool.query(
    `INSERT INTO safety.reports(id,reporter_account_id,subject_account_id,target_type,target_id,category,idempotency_digest,request_digest,state,created_at,updated_at)
     VALUES($1,$2,$6::uuid,'account',$7::text,'other',$3,$4,'resolved',$5,$5)`,
    [reportId, reporterId, reportIdempotency, reportRequest, now, account.id, account.id],
  );
  await pool.query(
    `INSERT INTO safety.cases(id,report_id,severity,queue,state,version,created_at,updated_at)
     VALUES($1,$2,'high','notifications','resolved',0,$3,$3)`,
    [caseId, reportId, now],
  );
  await pool.query(
    `INSERT INTO safety.actions(id,case_id,action_type,state,proposer_id,approver_id,reason_code,created_at,updated_at)
     VALUES($1,$2,'temporary_restriction','approved','system','system-approver','POLICY_VIOLATION_CONFIRMED',$3,$3)`,
    [actionId, caseId, now],
  );
  const repo = new PgNotificationRepository(pool, Buffer.from('notification-e2e-key'));
  await repo.ingest({
    request: {
      recipient_account_id: account.id,
      resource_kind: 'letter',
      resource_id: letterId,
      event: { event_key: 'letter.received', event_version: 1, parameters: { source: 'member' } },
      idempotency_key: `notification-e2e-letter-${randomUUID()}`,
    },
    requestDigest: '1'.repeat(64),
    now,
  });
  const critical = await repo.ingest({
    request: {
      recipient_account_id: account.id,
      resource_kind: 'safety_action',
      resource_id: actionId,
      event: {
        event_key: 'safety.action_required',
        event_version: 1,
        parameters: { action: 'review' },
      },
      idempotency_key: `notification-e2e-critical-${randomUUID()}`,
    },
    requestDigest: '2'.repeat(64),
    now,
  });
  const deadline = Date.now() + 20_000;
  let retained = false;
  while (Date.now() < deadline) {
    const row = (
      await pool.query<{ state: string; lease_fence: number; attempt_count: number }>(
        `SELECT state,lease_fence,attempt_count FROM notifications.provider_intents
         WHERE notification_id=$1 AND channel='email'`,
        [critical.record.id],
      )
    ).rows[0];
    if (row?.state === 'retained') {
      expect(row.lease_fence).toBeGreaterThanOrEqual(1);
      expect(row.attempt_count).toBe(0);
      retained = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(retained).toBe(true);
  const fenceBefore = (
    await pool.query<{ lease_fence: number }>(
      `SELECT lease_fence FROM notifications.provider_intents WHERE notification_id=$1 AND channel='email'`,
      [critical.record.id],
    )
  ).rows[0]?.lease_fence;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const fenceAfter = (
    await pool.query<{ lease_fence: number }>(
      `SELECT lease_fence FROM notifications.provider_intents WHERE notification_id=$1 AND channel='email'`,
      [critical.record.id],
    )
  ).rows[0]?.lease_fence;
  expect(fenceAfter).toBe(fenceBefore);
  await pool.end();
  return { accountId: account.id, criticalId: critical.record.id };
}

test('real authenticated list/unread/read-all/preferences path has no private preview', async ({
  page,
}) => {
  const { accountId, reporterId } = await signIn(page);
  const fixture = await seedTrustedNotifications(accountId, reporterId);
  const firstPage = await page.request.get(`${apiOrigin()}/v1/notifications?limit=1`);
  expect(firstPage.status()).toBe(200);
  const firstBody = (await firstPage.json()) as {
    items: Array<{ id: string }>;
    next_cursor: string | null;
  };
  expect(firstBody.items).toHaveLength(1);
  expect(firstBody.next_cursor).toBeTruthy();
  const secondPage = await page.request.get(
    `${apiOrigin()}/v1/notifications?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`,
  );
  expect(secondPage.status()).toBe(200);
  expect(((await secondPage.json()) as { items: unknown[] }).items).toHaveLength(1);
  const lettersPage = await page.request.get(
    `${apiOrigin()}/v1/notifications?limit=1&category=letters`,
  );
  expect(lettersPage.status()).toBe(200);
  const lettersBody = (await lettersPage.json()) as {
    items: Array<{ category: string }>;
    next_cursor: string | null;
  };
  expect(lettersBody.items).toHaveLength(1);
  expect(lettersBody.items[0]?.category).toBe('letters');
  expect(lettersBody.next_cursor).toBeNull();
  const mismatchedCursor = await page.request.get(
    `${apiOrigin()}/v1/notifications?limit=1&category=events&cursor=${encodeURIComponent(lettersBody.next_cursor ?? firstBody.next_cursor ?? '')}`,
  );
  expect(mismatchedCursor.status()).toBe(400);
  const unread = await page.request.get(`${apiOrigin()}/v1/notifications/unread-count`);
  expect(unread.status()).toBe(200);
  expect((await unread.json()).unread_count).toBeGreaterThanOrEqual(2);
  const prefs = await page.request.get(`${apiOrigin()}/v1/notifications/preferences`);
  expect(prefs.status()).toBe(200);
  const preferenceBody = (await prefs.json()) as {
    version: number;
    items: Array<Record<string, unknown>>;
  };
  expect(preferenceBody.items).toHaveLength(21);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark all read' })).toBeVisible();
  await expect(page.getByText('You received a letter')).toBeVisible();
  await expect(page.getByText(/Unread: [12]/)).toBeVisible();
  await page.getByRole('combobox').selectOption('letters');
  await expect(page.getByText('You received a letter')).toBeVisible();
  await expect(page.getByText('A safety action needs your attention')).toHaveCount(0);
  await page.getByRole('combobox').selectOption('all');
  await page.getByRole('button', { name: 'Mark read' }).first().click();
  await expect(page.getByText(/Unread: 1/)).toBeVisible();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByText(/Unread: 0/)).toBeVisible();
  const persisted = await page.request.get(`${apiOrigin()}/v1/notifications/unread-count`);
  expect((await persisted.json()).unread_count).toBe(0);
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Offline recovery mode')).toBeVisible();
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(/Unread: 0/)).toBeVisible();
  const changedPreferences = {
    expected_version: preferenceBody.version,
    items: preferenceBody.items.map((item, index) => {
      const { critical_safety_exception: _criticalSafetyException, ...requestItem } = item;
      return index === 0 ? { ...requestItem, enabled: !requestItem['enabled'] } : requestItem;
    }),
  };
  const savedPreferences = await page.request.put(`${apiOrigin()}/v1/notifications/preferences`, {
    headers: { origin: webOrigin(), 'idempotency-key': `e2e-pref-${randomUUID()}` },
    data: changedPreferences,
  });
  expect(savedPreferences.status()).toBe(200);
  const stalePreferences = await page.request.put(`${apiOrigin()}/v1/notifications/preferences`, {
    headers: {
      origin: webOrigin(),
      'idempotency-key': `e2e-pref-stale-${randomUUID()}`,
    },
    data: changedPreferences,
  });
  expect(stalePreferences.status()).toBe(409);
  expect(fixture.criticalId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.locator('body')).not.toContainText(/private text|message body|onboarding/i);
});
