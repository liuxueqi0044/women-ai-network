import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, MigrationRunner, PgNotificationResourceGate } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { reconcileCircleNotificationHandoffs } from '../../../apps/worker/src/worker.module.js';

declare const WAI_MIGRATIONS_DIR: string;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let started: StartedInfra;
let pool: Pool;
let policyId: string;
let policyHash: string;
let membershipPolicyId: string;

async function account(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO iam.accounts(id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id) VALUES($1,$2,'enabled','registered','system',now(),now(),now(),'cipher','nonce','key')",
    [id, sha(id)],
  );
  const identity = randomUUID();
  const evidence = randomUUID();
  const credential = randomUUID();
  await pool.query(
    "INSERT INTO verification.identity_cases(id,account_id,state,age_assurance_state,version,created_at,updated_at,verified_at) VALUES($1,$2,'verified','attested',1,now(),now(),now())",
    [identity, id],
  );
  await pool.query(
    "INSERT INTO eligibility.age_evidence(id,account_id,birthday_digest,birthday_ciphertext,birthday_nonce,birthday_key_id,source,declared_at,created_at,verification_case_id,external_attestation_digest) VALUES($1,$2,$3,'cipher','nonce','key','verification_provider',now(),now(),$4,$5)",
    [evidence, id, sha(`birthday:${id}`), identity, sha(`attest:${id}`)],
  );
  await pool.query(
    "INSERT INTO eligibility.age_credentials(id,account_id,age_band,cohort_key,assurance_level,issuer_type,source_evidence_id,jurisdiction_policy_id,policy_revision,valid_from,valid_until,derived_at,derivation_version,created_at) VALUES($1,$2,'adult','adult','externally_attested','verification_module',$3,$4,1,now(),'infinity',now(),1,now())",
    [credential, id, evidence, policyId],
  );
  await pool.query(
    "INSERT INTO verification.membership_cases(id,account_id,policy_id,policy_revision,policy_content_hash,statement_category,consented_at,state,version,decided_at,created_at,updated_at) VALUES($1,$2,$3,1,$4,'community_participation',now(),'approved',1,now(),now(),now())",
    [randomUUID(), id, membershipPolicyId, sha(`membership:${membershipPolicyId}`)],
  );
  for (const mode of ['circles', 'friends']) {
    await pool.query(
      "INSERT INTO eligibility.mode_decisions(decision_id,account_id,scope,mode,decision,age_band,cohort_key,assurance_level,reason_codes,policy_id,policy_revision,policy_hash,credential_id,credential_hash,input_hash,evaluated_at,valid_until,engine_version,created_at) VALUES($1,$2,'age_and_jurisdiction',$3,'allow','adult','adult','externally_attested','{}',$4,1,$5,$6,$7,$8,now(),'infinity',1,now())",
      [
        randomUUID(),
        id,
        mode,
        policyId,
        policyHash,
        credential,
        sha(`credential:${credential}`),
        sha(`${id}:${mode}`),
      ],
    );
  }
  return id;
}
async function partition(actor: string, subject: string) {
  await pool.query(
    "INSERT INTO eligibility.partition_decisions(decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at) VALUES($1,$2,$3,'adult','adult','adult','adult','circles','allow','{}',$4,$4,1,1,$5,$5,$6,now(),1,now())",
    [randomUUID(), actor, subject, policyId, policyHash, sha(`${actor}:${subject}`)],
  );
}
async function invitation(owner: string, invitee: string) {
  const circleId = randomUUID();
  const invitationId = randomUUID();
  await pool.query(
    "INSERT INTO circles.circles(id,owner_account_id,name,lifecycle,visibility,mode,scope_kind,topic_catalog_version,topics,member_cap,created_at,updated_at) VALUES($1,$2,'Gate','active','invitation_only','friends','online',1,'[\"culture\"]',3,now(),now())",
    [circleId, owner],
  );
  await pool.query(
    "INSERT INTO circles.memberships(id,circle_id,account_id,role,state,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",
    [randomUUID(), circleId, owner],
  );
  await pool.query(
    "INSERT INTO circles.invitations(id,circle_id,inviter_account_id,invitee_account_id,role,state,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'member','pending',now()+interval '1 day',now(),now())",
    [invitationId, circleId, owner, invitee],
  );
  return { circleId, invitationId };
}
const check = (gate: PgNotificationResourceGate, recipient: string, resource: string) =>
  gate.check({
    actorAccountId: recipient,
    recipientAccountId: recipient,
    resourceKind: 'circle',
    resourceId: resource,
    eventKey: 'circle.invitation',
  });

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  await new MigrationRunner(pool, WAI_MIGRATIONS_DIR, { through: '0019_circles.sql' }).up();
  policyId = randomUUID();
  policyHash = sha(`policy:${policyId}`);
  membershipPolicyId = randomUUID();
  const policy = await pool.connect();
  try {
    await policy.query('BEGIN');
    await policy.query("SELECT set_config('app.eligibility_policy_publish','true',true)");
    await policy.query(
      "INSERT INTO eligibility.jurisdiction_policies(id,jurisdiction_key,revision,status,content,content_hash,rule_hash,location_precision_policy,profiling_policy,retention_policy,legal_basis_refs,reviewed_by,reviewed_at,timezone,effective_from,effective_until,created_at) VALUES($1,'US-77',1,'approved','{}',$2,$2,'country_only','derived_facts_only','test',ARRAY['test'],'principal',now(),'UTC',now(),'infinity',now())",
      [policyId, policyHash],
    );
    await policy.query('COMMIT');
  } finally {
    policy.release();
  }
  await pool.query(
    "INSERT INTO verification.membership_policies(id,revision,status,content_hash,legal_basis_ref,reviewed_by,reviewed_at,effective_from,effective_until,created_at) VALUES($1,1,'approved',$2,'test','principal',now(),now(),'infinity',now())",
    [membershipPolicyId, sha(`membership:${membershipPolicyId}`)],
  );
}, 180_000);
afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('CIR notification resource authority uses the accepted NTF gate', () => {
  it('requires a live exact invitation generation and all bilateral current authority', async () => {
    const owner = await account();
    const invitee = await account();
    await partition(owner, invitee);
    await partition(invitee, owner);
    const first = await invitation(owner, invitee);
    const gate = new PgNotificationResourceGate(pool);
    await expect(check(gate, invitee, first.invitationId)).resolves.toEqual({ allowed: true });

    const handoff = randomUUID();
    await pool.query(
      "INSERT INTO circles.notification_handoff(id,circle_id,invitation_id,recipient_account_id,role,event_key,state,attempts,idempotency_digest,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,'member','circle.invitation','pending',0,$5,now(),now(),now())",
      [handoff, first.circleId, first.invitationId, invitee, sha(`handoff:${handoff}`)],
    );
    await reconcileCircleNotificationHandoffs(pool, Buffer.alloc(32, 9));
    await expect(
      pool.query('SELECT state,attempts,last_error FROM circles.notification_handoff WHERE id=$1', [
        handoff,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: 'sent', attempts: 1, last_error: null }] });
    await expect(
      pool.query(
        "SELECT count(*)::int AS count FROM notifications.notifications WHERE resource_kind='circle' AND resource_id=$1",
        [first.invitationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    // Reconciliation is an at-least-once wake-up only: the completed handoff
    // cannot cause an additional in-app record.
    await reconcileCircleNotificationHandoffs(pool, Buffer.alloc(32, 9));
    await expect(
      pool.query(
        "SELECT count(*)::int AS count FROM notifications.notifications WHERE resource_kind='circle' AND resource_id=$1",
        [first.invitationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await pool.query(
      "UPDATE circles.invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [first.invitationId],
    );
    await expect(check(gate, invitee, first.invitationId)).resolves.toEqual({ allowed: false });
    await pool.query("UPDATE circles.invitations SET state='expired' WHERE id=$1", [
      first.invitationId,
    ]);
    const replacement = randomUUID();
    await pool.query(
      "INSERT INTO circles.invitations(id,circle_id,inviter_account_id,invitee_account_id,role,state,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,'member','pending',now()+interval '1 day',now(),now())",
      [replacement, first.circleId, owner, invitee],
    );
    await expect(check(gate, invitee, first.invitationId)).resolves.toEqual({ allowed: false });
    await expect(check(gate, invitee, replacement)).resolves.toEqual({ allowed: true });

    await pool.query(
      "INSERT INTO safety.blocks(id,blocker_account_id,blocked_account_id,reason,idempotency_digest,request_digest,state,created_at) VALUES($1,$2,$3,'other',$4,$4,'active',now())",
      [randomUUID(), owner, invitee, sha(`block:${owner}:${invitee}`)],
    );
    await expect(check(gate, invitee, replacement)).resolves.toEqual({ allowed: false });

    const exhausted = randomUUID();
    const staleToken = randomUUID();
    await pool.query(
      "INSERT INTO circles.notification_handoff(id,circle_id,invitation_id,recipient_account_id,role,event_key,state,attempts,lease_token,lease_fence,max_attempts,idempotency_digest,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,'member','circle.invitation','leased',1,$5,4,1,$6,now(),now(),now()-interval '6 minutes')",
      [exhausted, first.circleId, replacement, invitee, staleToken, sha(`handoff:${exhausted}`)],
    );
    await reconcileCircleNotificationHandoffs(pool, Buffer.alloc(32, 9));
    await expect(
      pool.query('SELECT state,last_error FROM circles.notification_handoff WHERE id=$1', [
        exhausted,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: 'failed', last_error: 'LEASE_EXHAUSTED' }] });
    // A late worker with an obsolete token/fence cannot overwrite the reaper.
    await expect(
      pool.query(
        "UPDATE circles.notification_handoff SET state='sent' WHERE id=$1 AND lease_token=$2 AND lease_fence=$3 AND state='leased'",
        [exhausted, staleToken, 4],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await pool.query(
      "UPDATE safety.blocks SET state='revoked',revoked_at=now() WHERE blocker_account_id=$1 AND blocked_account_id=$2",
      [owner, invitee],
    );
    const report = randomUUID();
    const safetyCase = randomUUID();
    await pool.query(
      "INSERT INTO safety.reports(id,reporter_account_id,subject_account_id,target_type,target_id,category,idempotency_digest,request_digest,state,created_at,updated_at) VALUES($1,$2,$3,'account','safety-test','other',$4,$4,'open',now(),now())",
      [report, owner, invitee, sha(`report:${invitee}`)],
    );
    await pool.query(
      "INSERT INTO safety.cases(id,report_id,severity,queue,state,version,created_at,updated_at) VALUES($1,$2,'high','test','open',0,now(),now())",
      [safetyCase, report],
    );
    await pool.query(
      "INSERT INTO safety.actions(id,case_id,action_type,state,proposer_id,approver_id,reason_code,effective_from,execution_token,executed_at,created_at,updated_at) VALUES($1,$2,'temporary_restriction','executed','test','test','POLICY_VIOLATION_CONFIRMED',now(),$3,now(),now(),now())",
      [randomUUID(), safetyCase, randomUUID()],
    );
    await expect(check(gate, invitee, replacement)).resolves.toEqual({ allowed: false });
  });
});
