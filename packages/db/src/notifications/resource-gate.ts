import type { Pool } from 'pg';
import {
  notificationResourceAdapterRelations,
  type NotificationResourceGatePort,
  type NotificationResourceKind,
} from '@wai/contracts';

type ResourceRow = { subject_account_id: string | null; exact_mode: string | null };

/**
 * The notification visibility authority. The resource query and the growth
 * snapshot query are deliberately in one port so list/count/read and the
 * worker cannot silently evolve different gates.
 *
 * Every account must have a current VER identity/credential, approved
 * membership, and exact ELG mode snapshot. Cross-account resources also need
 * a fresh partition decision. Missing or revoked snapshots deny access.
 */
export class PgNotificationResourceGate implements NotificationResourceGatePort {
  constructor(private readonly pool: Pool) {}

  async check(input: Parameters<NotificationResourceGatePort['check']>[0]) {
    const relation =
      notificationResourceAdapterRelations[input.resourceKind as NotificationResourceKind];
    if (!relation) return { allowed: false as const };
    try {
      const account = await this.pool.query(
        "SELECT 1 FROM iam.accounts WHERE id=$1 AND state='enabled'",
        [input.recipientAccountId],
      );
      if (!account.rowCount) return { allowed: false as const };

      // CIR notifications are addressed to an invitation *generation*, not
      // to the circle.  Its authority is deliberately stricter than the
      // ordinary resource adapters: an old invitation can never become
      // visible again after expiry, decline, cancellation or re-invitation.
      if (input.resourceKind === 'circle') return await this.checkCircleInvitation(input);

      const resourceClause = this.resourceClause(input.resourceKind);
      const resourceQuery = `SELECT ${resourceClause.subject} AS subject_account_id,${resourceClause.mode} AS exact_mode FROM ${relation} r ${resourceClause.joins} WHERE ${(resourceClause as { id?: string }).id ?? 'r.id'}::text=$1 AND ${resourceClause.where} LIMIT 1`;
      const resource = await this.pool.query<ResourceRow>(
        resourceQuery,
        resourceQuery.includes('$2')
          ? [input.resourceId, input.recipientAccountId]
          : [input.resourceId],
      );
      const subject = resource.rows[0]?.subject_account_id;
      const exactMode = resource.rows[0]?.exact_mode;
      if (!subject || !exactMode) return { allowed: false as const };
      const accountIds =
        subject === input.recipientAccountId
          ? [input.recipientAccountId]
          : [input.recipientAccountId, subject];
      if (subject !== input.recipientAccountId) {
        const blocked = await this.pool.query(
          `SELECT 1 FROM safety.blocks WHERE state='active' AND ((blocker_account_id=$1 AND blocked_account_id=$2) OR (blocker_account_id=$2 AND blocked_account_id=$1))`,
          [input.recipientAccountId, subject],
        );
        if (blocked.rowCount) return { allowed: false as const };
      }
      const growth = await this.pool.query<{ allowed: boolean }>(
        `WITH ids AS (
           SELECT unnest($1::uuid[]) AS account_id
         ), current_identity AS (
           SELECT DISTINCT ON (account_id) account_id,id,state,age_assurance_state
             FROM verification.identity_cases
            WHERE account_id = ANY($1::uuid[])
            ORDER BY account_id,updated_at DESC,created_at DESC
         ), current_membership AS (
           SELECT DISTINCT ON (m.account_id) m.account_id,m.state,p.status,p.effective_from,p.effective_until
             FROM verification.membership_cases m
             LEFT JOIN verification.membership_policies p
               ON p.id=m.policy_id AND p.revision=m.policy_revision AND p.content_hash=m.policy_content_hash
            WHERE m.account_id = ANY($1::uuid[])
            ORDER BY m.account_id,m.updated_at DESC,m.created_at DESC
         ), current_credentials AS (
           SELECT DISTINCT ON (c.account_id) c.account_id,c.id,c.source_evidence_id,e.verification_case_id,
                  c.assurance_level,c.jurisdiction_policy_id,c.policy_revision,c.valid_from,c.valid_until
             FROM eligibility.age_credentials c
             JOIN eligibility.age_evidence e ON e.id=c.source_evidence_id
            WHERE c.account_id=ANY($1::uuid[]) AND c.superseded_at IS NULL AND e.source='verification_provider'
            ORDER BY c.account_id,c.created_at DESC
         ), current_modes AS (
           SELECT DISTINCT ON (d.account_id) d.account_id,d.decision,d.valid_until,d.mode,d.credential_id,d.policy_id,d.policy_revision,d.policy_hash
            FROM eligibility.mode_decisions d
            WHERE d.account_id = ANY($1::uuid[]) AND d.mode=$5
            ORDER BY d.account_id,d.evaluated_at DESC,d.created_at DESC
         ), current_partitions AS (
           SELECT DISTINCT ON (actor_account_id,subject_account_id,capability)
                  actor_account_id,subject_account_id,capability,decision,evaluated_at,
                  actor_policy_id,subject_policy_id,actor_policy_revision,subject_policy_revision,
                  actor_policy_hash,subject_policy_hash
             FROM eligibility.partition_decisions
            WHERE actor_account_id=$2::uuid AND subject_account_id=$3::uuid
              AND capability=$4
            ORDER BY actor_account_id,subject_account_id,capability,evaluated_at DESC,created_at DESC
         )
         SELECT (
           (SELECT count(*)=cardinality($1::uuid[]) FROM current_identity i WHERE i.state='verified' AND i.age_assurance_state='attested')
           AND
           (SELECT count(*)=cardinality($1::uuid[]) FROM current_membership m WHERE m.state='approved' AND m.status='approved' AND m.effective_from<=now() AND m.effective_until>now())
           AND
           (SELECT count(*)=cardinality($1::uuid[]) FROM current_modes d
             JOIN current_credentials c ON c.account_id=d.account_id AND c.id=d.credential_id
              AND d.policy_id=c.jurisdiction_policy_id AND d.policy_revision=c.policy_revision
             JOIN eligibility.jurisdiction_policies jp ON jp.id=d.policy_id AND jp.revision=d.policy_revision AND jp.content_hash=d.policy_hash AND jp.status='approved' AND jp.effective_from<=now() AND jp.effective_until>now()
             WHERE d.decision='allow' AND d.valid_until>now())
           AND
           (SELECT count(*)=cardinality($1::uuid[]) FROM current_credentials c
             JOIN current_identity i ON i.account_id=c.account_id
             JOIN eligibility.jurisdiction_policies jp ON jp.id=c.jurisdiction_policy_id AND jp.revision=c.policy_revision
              AND jp.status='approved' AND jp.effective_from<=now() AND jp.effective_until>now()
             WHERE c.assurance_level='externally_attested' AND c.valid_from<=now() AND c.valid_until>now()
               AND c.verification_case_id=i.id)
           AND
           ($2::uuid=$3::uuid OR (SELECT count(*)=1
              FROM current_partitions p
              JOIN current_credentials ac ON ac.account_id=p.actor_account_id
              JOIN current_credentials sc ON sc.account_id=p.subject_account_id
              JOIN eligibility.jurisdiction_policies ap ON ap.id=ac.jurisdiction_policy_id
                AND ap.revision=ac.policy_revision AND ap.content_hash=p.actor_policy_hash
                AND ap.status='approved' AND ap.effective_from<=now() AND ap.effective_until>now()
              JOIN eligibility.jurisdiction_policies sp ON sp.id=sc.jurisdiction_policy_id
                AND sp.revision=sc.policy_revision AND sp.content_hash=p.subject_policy_hash
                AND sp.status='approved' AND sp.effective_from<=now() AND sp.effective_until>now()
              WHERE p.decision='allow' AND p.evaluated_at>=now()-interval '15 minutes'
                AND p.actor_policy_id=ac.jurisdiction_policy_id
                AND p.actor_policy_revision=ac.policy_revision
                AND p.subject_policy_id=sc.jurisdiction_policy_id
                AND p.subject_policy_revision=sc.policy_revision))
         ) AS allowed`,
        [
          accountIds,
          input.recipientAccountId,
          subject,
          this.capability(input.resourceKind),
          exactMode,
        ],
      );
      return { allowed: growth.rows[0]?.allowed === true };
    } catch {
      return { allowed: false as const, retryable: true as const };
    }
  }

  private async checkCircleInvitation(input: Parameters<NotificationResourceGatePort['check']>[0]) {
    try {
      const allowed = await this.pool.query<{ allowed: boolean }>(
        `WITH invitation AS (
           SELECT ci.inviter_account_id AS subject_account_id,c.mode
             FROM circles.invitations ci
             JOIN circles.circles c ON c.id=ci.circle_id AND c.lifecycle='active'
             JOIN circles.memberships inviter ON inviter.circle_id=c.id
               AND inviter.account_id=ci.inviter_account_id
               AND inviter.state='active' AND inviter.role IN ('owner','moderator')
            WHERE ci.id=$1::uuid AND ci.invitee_account_id=$2::uuid
              AND ci.state='pending' AND ci.expires_at>now()
         ), ids AS (
           SELECT $2::uuid AS account_id
           UNION SELECT subject_account_id FROM invitation
         ), enabled_accounts AS (
           SELECT a.id FROM iam.accounts a JOIN ids ON ids.account_id=a.id WHERE a.state='enabled'
         ), current_identity AS (
           SELECT DISTINCT ON (i.account_id) i.account_id,i.id,i.state,i.age_assurance_state
             FROM verification.identity_cases i JOIN ids ON ids.account_id=i.account_id
            ORDER BY i.account_id,i.updated_at DESC,i.created_at DESC
         ), current_membership AS (
           SELECT DISTINCT ON (m.account_id) m.account_id,m.state,p.status,p.effective_from,p.effective_until
             FROM verification.membership_cases m JOIN ids ON ids.account_id=m.account_id
             JOIN verification.membership_policies p ON p.id=m.policy_id
               AND p.revision=m.policy_revision AND p.content_hash=m.policy_content_hash
            ORDER BY m.account_id,m.updated_at DESC,m.created_at DESC
         ), current_credentials AS (
           SELECT DISTINCT ON (c.account_id) c.account_id,c.id,e.verification_case_id,
                  c.assurance_level,c.jurisdiction_policy_id,c.policy_revision,c.valid_from,c.valid_until
             FROM eligibility.age_credentials c
             JOIN eligibility.age_evidence e ON e.id=c.source_evidence_id
             JOIN ids ON ids.account_id=c.account_id
            WHERE c.superseded_at IS NULL AND e.source='verification_provider'
            ORDER BY c.account_id,c.created_at DESC
         ), current_modes AS (
           SELECT DISTINCT ON (d.account_id,d.mode) d.account_id,d.mode,d.decision,d.valid_until,
                  d.credential_id,d.policy_id,d.policy_revision,d.policy_hash
             FROM eligibility.mode_decisions d JOIN ids ON ids.account_id=d.account_id
             JOIN invitation i ON true
            WHERE d.mode IN ('circles',i.mode)
            ORDER BY d.account_id,d.mode,d.evaluated_at DESC,d.created_at DESC
         ), current_partitions AS (
           SELECT DISTINCT ON (p.actor_account_id,p.subject_account_id) p.actor_account_id,p.subject_account_id,
                  p.decision,p.evaluated_at,p.actor_policy_id,p.subject_policy_id,
                  p.actor_policy_revision,p.subject_policy_revision,p.actor_policy_hash,p.subject_policy_hash
             FROM eligibility.partition_decisions p JOIN invitation i ON true
            WHERE p.capability='circles' AND ((p.actor_account_id=$2::uuid AND p.subject_account_id=i.subject_account_id)
                 OR (p.actor_account_id=i.subject_account_id AND p.subject_account_id=$2::uuid))
            ORDER BY p.actor_account_id,p.subject_account_id,p.evaluated_at DESC,p.created_at DESC
         ), restrictive_actions AS (
           SELECT DISTINCT r.subject_account_id AS account_id
             FROM safety.actions a JOIN safety.cases sc ON sc.id=a.case_id
             JOIN safety.reports r ON r.id=sc.report_id JOIN ids ON ids.account_id=r.subject_account_id
            WHERE a.state='executed' AND a.action_type IN ('temporary_restriction','permanent_ban','youth_restriction')
              AND (a.effective_from IS NULL OR a.effective_from<=now())
              AND (a.effective_until IS NULL OR a.effective_until>now())
         ) SELECT (
           (SELECT count(*)=1 FROM invitation)
           AND (SELECT count(*)=2 FROM enabled_accounts)
           AND (SELECT count(*)=2 FROM current_identity WHERE state='verified' AND age_assurance_state='attested')
           AND (SELECT count(*)=2 FROM current_membership WHERE state='approved' AND status='approved'
                AND effective_from<=now() AND effective_until>now())
           AND (SELECT count(*)=2 FROM current_credentials c JOIN current_identity i ON i.account_id=c.account_id
                JOIN eligibility.jurisdiction_policies jp ON jp.id=c.jurisdiction_policy_id AND jp.revision=c.policy_revision
                WHERE c.assurance_level='externally_attested' AND c.valid_from<=now() AND c.valid_until>now()
                  AND c.verification_case_id=i.id AND jp.status='approved'
                  AND jp.effective_from<=now() AND jp.effective_until>now())
           AND (SELECT count(*)=4 FROM current_modes d JOIN current_credentials c ON c.account_id=d.account_id AND c.id=d.credential_id
                JOIN eligibility.jurisdiction_policies jp ON jp.id=d.policy_id AND jp.revision=d.policy_revision
                  AND jp.content_hash=d.policy_hash AND jp.status='approved'
                  AND jp.effective_from<=now() AND jp.effective_until>now()
                WHERE d.decision='allow' AND d.valid_until>now() AND d.policy_id=c.jurisdiction_policy_id
                  AND d.policy_revision=c.policy_revision)
           AND (SELECT count(*)=2 FROM current_partitions p JOIN invitation i ON true
                JOIN current_credentials ac ON ac.account_id=p.actor_account_id
                JOIN current_credentials sc ON sc.account_id=p.subject_account_id
                JOIN eligibility.jurisdiction_policies ap ON ap.id=ac.jurisdiction_policy_id AND ap.revision=ac.policy_revision
                  AND ap.content_hash=p.actor_policy_hash AND ap.status='approved' AND ap.effective_from<=now() AND ap.effective_until>now()
                JOIN eligibility.jurisdiction_policies sp ON sp.id=sc.jurisdiction_policy_id AND sp.revision=sc.policy_revision
                  AND sp.content_hash=p.subject_policy_hash AND sp.status='approved' AND sp.effective_from<=now() AND sp.effective_until>now()
                WHERE p.decision='allow' AND p.evaluated_at>=now()-interval '15 minutes'
                  AND p.actor_policy_id=ac.jurisdiction_policy_id AND p.actor_policy_revision=ac.policy_revision
                  AND p.subject_policy_id=sc.jurisdiction_policy_id AND p.subject_policy_revision=sc.policy_revision)
           AND NOT EXISTS (SELECT 1 FROM restrictive_actions)
           AND NOT EXISTS (SELECT 1 FROM safety.blocks b JOIN invitation i ON true WHERE b.state='active'
                AND ((b.blocker_account_id=$2::uuid AND b.blocked_account_id=i.subject_account_id)
                  OR (b.blocker_account_id=i.subject_account_id AND b.blocked_account_id=$2::uuid)))
         ) AS allowed`,
        [input.resourceId, input.recipientAccountId],
      );
      return { allowed: allowed.rows[0]?.allowed === true };
    } catch {
      // A database failure differs from a policy denial; delivery may retry
      // it but it is never allowed visible while the authority is unknown.
      return { allowed: false as const, retryable: true as const };
    }
  }

  private capability(kind: NotificationResourceKind) {
    if (kind === 'conversation') return 'direct_message';
    if (kind === 'connection' || kind === 'introduction') return 'introduce';
    if (kind === 'circle') return 'circles';
    if (kind === 'event') return 'event_visibility';
    return 'discover';
  }

  private resourceClause(kind: NotificationResourceKind) {
    switch (kind) {
      case 'letter':
        return {
          subject: 'r.owner_id',
          mode: "'friends'",
          joins: '',
          where: "r.state IN ('published','archived')",
        };
      case 'conversation':
        return {
          subject: 'CASE WHEN r.account_a=$2::uuid THEN r.account_b ELSE r.account_a END',
          mode: 'r.mode',
          joins: '',
          where: "r.state='active' AND (r.account_a=$2::uuid OR r.account_b=$2::uuid)",
        };
      case 'connection':
        return {
          subject: 'CASE WHEN r.account_a=$2::uuid THEN r.account_b ELSE r.account_a END',
          mode: 'r.mode',
          joins: '',
          where: "r.state='accepted' AND (r.account_a=$2::uuid OR r.account_b=$2::uuid)",
        };
      case 'safety_action':
        return {
          subject: 'sr.subject_account_id',
          mode: "'friends'",
          joins:
            'JOIN safety.cases c ON c.id=r.case_id JOIN safety.reports sr ON sr.id=c.report_id',
          where: "r.state IN ('approved','executed') AND sr.subject_account_id=$2::uuid",
        };
      default:
        return { subject: 'NULL::uuid', mode: 'NULL::text', joins: '', where: 'false' };
    }
  }
}
