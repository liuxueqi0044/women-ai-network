import { Inject, Injectable } from '@nestjs/common';
import type { CircleGrowthGatePort, CircleRole } from '@wai/contracts';
import type { SafetyBlockDecisionPort } from '@wai/contracts';
import { SAFETY_BLOCK_DECISION } from '@wai/contracts';
import { IAM_POOL } from '../tokens.js';
import type { Pool } from 'pg';

@Injectable()
export class CircleGrowthGateService implements CircleGrowthGatePort {
  constructor(
    @Inject(IAM_POOL) private readonly pool: Pool,
    @Inject(SAFETY_BLOCK_DECISION) private readonly safety: SafetyBlockDecisionPort,
  ) {}
  async check(input: {
    actorAccountId: string;
    circleId: string;
    subjectAccountId?: string;
    operation: 'read' | 'mutate' | 'admit' | 'escape' | 'archive';
    requiredRole?: CircleRole;
    transaction?: { query(text: string, values?: readonly unknown[]): Promise<unknown> };
  }) {
    try {
      // A final write barrier supplies the transaction that already owns the
      // canonical locks. Reads use the pool. Never silently fall back from a
      // supplied transaction: the gate would otherwise validate a different
      // snapshot than the mutation commits.
      const db = input.transaction ?? this.pool;
      const circle = await (db.query(
        "SELECT c.lifecycle,c.mode,c.owner_account_id,m.role FROM circles.circles c LEFT JOIN circles.memberships m ON m.circle_id=c.id AND m.account_id=$1 AND m.state='active' WHERE c.id=$2",
        [input.actorAccountId, input.circleId],
      ) as Promise<{
        rows: Array<{
          lifecycle: string;
          mode: string;
          role: CircleRole | null;
          owner_account_id: string;
        }>;
      }>);
      const row = circle.rows[0];
      if (
        !row ||
        (row.lifecycle === 'archived' &&
          input.operation !== 'escape' &&
          input.operation !== 'archive')
      )
        return { allowed: false, reason: 'CIRCLE_UNAVAILABLE' };
      if (input.operation !== 'escape' && input.operation !== 'admit' && !row.role)
        return { allowed: false, reason: 'MEMBERSHIP_UNAVAILABLE' };
      if (input.operation === 'escape' && row.lifecycle === 'archived' && !row.role)
        return { allowed: false, reason: 'MEMBERSHIP_UNAVAILABLE' };
      if (input.requiredRole && !row.role) return { allowed: false, reason: 'ROLE_UNAVAILABLE' };
      const rank: Record<CircleRole, number> = { member: 1, moderator: 2, owner: 3 };
      if (input.requiredRole && row.role && rank[row.role] < rank[input.requiredRole])
        return { allowed: false, reason: 'ROLE_UNAVAILABLE' };
      // Safety escape actions validate their resource binding in the
      // repository, but deliberately do not require the ordinary GrowthGate:
      // a revoked eligibility decision or a block may never strand a member.
      if (input.operation === 'escape')
        return row.role ? { allowed: true, role: row.role } : { allowed: true };
      const subject = input.subjectAccountId ?? row.owner_account_id;
      if (input.subjectAccountId && input.operation !== 'admit') {
        const subjectMember = await (db.query(
          "SELECT 1 FROM circles.memberships WHERE circle_id=$1 AND account_id=$2 AND state='active'",
          [input.circleId, subject],
        ) as Promise<{ rowCount: number | null }>);
        if (!subjectMember.rowCount) return { allowed: false, reason: 'MEMBERSHIP_UNAVAILABLE' };
      }
      const ids =
        subject === input.actorAccountId ? [input.actorAccountId] : [input.actorAccountId, subject];
      const growth = await (db.query(
        `WITH ids AS (SELECT unnest($1::uuid[]) AS account_id),
          enabled_accounts AS (
            SELECT a.id AS account_id FROM iam.accounts a JOIN ids ON ids.account_id=a.id
            WHERE a.state='enabled'
          ),
          identity AS (
            SELECT DISTINCT ON (i.account_id) i.account_id,i.id,i.state,i.age_assurance_state
            FROM verification.identity_cases i JOIN ids ON ids.account_id=i.account_id
            ORDER BY i.account_id,i.updated_at DESC,i.created_at DESC
          ),
          memberships AS (
            SELECT DISTINCT ON (m.account_id) m.account_id,m.state,p.status,p.effective_from,p.effective_until
            FROM verification.membership_cases m JOIN ids ON ids.account_id=m.account_id
            JOIN verification.membership_policies p ON p.id=m.policy_id AND p.revision=m.policy_revision AND p.content_hash=m.policy_content_hash
            ORDER BY m.account_id,m.updated_at DESC,m.created_at DESC
          ),
          credentials AS (
            SELECT DISTINCT ON (c.account_id) c.account_id,c.id,e.verification_case_id,c.assurance_level,c.jurisdiction_policy_id,c.policy_revision,c.valid_from,c.valid_until
            FROM eligibility.age_credentials c JOIN eligibility.age_evidence e ON e.id=c.source_evidence_id
              JOIN ids ON ids.account_id=c.account_id
            WHERE c.superseded_at IS NULL AND e.source='verification_provider'
            ORDER BY c.account_id,c.created_at DESC
          ),
          modes AS (
            SELECT DISTINCT ON (d.account_id) d.account_id,d.decision,d.valid_until,d.credential_id,d.policy_id,d.policy_revision,d.policy_hash
            FROM eligibility.mode_decisions d JOIN ids ON ids.account_id=d.account_id
            WHERE d.mode='circles'
            ORDER BY d.account_id,d.evaluated_at DESC,d.created_at DESC
          ),
          relationship_modes AS (
            SELECT DISTINCT ON (d.account_id) d.account_id,d.decision,d.valid_until,d.credential_id,d.policy_id,d.policy_revision,d.policy_hash
            FROM eligibility.mode_decisions d JOIN ids ON ids.account_id=d.account_id
            WHERE d.mode=$4
            ORDER BY d.account_id,d.evaluated_at DESC,d.created_at DESC
          ),
          partitions AS (
            SELECT DISTINCT ON (p.actor_account_id,p.subject_account_id,p.capability)
              p.actor_account_id,p.subject_account_id,p.decision,p.evaluated_at,
              p.actor_policy_id,p.subject_policy_id,p.actor_policy_revision,p.subject_policy_revision,
              p.actor_policy_hash,p.subject_policy_hash
            FROM eligibility.partition_decisions p
            WHERE p.actor_account_id=$2::uuid AND p.subject_account_id=$3::uuid AND p.capability='circles'
            ORDER BY p.actor_account_id,p.subject_account_id,p.capability,p.evaluated_at DESC,p.created_at DESC
          ),
          active_actions AS (
            SELECT DISTINCT r.subject_account_id AS account_id
            FROM safety.actions a
            JOIN safety.cases sc ON sc.id=a.case_id
            JOIN safety.reports r ON r.id=sc.report_id
            WHERE r.subject_account_id=ANY($1::uuid[]) AND a.state='executed'
              AND a.action_type IN ('temporary_restriction','permanent_ban','youth_restriction')
              AND (a.effective_from IS NULL OR a.effective_from<=now())
              AND (a.effective_until IS NULL OR a.effective_until>now())
          )
          SELECT (
            (SELECT count(*)=cardinality($1::uuid[]) FROM enabled_accounts)
            AND NOT EXISTS (SELECT 1 FROM active_actions)
            AND
            (SELECT count(*)=cardinality($1::uuid[]) FROM identity WHERE state='verified' AND age_assurance_state='attested')
            AND (SELECT count(*)=cardinality($1::uuid[]) FROM memberships WHERE state='approved' AND status='approved' AND effective_from<=now() AND effective_until>now())
            AND (SELECT count(*)=cardinality($1::uuid[]) FROM credentials c JOIN identity i ON i.account_id=c.account_id
              JOIN eligibility.jurisdiction_policies jp ON jp.id=c.jurisdiction_policy_id AND jp.revision=c.policy_revision
              WHERE c.assurance_level='externally_attested' AND c.valid_from<=now() AND c.valid_until>now() AND c.verification_case_id=i.id
                AND jp.status='approved' AND jp.effective_from<=now() AND jp.effective_until>now())
            AND (SELECT count(*)=cardinality($1::uuid[]) FROM modes d JOIN credentials c ON c.account_id=d.account_id AND c.id=d.credential_id
              JOIN eligibility.jurisdiction_policies jp ON jp.id=d.policy_id AND jp.revision=d.policy_revision AND jp.content_hash=d.policy_hash
              WHERE d.decision='allow' AND d.valid_until>now() AND d.policy_id=c.jurisdiction_policy_id AND d.policy_revision=c.policy_revision
                AND jp.status='approved' AND jp.effective_from<=now() AND jp.effective_until>now())
            AND (SELECT count(*)=cardinality($1::uuid[]) FROM relationship_modes d JOIN credentials c ON c.account_id=d.account_id AND c.id=d.credential_id
              JOIN eligibility.jurisdiction_policies jp ON jp.id=d.policy_id AND jp.revision=d.policy_revision AND jp.content_hash=d.policy_hash
              WHERE d.decision='allow' AND d.valid_until>now() AND d.policy_id=c.jurisdiction_policy_id AND d.policy_revision=c.policy_revision
                AND jp.status='approved' AND jp.effective_from<=now() AND jp.effective_until>now())
            AND ($2::uuid=$3::uuid OR EXISTS (SELECT 1 FROM partitions p JOIN credentials ac ON ac.account_id=p.actor_account_id JOIN credentials sc ON sc.account_id=p.subject_account_id
              WHERE p.decision='allow' AND p.evaluated_at>=now()-interval '15 minutes'
                AND p.actor_policy_id=ac.jurisdiction_policy_id AND p.actor_policy_revision=ac.policy_revision
                AND p.subject_policy_id=sc.jurisdiction_policy_id AND p.subject_policy_revision=sc.policy_revision
                AND p.actor_policy_hash=(SELECT content_hash FROM eligibility.jurisdiction_policies WHERE id=ac.jurisdiction_policy_id AND revision=ac.policy_revision AND status='approved' AND effective_from<=now() AND effective_until>now())
                AND p.subject_policy_hash=(SELECT content_hash FROM eligibility.jurisdiction_policies WHERE id=sc.jurisdiction_policy_id AND revision=sc.policy_revision AND status='approved' AND effective_from<=now() AND effective_until>now())))
          ) AS allowed`,
        [ids, input.actorAccountId, subject, row.mode],
      ) as Promise<{ rows: Array<{ allowed: boolean }> }>);
      if (growth.rows[0]?.allowed !== true) return { allowed: false, reason: 'GROWTH_UNAVAILABLE' };
      if (subject !== input.actorAccountId) {
        const localBlock = await (db.query(
          "SELECT 1 FROM safety.blocks WHERE state='active' AND ((blocker_account_id=$1 AND blocked_account_id=$2) OR (blocker_account_id=$2 AND blocked_account_id=$1)) LIMIT 1",
          [input.actorAccountId, subject],
        ) as Promise<{ rowCount: number | null }>);
        if (localBlock.rowCount) return { allowed: false, reason: 'SAFETY_UNAVAILABLE' };
        // Retain the public SAF port at ordinary read boundaries; transactional
        // barriers above use SAF's authoritative PostgreSQL state directly.
        if (!input.transaction) {
          const block = await this.safety.isInteractionAllowed(
            input.actorAccountId,
            subject,
            'circle',
          );
          if (!block.allowed) return { allowed: false, reason: 'SAFETY_UNAVAILABLE' };
        }
      }
      return row.role ? { allowed: true, role: row.role } : { allowed: true };
    } catch {
      return { allowed: false, reason: 'POLICY_UNAVAILABLE' };
    }
  }
}
