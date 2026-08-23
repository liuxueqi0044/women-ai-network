import type { InteractionGatePort } from '@wai/contracts';
import type { Pool } from 'pg';

/**
 * The production worker gate reads the same durable connection, safety,
 * account, eligibility and verification snapshots used by the API. A missing
 * policy snapshot is retryable, never silently converted into a permanent
 * delivery denial.
 */
export class DatabasePrivateDeliveryPolicyGate implements InteractionGatePort {
  constructor(private readonly pool: Pool) {}

  async check(input: Parameters<InteractionGatePort['check']>[0]) {
    if (!input.connectionId || input.acceptedEpoch === undefined)
      return { allowed: false as const, reason: 'POLICY_UNAVAILABLE' as const };
    try {
      const result = await this.pool.query<{
        accounts_ok: boolean;
        connection_ok: boolean;
        block_ok: boolean;
        partition_ok: boolean;
        mode_ok: boolean;
        membership_ok: boolean;
        credential_ok: boolean;
        identity_ok: boolean;
      }>(
        `WITH current_identity AS (
           SELECT DISTINCT ON (account_id) account_id,id,state,age_assurance_state,updated_at
             FROM verification.identity_cases
            WHERE account_id IN ($1::uuid,$2::uuid)
            ORDER BY account_id,updated_at DESC,created_at DESC
         ), current_credentials AS (
           SELECT DISTINCT ON (account_id) account_id,id,created_at,valid_from,valid_until,source_evidence_id,assurance_level,jurisdiction_policy_id,policy_revision
             FROM eligibility.age_credentials
            WHERE account_id IN ($1::uuid,$2::uuid) AND superseded_at IS NULL
            ORDER BY account_id,created_at DESC
         ), latest_modes AS (
           SELECT DISTINCT ON (account_id) * FROM eligibility.mode_decisions
            WHERE account_id IN ($1::uuid,$2::uuid) AND mode=$3
            ORDER BY account_id,evaluated_at DESC,created_at DESC
         ), latest_memberships AS (
           SELECT DISTINCT ON (account_id) * FROM verification.membership_cases
            WHERE account_id IN ($1::uuid,$2::uuid)
            ORDER BY account_id,updated_at DESC,created_at DESC
         )
         SELECT
           EXISTS (SELECT 1 FROM iam.accounts a WHERE a.id IN ($1::uuid,$2::uuid) GROUP BY a.state HAVING count(*)=2 AND bool_and(a.state='enabled')) AS accounts_ok,
           EXISTS (SELECT 1 FROM connection.connections c WHERE c.id=$4::uuid AND c.state='accepted' AND c.version=$5::integer AND c.mode=$3 AND ((c.requester_account_id=$1 AND c.recipient_account_id=$2) OR (c.requester_account_id=$2 AND c.recipient_account_id=$1))) AS connection_ok,
           NOT EXISTS (SELECT 1 FROM safety.blocks b WHERE b.state='active' AND ((b.blocker_account_id=$1 AND b.blocked_account_id=$2) OR (b.blocker_account_id=$2 AND b.blocked_account_id=$1))) AS block_ok,
           COALESCE((SELECT p.decision='allow'
                              AND p.evaluated_at >= greatest(ac.created_at,sc.created_at,now() - interval '15 minutes')
                              AND p.actor_policy_id=ac.jurisdiction_policy_id
                              AND p.actor_policy_revision=ac.policy_revision
                              AND p.subject_policy_id=sc.jurisdiction_policy_id
                              AND p.subject_policy_revision=sc.policy_revision
                              AND ap.status='approved' AND ap.effective_from <= now() AND ap.effective_until > now()
                              AND sp.status='approved' AND sp.effective_from <= now() AND sp.effective_until > now()
                       FROM eligibility.partition_decisions p
                       JOIN current_credentials ac ON ac.account_id=$1
                       JOIN current_credentials sc ON sc.account_id=$2
                       JOIN eligibility.jurisdiction_policies ap ON ap.id=p.actor_policy_id AND ap.revision=p.actor_policy_revision AND ap.content_hash=p.actor_policy_hash AND ap.content_hash=(SELECT content_hash FROM eligibility.jurisdiction_policies WHERE id=ac.jurisdiction_policy_id AND revision=ac.policy_revision)
                       JOIN eligibility.jurisdiction_policies sp ON sp.id=p.subject_policy_id AND sp.revision=p.subject_policy_revision AND sp.content_hash=p.subject_policy_hash AND sp.content_hash=(SELECT content_hash FROM eligibility.jurisdiction_policies WHERE id=sc.jurisdiction_policy_id AND revision=sc.policy_revision)
                      WHERE p.actor_account_id=$1 AND p.subject_account_id=$2 AND p.capability='direct_message'
                      ORDER BY p.evaluated_at DESC,p.created_at DESC LIMIT 1), false) AS partition_ok,
           (SELECT count(*)=2 AND bool_and(m.decision='allow' AND m.valid_until > now() AND m.evaluated_at >= cc.created_at AND jp.status='approved' AND jp.effective_from <= now() AND jp.effective_until > now() AND m.credential_id=cc.id AND m.policy_id=cc.jurisdiction_policy_id AND m.policy_revision=cc.policy_revision)
              FROM latest_modes m JOIN current_credentials cc ON cc.account_id=m.account_id JOIN eligibility.jurisdiction_policies jp ON jp.id=m.policy_id AND jp.revision=m.policy_revision AND jp.content_hash=m.policy_hash) AS mode_ok,
           (SELECT count(*)=2 AND bool_and(m.state='approved' AND p.status='approved' AND p.effective_from <= now() AND p.effective_until > now())
              FROM iam.accounts a LEFT JOIN latest_memberships m ON m.account_id=a.id
              LEFT JOIN verification.membership_policies p ON p.id=m.policy_id AND p.revision=m.policy_revision AND p.content_hash=m.policy_content_hash
             WHERE a.id IN ($1::uuid,$2::uuid)) AS membership_ok,
           (SELECT count(*)=2 AND bool_and(e.id IS NOT NULL AND e.source='verification_provider' AND e.verification_case_id=(SELECT i.id FROM current_identity i WHERE i.account_id=cc.account_id) AND cc.assurance_level='externally_attested' AND cc.valid_from <= now() AND cc.valid_until > now() AND e.declared_at <= cc.created_at)
              FROM current_credentials cc LEFT JOIN eligibility.age_evidence e ON e.id=cc.source_evidence_id AND e.account_id=cc.account_id AND e.superseded_at IS NULL) AS credential_ok,
           (SELECT count(*)=2 AND bool_and(i.state='verified' AND i.age_assurance_state='attested') FROM current_identity i) AS identity_ok`,
        [
          input.actorAccountId,
          input.subjectAccountId,
          input.mode,
          input.connectionId,
          input.acceptedEpoch,
        ],
      );
      const row = result.rows[0];
      if (!row || !row.accounts_ok || !row.connection_ok) {
        return { allowed: false as const, reason: 'PARTITION_DENIED' as const };
      }
      if (!row.block_ok) return { allowed: false as const, reason: 'ACTIVE_BLOCK' as const };
      if (
        !row.identity_ok ||
        !row.credential_ok ||
        !row.partition_ok ||
        !row.mode_ok ||
        !row.membership_ok
      )
        return { allowed: false as const, reason: 'PARTITION_DENIED' as const };
      return { allowed: true as const };
    } catch {
      return { allowed: false as const, reason: 'POLICY_UNAVAILABLE' as const };
    }
  }
}
