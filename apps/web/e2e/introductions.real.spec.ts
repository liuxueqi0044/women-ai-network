import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { aesGcmEncrypt, canonicalJsonHash, createPool } from '@wai/db';

const apiOrigin = () => process.env['WAI_E2E_API_URL'] ?? 'http://127.0.0.1:3187';
const piiKey = Buffer.from('dUnDePcXXLNeIe+ZDKq3MveXGJ611HjLHRIDvYlNcHM=', 'base64');
const modes = ['friends', 'activities', 'professional', 'circles', 'events', 'dating'];

async function register(request: APIRequestContext, email: string) {
  const response = await request.post(`${apiOrigin()}/v1/account/registrations`, {
    data: { email, password: 'correct horse battery staple' },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { account_id: string }).account_id;
}

async function login(request: APIRequestContext, email: string) {
  const response = await request.post(`${apiOrigin()}/v1/account/sessions`, {
    data: { email, password: 'correct horse battery staple' },
  });
  expect(response.status()).toBe(201);
  return response
    .headersArray()
    .find((header) => header.name.toLowerCase() === 'set-cookie')
    ?.value.match(/(wai_session(?:_dev)?=[^;]+)/)?.[1];
}

async function seedEligiblePair(
  actor: string,
  first: string,
  second: string,
  jurisdiction: 'US' | 'CA',
  matchValue: string,
) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('real browser fixture requires DATABASE_URL');
  const pool = createPool(databaseUrl);
  const now = new Date();
  const policyId = randomUUID();
  const policy = {
    policy_id: policyId,
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
      platform_minimum_age_by_mode: Object.fromEntries(modes.map((mode) => [mode, 13])),
      mode_minimum_age: Object.fromEntries(modes.map((mode) => [mode, 0])),
      required_age_assurance_by_mode: Object.fromEntries(
        modes.map((mode) => [mode, 'self_declared']),
      ),
    },
  };
  const policyHash = canonicalJsonHash(policy);
  const ruleHash = canonicalJsonHash({
    minimum_account_age: policy.minimum_account_age,
    age_of_majority: policy.age_of_majority,
    digital_consent_age: policy.digital_consent_age,
    parental_consent_required_below: policy.parental_consent_required_below,
    youth_launch_state: policy.youth_launch_state,
    allowed_cohorts: policy.allowed_cohorts,
    cross_cohort_contact_policy: policy.cross_cohort_contact_policy,
    mode_rules: policy.mode_rules,
  });
  const membershipPolicy = randomUUID();
  const membershipHash = canonicalJsonHash({ membershipPolicy });
  const accounts = [actor, first, second];
  const identityCases = accounts.map(() => randomUUID());
  const evidence = accounts.map(() => randomUUID());
  const credentials = accounts.map(() => randomUUID());
  const profiles = accounts.map(() => randomUUID());
  const names = ['Alpha Fixture', 'Beta Fixture', 'Gamma Fixture'];
  try {
    await pool.query('BEGIN');
    await pool.query(`SELECT set_config('app.eligibility_policy_publish','true',true)`);
    await pool.query(
      `INSERT INTO eligibility.jurisdiction_policies
       (id,jurisdiction_key,revision,status,content,content_hash,rule_hash,location_precision_policy,profiling_policy,retention_policy,legal_basis_refs,reviewed_by,reviewed_at,timezone,effective_from,effective_until,is_synthetic,created_at)
       VALUES ($1,$6,1,'approved',$2,$3,$7,'country_only','derived_facts_only','credential_until_superseded',$4,'browser-fixture',$5,'UTC',$5,'infinity',true,$5)`,
      [policyId, JSON.stringify(policy), policyHash, ['browser:test'], now, jurisdiction, ruleHash],
    );
    await pool.query('COMMIT');
    await pool.query(
      `INSERT INTO verification.membership_policies
       (id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,effective_from,effective_until,created_at)
       VALUES ($1,1,'approved',$2,'browser:test','browser-fixture',$3,$3,'infinity',$3)`,
      [membershipPolicy, membershipHash, now],
    );
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index]!;
      const identity = identityCases[index]!;
      const evidenceId = evidence[index]!;
      const credential = credentials[index]!;
      const profile = profiles[index]!;
      const birthday = aesGcmEncrypt(piiKey, '1990-01-01');
      await pool.query(
        `INSERT INTO verification.identity_cases(id,account_id,state,age_assurance_state,version,created_at,updated_at,verified_at)
         VALUES ($1,$2,'verified','attested',1,$3,$3,$3)`,
        [identity, account, now],
      );
      await pool.query(
        `INSERT INTO verification.identity_bindings(id,provider,subject_digest,account_id,state,created_at)
         VALUES ($1,'browser-fixture',$2,$3,'active',$4)`,
        [randomUUID(), canonicalJsonHash(account), account, now],
      );
      await pool.query(
        `INSERT INTO eligibility.jurisdiction_declarations(id,account_id,country_code,source,review_state,effective_from,version,created_at)
         VALUES ($1,$2,$3,'self_declared','accepted',$4,1,$4)`,
        [randomUUID(), account, jurisdiction, now],
      );
      await pool.query(
        `INSERT INTO eligibility.age_evidence(id,account_id,birthday_digest,birthday_ciphertext,birthday_nonce,birthday_key_id,source,declared_at,created_at,verification_case_id,external_attestation_digest)
         VALUES ($1,$2,$3,$4,$5,'dev-key','verification_provider',$6,$6,$7,$8)`,
        [
          evidenceId,
          account,
          'c'.repeat(64),
          birthday.ciphertext,
          birthday.nonce,
          now,
          identity,
          'd'.repeat(64),
        ],
      );
      await pool.query(
        `INSERT INTO eligibility.age_credentials(id,account_id,age_band,cohort_key,assurance_level,issuer_type,source_evidence_id,jurisdiction_policy_id,jurisdiction_key,policy_revision,valid_from,valid_until,derived_at,derivation_version,created_at)
         VALUES ($1,$2,'adult','adult','externally_attested','verification_module',$3,$4,$5,1,$6,'infinity',$6,1,$6)`,
        [credential, account, evidenceId, policyId, jurisdiction, now],
      );
      await pool.query(
        `INSERT INTO eligibility.mode_decisions
         (decision_id,account_id,scope,mode,decision,age_band,cohort_key,assurance_level,reason_codes,policy_id,policy_revision,policy_hash,credential_id,credential_hash,input_hash,evaluated_at,valid_until,engine_version,created_at)
         SELECT gen_random_uuid(),$1,'age_and_jurisdiction',mode,'allow','adult','adult','externally_attested','{}',$2,1,$3,$4,$5,$5,$6,'infinity',1,$6 FROM unnest($7::text[]) mode`,
        [account, policyId, policyHash, credential, 'e'.repeat(64), now, modes],
      );
      await pool.query(
        `INSERT INTO verification.membership_cases
         (id,account_id,policy_id,policy_revision,policy_content_hash,statement_category,consented_at,state,version,decided_at,created_at,updated_at)
         VALUES ($1,$2,$3,1,$4,'community_participation',$5,'approved',1,$5,$5,$5)`,
        [randomUUID(), account, membershipPolicy, membershipHash, now],
      );
      await pool.query(
        `INSERT INTO profile.profiles(id,account_id,display_name,state,version,created_at,updated_at)
         VALUES ($1,$2,$3,'active',0,$4,$4)`,
        [profile, account, names[index], now],
      );
      await pool.query(
        `INSERT INTO profile.profile_facts(id,profile_id,fact_key,state,source,value_json,confirmed_at,version)
         VALUES ($1,$2,'interests','confirmed','user_confirmed',$4::jsonb,$3,0)`,
        [randomUUID(), profile, now, JSON.stringify(matchValue)],
      );
      await pool.query(
        `INSERT INTO profile.fact_uses(profile_id,fact_key,mode,matching_enabled,updated_at)
         SELECT $1,'interests',mode,true,$2 FROM unnest($3::text[]) mode`,
        [profile, now, modes],
      );
      await pool.query(
        `INSERT INTO profile.fact_audiences(profile_id,fact_key,mode,audience,age_partition,updated_at)
         SELECT $1,'interests',mode,'verified_members','adult',$2 FROM unnest($3::text[]) mode`,
        [profile, now, modes],
      );
      const encrypted = aesGcmEncrypt(
        piiKey,
        JSON.stringify([
          {
            mode: 'friends',
            criterion: 'shared_interests',
            strength: 'strong_preference',
            value: matchValue,
            deal_breaker: true,
          },
        ]),
      );
      await pool.query(
        `INSERT INTO onboarding.preference_sets(id,account_id,purpose,version,current,modes,modes_version,normalized_json,preferences_ciphertext,preferences_nonce,preferences_key_id,confirmed_at,source)
         VALUES ($1,$2,'discovery',1,true,ARRAY['friends'],1,$3,$4,$5,'dev-key',$6,'manual')`,
        [
          randomUUID(),
          account,
          JSON.stringify([
            {
              mode: 'friends',
              criterion: 'shared_interests',
              strength: 'strong_preference',
              deal_breaker: true,
            },
          ]),
          encrypted.ciphertext,
          encrypted.nonce,
          now,
        ],
      );
    }
  } finally {
    await pool.end();
  }
}

async function installCookie(page: Page, cookie: string) {
  const [name, value] = cookie.split('=');
  if (!name || !value) throw new Error('session cookie is malformed');
  await page.context().addCookies([{ name, value, domain: '127.0.0.1', path: '/' }]);
}

test('real eligible cards support cursor, pass, interested and mutual outcome', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const suffix = randomUUID();
  const actorEmail = `mch-browser-a-${suffix}@example.invalid`;
  const firstEmail = `mch-browser-b-${suffix}@example.invalid`;
  const secondEmail = `mch-browser-c-${suffix}@example.invalid`;
  const actor = await register(request, actorEmail);
  const first = await register(request, firstEmail);
  const second = await register(request, secondEmail);
  await seedEligiblePair(
    actor,
    first,
    second,
    test.info().project.name === 'introductions-mobile' ? 'CA' : 'US',
    `browser-${suffix}`,
  );
  const actorCookie = await login(request, actorEmail);
  const firstCookie = await login(request, firstEmail);
  expect(actorCookie).toBeTruthy();
  expect(firstCookie).toBeTruthy();
  await installCookie(page, actorCookie!);

  const seededBatch = await request.get(`${apiOrigin()}/v1/introductions?mode=friends&limit=2`, {
    headers: { cookie: actorCookie! },
  });
  expect(seededBatch.status()).toBe(200);
  const seededPayload = (await seededBatch.json()) as {
    batch_id: string;
    candidates: Array<{ id: string; subject: { display_name: string } }>;
    next_cursor: string | null;
  };
  if (seededPayload.candidates.length === 0) {
    const [eligibility, verification] = await Promise.all([
      request.get(`${apiOrigin()}/v1/eligibility/status`, { headers: { cookie: actorCookie! } }),
      request.get(`${apiOrigin()}/v1/verification/status`, { headers: { cookie: actorCookie! } }),
    ]);
    throw new Error(
      `fixture gate denied: eligibility=${await eligibility.text()} verification=${await verification.text()}`,
    );
  }
  expect(seededPayload.candidates.map((item) => item.subject.display_name).sort()).toEqual([
    'Beta Fixture',
    'Gamma Fixture',
  ]);
  const firstPage = await request.get(`${apiOrigin()}/v1/introductions?mode=friends&limit=1`, {
    headers: { cookie: actorCookie! },
  });
  expect(firstPage.status()).toBe(200);
  const firstPayload = (await firstPage.json()) as {
    batch_id: string;
    candidates: Array<{ id: string; subject: { display_name: string } }>;
    next_cursor: string | null;
  };
  expect(firstPayload.candidates).toHaveLength(1);
  expect(firstPayload.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const secondPage = await request.get(
    `${apiOrigin()}/v1/introductions?mode=friends&limit=1&cursor=${encodeURIComponent(firstPayload.next_cursor!)}`,
    { headers: { cookie: actorCookie! } },
  );
  expect(secondPage.status()).toBe(200);
  expect(['Beta Fixture', 'Gamma Fixture']).toContain(
    (await secondPage.json()).candidates[0].subject.display_name,
  );

  await page.goto('/introductions');
  await expect(page.getByRole('heading', { name: 'Beta Fixture' })).toBeVisible();
  await expect(page.getByText('Gamma Fixture')).toBeVisible();
  await page
    .locator('article')
    .filter({ hasText: 'Beta Fixture' })
    .getByRole('button', { name: 'Interested' })
    .click();
  await expect(page.getByRole('status')).toContainText('Saved');
  const firstList = await request.get(`${apiOrigin()}/v1/introductions?mode=friends`, {
    headers: { cookie: firstCookie! },
  });
  expect(firstList.status()).toBe(200);
  const firstListPayload = (await firstList.json()) as {
    batch_id: string;
    candidates: Array<{ id: string; subject: { display_name: string } }>;
  };
  const reciprocal = firstListPayload.candidates.find(
    (candidate) => candidate.subject.display_name === 'Alpha Fixture',
  );
  expect(reciprocal).toBeTruthy();
  const mutual = await request.post(
    `${apiOrigin()}/v1/introductions/${reciprocal!.id}/interested`,
    {
      headers: {
        cookie: firstCookie!,
        origin: process.env['WAI_E2E_WEB_ORIGIN'] ?? 'http://127.0.0.1:3188',
        'idempotency-key': randomUUID(),
      },
      data: { batch_id: firstListPayload.batch_id },
    },
  );
  const mutualBody = await mutual.text();
  expect(mutual.status(), mutualBody).toBe(200);
  expect(JSON.parse(mutualBody).outcome).toBe('mutual');
  await page.getByRole('button', { name: 'Refresh batch' }).click();
  await expect(page.getByText('Mutual interest')).toBeVisible();
  await page
    .locator('article')
    .filter({ hasText: 'Gamma Fixture' })
    .getByRole('button', { name: 'Pass' })
    .click();
  await expect(page.getByRole('status')).toContainText('Saved');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);

  // Launch UAT: continue the same real two-member journey through the
  // materialized connection into the production messaging API and UI. This
  // intentionally does not use Playwright route mocks.
  const pool = createPool(process.env['DATABASE_URL']!);
  const accepted = (
    await pool.query<{ id: string; version: number }>(
      `SELECT id,version FROM connection.connections
       WHERE state='accepted'
         AND ((requester_account_id=$1 AND recipient_account_id=$2)
           OR (requester_account_id=$2 AND recipient_account_id=$1))
       ORDER BY updated_at DESC LIMIT 1`,
      [actor, first],
    )
  ).rows[0];
  await pool.end();
  expect(accepted).toBeTruthy();
  const conversationResponse = await request.post(`${apiOrigin()}/v1/conversations`, {
    headers: {
      cookie: actorCookie!,
      origin: process.env['WAI_E2E_WEB_ORIGIN'] ?? 'http://127.0.0.1:3188',
    },
    data: { connection_id: accepted!.id, connection_epoch: accepted!.version },
  });
  const conversationText = await conversationResponse.text();
  expect(conversationResponse.status(), conversationText).toBe(201);
  const conversation = JSON.parse(conversationText) as { id: string };
  const launchMessage = `Real launch message ${suffix}`;
  const sent = await request.post(`${apiOrigin()}/v1/conversations/${conversation.id}/messages`, {
    headers: {
      cookie: actorCookie!,
      origin: process.env['WAI_E2E_WEB_ORIGIN'] ?? 'http://127.0.0.1:3188',
      'idempotency-key': randomUUID(),
    },
    data: { client_message_id: randomUUID(), body: launchMessage },
  });
  const sentText = await sent.text();
  expect(sent.status(), sentText).toBe(201);
  await page.context().clearCookies();
  await installCookie(page, firstCookie!);
  await page.goto('/messages');
  const mobile = await page.evaluate(() => matchMedia('(max-width: 720px)').matches);
  if (mobile) {
    // A new incoming message intentionally raises the compact mobile toast;
    // opening through it verifies the primary notification interaction and
    // avoids clicking through an overlay.
    await page.locator('.mobile-incoming-toast').click();
  }
  await expect(
    page
      .locator(mobile ? '.mobile-thread-messages' : '.messages-shell')
      .getByText(launchMessage, { exact: true }),
  ).toBeVisible();
  const recipientInbox = await request.get(`${apiOrigin()}/v1/conversations?limit=50`, {
    headers: { cookie: firstCookie! },
  });
  expect(recipientInbox.status()).toBe(200);
  const inboxBody = (await recipientInbox.json()) as {
    items: Array<{ id: string; last_message: { body: string } | null }>;
  };
  expect(inboxBody.items.find((item) => item.id === conversation.id)?.last_message?.body).toBe(
    launchMessage,
  );
});
