import type { Pool } from 'pg';
import type { PgLetterRepository } from '@wai/db';
import type { TranslationTask } from '@wai/contracts';
import type { TranslationAuthorizationPort } from './pipeline.js';

type AuthorizationSource =
  | Awaited<ReturnType<PgLetterRepository['readPublishedRevision']>>
  | Awaited<ReturnType<PgLetterRepository['readOwnedRevision']>>;

/**
 * Production authorization adapter. PostgreSQL remains the source of truth:
 * LTR supplies the current immutable source, while IAM/VER/ELG/SAF gates are
 * re-read for every worker attempt. A database/provider failure is explicitly
 * unavailable so the pipeline retries durably; a policy denial cancels only
 * that task and never produces a derived result.
 */
export class PgTranslationAuthorization implements TranslationAuthorizationPort {
  constructor(
    private readonly pool: Pool,
    private readonly letters: PgLetterRepository,
  ) {}

  async authorize(task: TranslationTask) {
    try {
      const source: AuthorizationSource =
        task.key.source_kind === 'public_letter'
          ? await this.letters.readPublishedRevision(task.key.letter_id)
          : await this.letters.readOwnedRevision(
              task.ownerId,
              task.key.letter_id,
              task.key.source_revision,
            );
      if (
        source === null ||
        !sameSource(task, source) ||
        source.currentRevision !== source.revision ||
        (source.kind === 'public_letter' && source.state !== 'published')
      )
        return { allowed: false, source, reason: 'denied' as const };
      const accountIds =
        source.kind === 'public_letter' && source.ownerId !== task.ownerId
          ? [task.ownerId, source.ownerId]
          : [task.ownerId];
      const current = await this.pool.query<{
        id: string;
        age_band: string;
        cohort_key: string;
        assurance_level: string;
        derived_at: Date;
        policy_id: string;
        policy_revision: number;
        policy_hash: string;
      }>(
        `SELECT a.id,c.age_band,c.cohort_key,c.assurance_level,c.derived_at,
                c.jurisdiction_policy_id AS policy_id,c.policy_revision,
                p.content_hash AS policy_hash
           FROM iam.accounts a
           JOIN eligibility.age_credentials c
             ON c.account_id=a.id AND c.superseded_at IS NULL
            AND c.valid_from <= now() AND c.valid_until > now()
            AND c.assurance_level='externally_attested'
            AND c.issuer_type='verification_module'
           JOIN eligibility.age_evidence e
             ON e.id=c.source_evidence_id AND e.account_id=c.account_id
            AND e.superseded_at IS NULL
           JOIN eligibility.jurisdiction_policies p
             ON p.id=c.jurisdiction_policy_id AND p.revision=c.policy_revision
            AND p.status='approved' AND p.retired_at IS NULL
            AND p.effective_from <= now() AND p.effective_until > now()
          WHERE a.id = ANY($1::uuid[]) AND a.state='enabled'
            AND EXISTS (
              SELECT 1 FROM verification.identity_cases i
               WHERE i.account_id=a.id AND i.state='verified'
                 AND i.age_assurance_state='attested'
            )
            AND EXISTS (
              SELECT 1 FROM verification.membership_cases m
               WHERE m.account_id=a.id AND m.state='approved'
            )`,
        [accountIds],
      );
      if (current.rows.length !== accountIds.length)
        return { allowed: false, source, reason: 'denied' as const };
      const safety = await this.pool.query(
        `SELECT 1 FROM safety.blocks WHERE state='active'
          AND ((blocker_account_id=$1 AND blocked_account_id=$2)
            OR (blocker_account_id=$2 AND blocked_account_id=$1)) LIMIT 1`,
        [task.ownerId, source.ownerId],
      );
      if ((safety.rowCount ?? 0) !== 0)
        return { allowed: false, source, reason: 'denied' as const };
      // A self/public translation and a private owner translation do not need
      // a fabricated actor=subject partition. Cross-account public reads do.
      if (source.kind === 'public_letter' && source.ownerId !== task.ownerId) {
        const actor = current.rows.find((row) => row.id === task.ownerId);
        const subject = current.rows.find((row) => row.id === source.ownerId);
        if (actor === undefined || subject === undefined)
          return { allowed: false, source, reason: 'denied' as const };
        const partition = await this.pool.query(
          `SELECT decision FROM eligibility.partition_decisions
            WHERE actor_account_id=$1 AND subject_account_id=$2
              AND capability='discover'
              AND actor_age_band=$3 AND actor_cohort_key=$4
              AND subject_age_band=$5 AND subject_cohort_key=$6
              AND actor_policy_id=$7 AND actor_policy_revision=$8 AND actor_policy_hash=$9
              AND subject_policy_id=$10 AND subject_policy_revision=$11 AND subject_policy_hash=$12
              AND evaluated_at >= GREATEST($13::timestamptz,$14::timestamptz)
              AND evaluated_at >= now() - interval '15 minutes'
              AND evaluated_at <= now()
            ORDER BY evaluated_at DESC, created_at DESC LIMIT 1`,
          [
            task.ownerId,
            source.ownerId,
            actor.age_band,
            actor.cohort_key,
            subject.age_band,
            subject.cohort_key,
            actor.policy_id,
            actor.policy_revision,
            actor.policy_hash,
            subject.policy_id,
            subject.policy_revision,
            subject.policy_hash,
            actor.derived_at,
            subject.derived_at,
          ],
        );
        if (partition.rows[0]?.decision !== 'allow')
          return { allowed: false, source, reason: 'denied' as const };
      }
      if (source.kind === 'private_letter') {
        const consent = await this.pool.query(
          `SELECT 1 FROM translation.consents
            WHERE id=$1 AND owner_id=$2 AND letter_id=$3 AND source_revision_id=$4
              AND source_hash=$5 AND provider_id=$6 AND provider_version=$7
              AND processing_region=$8 AND retention_policy=$9 AND retention_seconds=$10
              AND revoked_at IS NULL AND expires_at > now()`,
          [
            task.consentBinding?.id ?? null,
            task.ownerId,
            task.key.letter_id,
            task.key.source_revision_id,
            task.key.source_hash,
            task.key.provider_id,
            task.consentBinding?.providerVersion ?? null,
            task.consentBinding?.processingRegion ?? null,
            task.consentBinding?.retentionPolicy ?? null,
            task.consentBinding?.retentionSeconds ?? null,
          ],
        );
        if ((consent.rowCount ?? 0) === 0)
          return { allowed: false, source, reason: 'denied' as const };
      }
      return { allowed: true, source };
    } catch {
      return { allowed: false, source: null, reason: 'unavailable' as const };
    }
  }
}

/** Explicit test/degraded-mode adapter. Production wiring uses the DB-backed
 * adapter above; this remains useful when a deployment intentionally has no
 * authorization dependencies and must retry rather than disclose source. */
export class FailClosedTranslationAuthorization implements TranslationAuthorizationPort {
  async authorize(): Promise<{ allowed: false; source: null; reason: 'unavailable' }> {
    return { allowed: false, source: null, reason: 'unavailable' };
  }
}

function sameSource(
  task: TranslationTask,
  source: {
    letterId: string;
    kind: string;
    revisionId: string;
    revision: number;
    sourceHash: string;
  },
) {
  return (
    task.key.letter_id === source.letterId &&
    task.key.source_kind === source.kind &&
    task.key.source_revision_id === source.revisionId &&
    task.key.source_revision === source.revision &&
    task.key.source_hash === source.sourceHash
  );
}
