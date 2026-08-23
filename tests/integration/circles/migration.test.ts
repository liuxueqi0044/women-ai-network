import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, MigrationRunner } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';
import { randomUUID } from 'node:crypto';

declare const WAI_MIGRATIONS_DIR: string;

let started: StartedInfra;
let pool: Pool;
let runner: MigrationRunner;

beforeAll(async () => {
  started = await startTestInfra();
  pool = createPool(started.infra.databaseUrl);
  runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, { through: '0019_circles.sql' });
}, 180_000);
afterAll(async () => {
  await pool.end();
  await started.stop();
});

describe('CIR-01 real migration lifecycle', () => {
  it('is fresh-installable, no-op replayable, reversible and re-upgradeable', async () => {
    const first = await runner.up();
    expect(first.applied.at(-1)).toBe('0019_circles.sql');
    expect(await runner.up()).toMatchObject({ applied: [] });
    await expect(runner.down()).resolves.toBe('0019_circles.sql');
    expect(
      (await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='circles'"))
        .rowCount,
    ).toBe(0);
    expect((await runner.up()).applied).toEqual(['0019_circles.sql']);
  });

  it('preserves append-only circle evidence through down/up while rejecting new retired targets', async () => {
    const reportId = randomUUID();
    const snapshotId = randomUUID();
    const caseId = randomUUID();
    const partitionActor = randomUUID();
    const partitionSubject = randomUUID();
    const partitionPolicy = randomUUID();
    const partitionHash = 'f'.repeat(64);
    const now = new Date();
    await pool.query(
      "INSERT INTO iam.accounts(id,email_digest,state,state_reason,state_actor_type,state_changed_at,created_at,updated_at,email_ciphertext,email_nonce,email_key_id) VALUES($1,$2,'enabled','registered','system',$3,$3,$3,'cipher','nonce','key'),($4,$5,'enabled','registered','system',$3,$3,$3,'cipher','nonce','key')",
      [
        partitionActor,
        `partition-actor-${partitionActor}`.replaceAll('-', ''),
        now,
        partitionSubject,
        `partition-subject-${partitionSubject}`.replaceAll('-', ''),
      ],
    );
    const policyClient = await pool.connect();
    try {
      await policyClient.query('BEGIN');
      await policyClient.query("SELECT set_config('app.eligibility_policy_publish','true',true)");
      await policyClient.query(
        `INSERT INTO eligibility.jurisdiction_policies
           (id,jurisdiction_key,revision,status,content,content_hash,rule_hash,location_precision_policy,profiling_policy,retention_policy,legal_basis_refs,reviewed_by,reviewed_at,timezone,effective_from,effective_until,created_at)
         VALUES($1,$2,1,'approved','{}',$3,$3,'country_only','derived_facts_only','test',ARRAY['test:cir'],'principal',$4,'UTC',$4,'infinity',$4)`,
        [partitionPolicy, `US-${partitionPolicy.slice(0, 3).toUpperCase()}`, partitionHash, now],
      );
      await policyClient.query('COMMIT');
    } catch (error) {
      await policyClient.query('ROLLBACK');
      throw error;
    } finally {
      policyClient.release();
    }
    const insertCirclePartition = (id: string) =>
      pool.query(
        `INSERT INTO eligibility.partition_decisions
           (decision_id,actor_account_id,subject_account_id,actor_age_band,actor_cohort_key,subject_age_band,subject_cohort_key,capability,decision,reason_codes,actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,actor_policy_hash,subject_policy_hash,input_hash,evaluated_at,engine_version,created_at)
         VALUES($1,$2,$3,'adult','adult','adult','adult','circles','allow','{}',$4,$4,1,1,$5,$5,$6,now(),1,now())`,
        [id, partitionActor, partitionSubject, partitionPolicy, partitionHash, 'e'.repeat(64)],
      );
    const partitionId = randomUUID();
    await insertCirclePartition(partitionId);
    await pool.query(
      "INSERT INTO safety.reports(id,target_type,target_id,category,idempotency_digest,request_digest,state,created_at,updated_at) VALUES($1,'circle',$2,'other',$3,$4,'open',now(),now())",
      [reportId, randomUUID(), 'a'.repeat(64), 'b'.repeat(64)],
    );
    await pool.query(
      "INSERT INTO safety.evidence_snapshots(id,report_id,encrypted_snapshot,snapshot_nonce,key_id,snapshot_hash,captured_at,created_at) VALUES($1,$2,'opaque','nonce','key',$3,now(),now())",
      [snapshotId, reportId, 'c'.repeat(64)],
    );
    await pool.query(
      "INSERT INTO safety.cases(id,report_id,severity,queue,state,version,created_at,updated_at) VALUES($1,$2,'high','migration-test','open',0,now(),now())",
      [caseId, reportId],
    );
    await expect(runner.down()).resolves.toBe('0019_circles.sql');
    expect(
      (
        await pool.query(
          'SELECT decision_id FROM eligibility.partition_decisions WHERE decision_id=$1',
          [partitionId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await pool.query('SELECT id FROM safety.evidence_snapshots WHERE id=$1', [snapshotId]))
        .rowCount,
    ).toBe(1);
    expect((await pool.query('SELECT id FROM safety.cases WHERE id=$1', [caseId])).rowCount).toBe(
      1,
    );
    await expect(
      pool.query(
        "INSERT INTO safety.reports(id,target_type,target_id,category,idempotency_digest,request_digest,state,created_at,updated_at) VALUES($1,'note',$2,'other',$3,$4,'open',now(),now())",
        [randomUUID(), randomUUID(), 'd'.repeat(64), 'e'.repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(insertCirclePartition(randomUUID())).rejects.toThrow();
    await expect(runner.up()).resolves.toMatchObject({ applied: ['0019_circles.sql'] });
    expect(
      (await pool.query('SELECT id FROM safety.reports WHERE id=$1', [reportId])).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT convalidated FROM pg_constraint WHERE conname='partition_decisions_capability_check'",
        )
      ).rows[0].convalidated,
    ).toBe(true);
  });

  it('installs partial keyset indexes used by the production list surfaces', async () => {
    await runner.up();
    const names = (
      await pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname='circles' AND indexname = ANY($1::text[])",
        [
          [
            'circles_membership_account_active_cursor_idx',
            'circles_membership_circle_active_cursor_idx',
            'circles_pending_join_cursor_idx',
          ],
        ],
      )
    ).rows.map((row) => row.indexname);
    expect(names.sort()).toEqual([
      'circles_membership_account_active_cursor_idx',
      'circles_membership_circle_active_cursor_idx',
      'circles_pending_join_cursor_idx',
    ]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan=off');
      const explain = async (sql: string, values: string[]) =>
        (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, values)).rows
          .map((row) => row['QUERY PLAN'])
          .join('\n');
      await expect(
        explain(
          "SELECT circle_id FROM circles.memberships WHERE account_id=$1 AND state='active' ORDER BY updated_at DESC,circle_id DESC LIMIT 20",
          [randomUUID()],
        ),
      ).resolves.toContain('circles_membership_account_active_cursor_idx');
      await expect(
        explain(
          "SELECT account_id,role FROM circles.memberships WHERE circle_id=$1 AND state='active' ORDER BY updated_at DESC,account_id DESC LIMIT 20",
          [randomUUID()],
        ),
      ).resolves.toContain('circles_membership_circle_active_cursor_idx');
      await expect(
        explain(
          "SELECT id,account_id,message_ciphertext,message_nonce,message_key_id FROM circles.join_requests WHERE circle_id=$1 AND state='pending' ORDER BY created_at DESC,id DESC LIMIT 20",
          [randomUUID()],
        ),
      ).resolves.toContain('circles_pending_join_cursor_idx');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
});
